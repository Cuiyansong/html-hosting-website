# 自动拉取 GitHub 仓库并自动部署 · 方案设计

> 目标：站点不再靠人手拖 zip，而是绑定一个 GitHub 仓库，仓库有新提交就自动更新到对应端口。
> 本文只做决策与设计，不含实现。所有结论基于当前代码实测（`server.mjs` 910 行、`data/` 为唯一状态源）。

---

## 1. 现有可复用的接缝（好消息：地基已经在了）

| 现有能力 | 位置 | 为什么对自动部署关键 |
|---|---|---|
| `publish(site, { filename, tmpFile })` | `server.mjs:521` | **唯一发布入口**，只认「一个临时 zip / html 文件」。GitHub zipball 就是标准 zip，落盘后可以直接喂进来 |
| `unzipTo()` + zip-slip 防护 | `server.mjs:322` | 已经有路径穿越拦截、噪音文件过滤、可执行文件拦截 |
| `findRoot()` 递归下探 ≤6 层 | `server.mjs:374` | zipball 顶层固定是 `owner-repo-sha/` 一个目录，现有逻辑**自动**剥掉这层；`dist/`、`build/` 单目录也自动处理 |
| `ensureIndexHtml()` + `auditSite()` | `server.mjs:450 / 465` | 入口文件兜底 + 「传了源码没传产物」体检，自动部署时正好用来判断「这次要不要真的切过去」 |
| `current` 热切换 | `server.mjs:242` | 静态处理器每次请求都读 `site.current`，切版本**不用重启监听**，天然原子 |
| `versions[]` + `KEEP_VERSIONS=3` | `server.mjs:534` | 已经保留了历史版本 → 回滚只差一个 API |

**结论：核心链路 `下载 zip → publish()` 几乎零改动。真正要设计的是「谁触发、多久查一次、要不要在服务器上构建」。**

---

## 2. 三个正交决策（先把空间拆开，方案才不会混着谈）

### 2.1 触发：服务端怎么知道「有新提交」

| 方式 | 延迟 | 需要公网入站 | 需要装/配 | 备注 |
|---|---|---|---|---|
| **A. GitHub Webhook**（push 事件） | 秒级 | **是**（公网 IP / 反代 / 内网穿透） | 每个仓库配 1 个 webhook + secret | 最实时；NAT/内网下要额外穿透 |
| **B. 定时轮询**（比对 commit sha） | = 轮询间隔 | 否 | 一个 token（可选） | 出站即可，穿 NAT；要控配额 |
| **C. CI 推送**（Actions → POST 产物） | 秒级 | **是** | 每个仓库加 workflow | 服务器只收产物，最安全 |
| **D. 手动**（管理页按钮 / API） | 人工 | 否 | — | 必须保留的兜底，也是 A/B/C 的排障手段 |

### 2.2 构建在哪跑（安全上最重要的一维）

| 位置 | 谁执行 `npm run build` | 风险 |
|---|---|---|
| **CI（GitHub Actions）** | GitHub 的机器 | ✅ 服务器零风险，仓库多烂都不影响你 |
| **本地/人工** | 人 | ✅ 现状。仓库里必须提交 `dist/` |
| **服务器** | 你的机器 | ❌ **等于把任意代码执行权授予任何能改仓库的人**。`npm ci` 会跑 postinstall、build 会跑任意脚本。装 Docker/沙箱之前不建议 |

> 关键判断：**「自动部署」≠「服务器自动构建」。** 绝大多数静态站（含本项目的 `public/`）根本不需要构建，先做「自动拉取已构建产物」就能覆盖 80% 场景。

### 2.3 取文件的方式

| 取法 | 依赖 | 私有仓库 | 复用现有代码 | 说明 |
|---|---|---|---|---|
| **GitHub zipball**（`api.github.com/repos/:o/:r/zipball/:ref`） | 只需内置 `fetch` | ✅ token | ✅ 直接进 `unzipTo` | **首选**：零新依赖、零新工具链 |
| **GitHub tarball** | 需要 tar 解压（Node 无内置） | ✅ | ❌ 要新写 | 不如 zipball |
| **`git clone --depth 1`** | 服务器装 git（已有 2.55） | ✅ token / SSH deploy key | ❌ 新写 | 能拿 `.git` 信息，但 token 容易漏进进程列表 |
| **CI 上传 zip** | 无 | ✅（token 在本侧） | ✅ 复用 `receiveUpload` | 产物由 CI 决定，最可控 |

---

## 3. 四个完整方案

### 方案 A：CI 产物推送（GitHub Actions → 本服务）

```
push → GitHub Actions: npm ci && npm run build → zip dist
     → POST https://<host>:8091/api/deploy/<token>（multipart，无 Cookie）
     → receiveUpload() → publish() → 热切换
```
- 服务端新增：`POST /api/deploy/:token`（token → siteId 映射，豁免会话校验）、`data/secrets.json` 存 token（0600）。
- 仓库侧新增（可给模板一键复制）：
  ```yaml
  - run: npm ci && npm run build
  - run: cd dist && zip -qr ../site.zip .
  - run: curl -fsS -X POST "${{ secrets.DEPLOY_URL }}" -F "file=@site.zip"
  ```
- ✅ 服务器不跑构建、不装工具链；私有仓库天然支持；构建产物与运行环境解耦；秒级。
- ❌ 每个仓库要改（加 workflow + 配 secret）；仍需公网可达（或内网穿透）。
- 工作量：**~120 行**（端点 + token 模型 + 模板文件）。
- 风险：**最低**。

### 方案 B：服务端定时轮询 zipball（推荐作为第一步自动化）

```
setInterval 每 N 秒（默认 300s）:
  GET /repos/:o/:r/commits/:branch  (If-None-Match: <etag>)
    304 → 什么都不做（不计配额）
    200 → sha 变了 → GET zipball → data/tmp/git-<id>.zip
        → publish(site, {filename:'repo.zip', tmpFile}) → 热切换 → 记录 sha/时间/结果
```
- ✅ 无需公网入站、无需改仓库、**完全复用** `unzipTo/findRoot/auditSite/publish`；失败自动保留旧版本。
- ❌ 延迟 = 间隔；仓库必须包含构建产物（或本身就是静态站 root）；消耗 API 配额（见 §6）。
- 工作量：**~180 行**（poller + `source` 模型 + 手动「立即拉取」共用一个 `pullSite()`）。
- 风险：低（只下载、不执行任何东西）。

### 方案 C：Webhook 实时 + 轮询兜底

- 在 B 之上加 `POST /api/hooks/github/:siteId`：校验 `X-Hub-Signature-256`（HMAC-SHA256，每站点独立 secret）、校验 `X-GitHub-Event=push`、`ref` 与 `repository.full_name` 匹配，**立刻 202 返回**再异步部署（GitHub 只等 10s）；用 `X-GitHub-Delivery` 做重放去重。
- 同时保留 10 分钟一次的轮询做对账（webhook 丢包、服务器重启期间漏事件都能补上）。
- ✅ 秒级且最终一致；❌ 要公网可达 + 每仓库配 webhook + secret 管理；多一套安全面。
- 工作量：B 的 ~180 行 + **~100 行**（原始 body 读取 + 签名校验 + 去重）。
- 风险：低-中（签名校验写错 = 任意人可触发部署，必须写测试）。

### 方案 D：服务器 git clone + 可选构建

```
git clone --depth 1 --branch X → tmp
→ 可选：npm ci && npm run build（子进程 + 超时 + 内存上限 + 低权限用户）
→ 产物目录 → publish()
```
- ✅ 仓库可以只放源码，能力最完整（monorepo 也能挑子目录）；❌ **等于远程代码执行**，还得在服务器装 Node/包管理器、给构建磁盘与 CPU、构建失败排查困难。
- 工作量：**~300 行**（含进程管理、超时、日志流、清理）。
- 风险：**高**。仅建议放进容器（或 `systemd-run --scope -p MemoryMax=1G` / macOS `sandbox-exec`）后再考虑。

### 横向对比

| | A CI 推送 | B 轮询 zipball | C Webhook+轮询 | D 服务器 clone/build |
|---|---|---|---|---|
| 延迟 | 秒级 | 秒~5 分钟 | 秒级 | 秒~分钟（构建慢） |
| 需公网入站 | 是 | **否** | 是 | 否 |
| 需改仓库 | 是（workflow） | 否 | 是（webhook） | 否 |
| 服务器执行不可信代码 | 否 | 否 | 否 | **是** |
| 支持需构建的项目 | ✅ | ❌（除非提交 dist） | ❌ 同 B | ✅ |
| 复用现有代码 | 高 | **最高** | 高 | 中 |
| 工作量 | ~120 行 | ~180 行 | ~280 行 | ~300 行 |
| 风险 | 最低 | 低 | 低-中 | **高** |

---

## 4. 推荐路线：按阶段，先把地基和回滚做掉

| 阶段 | 内容 | 触发方式 | 产出 | 估时 |
|---|---|---|---|---|
| **P0 地基** | `source` 数据模型 + `pullSite()` + 管理页「绑定仓库 / 立即拉取 / 回滚上一版」+ 部署日志 | 手动 | 自动化的全部依赖，且立刻比拖 zip 好用 | 半天 |
| **P1 自动化** | 定时轮询（方案 B），默认关闭、按站点开启、变更才下载、失败退避 | 轮询 | 不用改仓库就自动更新 | 半天 |
| **P2 构建型项目** | CI 推送端点（方案 A）+ workflow 模板 | CI | 需要 `npm run build` 的项目也能自动部署 | 半天 |
| **P3 实时** | Webhook（方案 C），带 HMAC 与重放去重 | Webhook | 秒级 | 半天 |
| **不做** | 方案 D 的服务器构建 | — | 除非放进容器 | — |

**理由**：P0 的回滚与日志是所有自动化的前提（自动部署出错时必须一键退回，否则等于自己给自己埋雷）；P1 用最小侵入拿到「真·自动」；P2 覆盖构建型项目且不牺牲安全性；P3 是延迟优化，收益递减。

---

## 5. 数据模型与接口

### 5.1 `site.source`（追加字段，老数据无需迁移）

```jsonc
"source": {
  "type": "github",              // github | ci
  "repo": "Cuiyansong/html-hosting",  // owner/name，必填
  "ref": "main",                 // 分支或 tag
  "path": "dist",                // 产物子目录；空 = 仓库根
  "trigger": "poll",             // manual | poll | webhook | ci
  "pollSeconds": 300,            // 最小 60
  "strict": true,                // 体检有警告就不切版本（默认 true）
  "enabled": true,
  "lastSha": "abc1234",
  "lastCheckedAt": "2026-10-22T01:00:00Z",
  "lastDeploy": { "ok": true, "version": "1761...", "warnings": [], "at": "..." },
  "failures": 0                  // 退避用，成功后清零
}
```
- **token 不进 `data.json`**：单独 `data/secrets.json`（`chmod 600`，已在 `.gitignore` 的 `data/` 内），`source` 只存 `tokenRef`。

### 5.2 新增/变更接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `PATCH` | `/api/sites/:id` | 扩展：接受 `source` 字段（绑定/解绑仓库、改 ref/path/trigger） |
| `POST` | `/api/sites/:id/pull` | 立即拉取并部署（P0，返回 sha + 警告 + 版本） |
| `POST` | `/api/sites/:id/rollback` | 回滚到 `versions[-2]`（P0，自动部署的安全网） |
| `GET` | `/api/sites/:id/deploys` | 部署历史（sha、时间、结果、警告） |
| `POST` | `/api/hooks/github/:id` | Webhook（P3，公开但强制签名校验） |
| `POST` | `/api/deploy/:token` | CI 产物上传（P2，token 豁免 Cookie 会话） |

### 5.3 新增环境变量

```
GIT_ALLOWED_OWNERS=Cuiyansong      # 只允许这些 owner，防 SSRF/乱拉
GITHUB_TOKEN=                      # 可选，提高配额 + 私有仓库
POLL_MIN_SECONDS=60                # 轮询下限，防滥用
DEPLOY_CONCURRENCY=2               # 全局并发
```

---

## 6. 安全与踩坑清单（含本项目实测发现）

1. **`BLOCKED_EXT` 会让仓库部署直接失败**（实测风险）：`unzipTo()` 遇到 `.sh/.py/.bat` 会 **`fail()` 整个包**（`server.mjs:344`）。真实仓库里常有 `deploy.sh`、`scripts/build.py`。自动部署必须改为**跳过**这些文件而不是整包失败（新增 `{ skipBlocked: true }` 选项，仅 `type=github` 时启用）。
2. **zipball 顶层有 `owner-repo-sha/` 目录**：`findRoot()` 能自动剥掉（已验证逻辑），但若同时指定 `source.path`，需要先剥顶层再进子目录，顺序不能反。
3. **代码里不应有 `.git`、`.env`、`node_modules`**：zipball 不含 `.git` 与 `node_modules`，但会含 `.env`（如果提交过）→ 建议加一份忽略清单（`.env*`、`*.pem`、`.github/`、`package-lock.json`）并在部署日志里提示跳过了什么。
4. **API 配额**：未认证 REST 60 次/小时/IP、带 token 5000 次/小时。轮询默认 **300s + `If-None-Match`**（304 不计配额），1 个站点约 12 次/小时，安全。兜底：`git ls-remote` 不占 REST 配额。
5. **SSRF**：只接受 `https://github.com/<owner>/<repo>` 形式，owner 走白名单；拒绝任意 URL、`file://`、内网地址；下载加 `AbortSignal.timeout(30_000)` 与体积上限（复用 `MAX_UPLOAD`）。
6. **zip bomb**：`unzipTo` 目前无「解压后总大小/文件数」上限。自动部署是无人值守的，必须补：文件数 ≤ 5000、解压总量 ≤ 500MB，超限中止。
7. **并发与竞态**：同一站点两次部署重叠会互相覆盖 `current`（`publish` 用 `Date.now()` 做版本号，同毫秒还会撞名）。必须加**每站点互斥锁** + 版本号改 `Date.now()-随机后缀`。
8. **失败要「不切换」**：现在 `auditSite()` 只出警告、照样发布（`publish` 无条件切 `current`）。自动部署应加 `strict`：出现「未构建源码/空容器」类警告时**保留旧版本**并记失败。
9. **回滚必须有**：否则自动部署把站点搞挂时只能人工重新上传。`versions[]` 数据已在，补 API 即可。
10. **Webhook 细节**：HMAC 必须对**原始 body** 校验（现有 `readJSON` 会先解析，需要单独读 buffer）；校验 `ref` 与分支、`repository.full_name` 与绑定仓库；`X-GitHub-Delivery` 去重防重放；先 202 再异步部署。
11. **管理页不动监听**：切版本靠 `site.current`（已验证 `makeStaticHandler` 每请求读取），所以自动部署不会造成端口闪断。
12. **失败可见**：连续失败 3 次把 `site.status` 标 `degraded` 并在门户/管理页显示红点，否则「自动」会静默烂掉。

---

## 7. 文件改动清单

| 文件 | 改动 | 回滚方式 |
|---|---|---|
| `server.mjs` | `site.source` 模型；`fetchZipball()`；`pullSite()`；poller；`POST /pull`、`/rollback`、`/deploys`、（P2）`/api/deploy/:token`、（P3）`/api/hooks/github/:id`；`unzipTo` 加 `skipBlocked` 与解压上限；`publish` 加 `opts.strict` 与版本号后缀 | `git revert`；`data/` 不受影响，老版本目录仍在 `versions[]` 里 |
| `public/index.html` | 站点卡片显示 `repo@sha`、上次部署结果、绑定仓库表单、「立即拉取」「回滚」按钮 | 同上 |
| `public/llms.txt` | 补齐新接口（保持「文档即真相」约定） | 同上 |
| `README.md` | 新增「自动部署」章节与 CI 模板 | 同上 |
| `.github/workflows/deploy.example.yml`（P2） | 给用户复制到目标仓库的模板 | 纯新增 |
| `docs/auto-deploy.md` | 本文 | 纯新增 |

体量预估：P0+P1 ≈ `server.mjs` +300 行、UI +80 行。项目现在 910 行，仍在单文件可维护范围内；若 P2/P3 也做完（~1200 行），建议届时把「部署相关」抽成 `lib/deploy.mjs`。

---

## 8. 验收标准（P0/P1）

- [ ] 绑定 `Cuiyansong/html-hosting` 的 `main` 分支 → 点「立即拉取」→ 端口内容更新，`lastSha` 与 GitHub 一致
- [ ] 仓库新提交后，≤ 2× `pollSeconds` 内自动更新，`/api/sites/:id/deploys` 出现新记录
- [ ] 故意推一个只有 `<div id="root">` 没 js 的提交 → `strict` 生效：站点仍是旧版本，记录失败并给出可读原因
- [ ] 部署中途杀掉进程 → 重启后站点仍是旧版本，`data.json` 未损坏
- [ ] 含 `deploy.sh` 的仓库能正常部署（跳过而不是整包失败）
- [ ] 点「回滚」→ 回到上一版本，端口不闪断
- [ ] 换一个不在白名单的 owner → 直接拒绝并提示
