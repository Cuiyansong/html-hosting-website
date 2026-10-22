/**
 * 静态网站管理平台（极简版）
 *
 * 使用方式：
 *   1. 打开管理页 http://服务器IP:8091，输入密码
 *   2. 把 html 文件或 zip 压缩包拖进页面
 *   3. 得到形如 http://服务器IP:18088 的链接，发给别人即可访问
 *
 * 设计原则：使用者不需要接触端口、目录、命令行等任何技术概念。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Busboy from 'busboy';
import yauzl from 'yauzl';

// ---------------------------------------------------------------- 运行环境检查

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const MIN_NODE_MAJOR = 22;

if (NODE_MAJOR < MIN_NODE_MAJOR) {
  console.error('');
  console.error(`  ✗ 需要 Node.js ${MIN_NODE_MAJOR} 或更高版本，当前是 v${process.versions.node}`);
  console.error(`    请升级 Node.js：https://nodejs.org/`);
  console.error('');
  process.exit(1);
}

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.join(ROOT, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'data.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const PASS_FILE = path.join(DATA_DIR, 'password.txt');

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8091);
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 8090);
const POOL_START = Number(process.env.PORT_POOL_START || 18088);
const POOL_END = Number(process.env.PORT_POOL_END || 18188);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;
const KEEP_VERSIONS = 3;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const SESSION_DAYS = 7;

const PORT_MIN = Number(process.env.PORT_MIN || 10000);
const PORT_MAX = Number(process.env.PORT_MAX || 65535);
const RESERVED_PORTS = new Set([ADMIN_PORT, PORTAL_PORT]);

for (const d of [DATA_DIR, SITES_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- 密码与会话

function loadSecret() {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8');
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

function loadPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (fs.existsSync(PASS_FILE)) return fs.readFileSync(PASS_FILE, 'utf8').trim();
  // 首次启动自动生成
  const pwd = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(PASS_FILE, pwd, { mode: 0o600 });
  return pwd;
}
const PASSWORD = loadPassword();
const IS_GENERATED = !process.env.ADMIN_PASSWORD;

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${sign(String(exp))}`;
}

function verifySession(token) {
  if (!token) return false;
  const [expStr, mac] = token.split('.');
  if (!expStr || !mac) return false;
  const expected = sign(expStr);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(expStr) > Date.now();
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return verifySession(parseCookies(req).hp_session);
}

function checkPassword(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- 持久化

let db = { sites: [], categories: [] };

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.sites ||= [];
      db.categories ||= [];
    } catch {
      db = { sites: [], categories: [] };
    }
  }
}

function saveDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------- 工具
// ---------------------------------------------------------------- 站点图标（emoji）

/**
 * 图标池：只用单码点/常规 emoji，不用组合序列（避免不同平台渲染差异导致"看起来重复"）
 * 池内去重；分配时跳过已被占用的图标，保证全局不重复。
 */
const EMOJI_POOL = [...new Set([
  '🚀','🛰️','🛸','🪐','🌍','🌕','☄️','🔭','🧭','🗺️',
  '💻','🖥️','⌨️','🖱️','💾','💿','📀','📱','📟','🖨️',
  '📺','📷','📹','🎥','🎬','🎞️','🔋','🔌','💡','🔦',
  '🧠','🧬','🧪','🧫','🔬','⚗️','🩺','💉','🩹','🧰',
  '🔧','🔨','⚙️','🛠️','⛏️','🔩','🧲','⛓️','🗜️','🪛',
  '📊','📈','📉','🗂️','🗃️','🗄️','📁','📂','📋','📌',
  '📍','📎','🔗','🧷','📐','📏','🧮','✏️','🖊️','🖋️',
  '📝','📄','📃','📑','📚','📖','📕','📗','📘','📙',
  '📔','📒','📓','🔖','🗒️','🗓️','📆','📅','🕒','⏱️',
  '🧭','🎯','🎲','🧩','🪄','🎨','🖌️','🖍️','🖼️','🪞',
  '🌐','🔍','🔎','🔐','🔒','🔓','🗝️','🔑','🛡️','⚔️',
  '🏗️','🏛️','🏙️','🌆','🌃','🌉','🗼','🏰','⛩️','🗿',
  '📦','🏷️','🎁','🎈','🎀','🎉','🎊','🏮','🧧','🪅',
  '🌱','🌿','☘️','🍀','🌵','🎄','🌲','🌳','🌴','🪴',
  '🍃','🍂','🍁','🍄','🌾','💐','🌷','🌹','🌺','🌸',
  '🌼','🌻','🌞','🌙','⭐','🌟','✨','⚡','🔥','🌈',
  '☀️','⛅','☁️','🌧️','⛈️','❄️','☃️','💧','🌊','🫧',
  '🐙','🦑','🦀','🐡','🐠','🐟','🐬','🐳','🦈','🐢',
  '🦊','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐧',
  '🦉','🦅','🦋','🐝','🐌','🐞','🦄','🐴','🐑','🦌',
  '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑',
  '🥝','🍅','🥑','🥦','🌽','🥕','🍞','🧀','🍳','🥞',
  '🍔','🍟','🍕','🌮','🍜','🍣','🍱','🍙','🍰','🍪',
  '☕','🍵','🧋','🥤','🍺','🍷','🍹','🧊','🍯','🧂',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💎','🪙',
  '😀','😎','🤖','👾','🕹️','🎮','🎧','🎵','🎼','🔔',
  '✅','🔰','♻️','⚠️','🈯','💠','🌀','💤','🏁','🚩',
])];

/** 随机挑一个没被占用的图标；池子用尽（站点数 > 图标数）时才退化为重复 */
function pickEmoji() {
  const used = new Set(db.sites.map((s) => s.emoji).filter(Boolean));
  const free = EMOJI_POOL.filter((e) => !used.has(e));
  const list = free.length ? free : EMOJI_POOL;
  return list[crypto.randomInt(list.length)];
}

/** 老数据补齐图标（不重复）；已全部有图标时是一次 O(n) 的短路检查 */
function ensureEmojis() {
  if (db.sites.every((s) => s.emoji)) return;
  for (const s of db.sites) if (!s.emoji) s.emoji = pickEmoji();
  saveDB();
}


const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

const BLOCKED_EXT = new Set(['.php', '.jsp', '.asp', '.aspx', '.cgi', '.pl', '.py', '.sh', '.exe', '.bat']);

function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

const runtime = new Map();
const siteById = (id) => db.sites.find((s) => s.id === id);

// ---------------------------------------------------------------- 分类

const CAT_NAME_MAX = 20;
const CAT_MAX = 50;
const CAT_COLORS = 6;

const catById = (id) => (id ? db.categories.find((c) => c.id === id) || null : null);
const sortedCats = () => [...db.categories].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

/** 分类下的站点计数：count = 门户可见数（与门户 chip 一致），allCount = 含隐藏 */
function categoryStats(catId) {
  const mine = db.sites.filter((s) => (s.categoryId || null) === (catId || null));
  return {
    count: mine.filter((s) => s.status === 'active' && s.current && !s.hidden).length,
    allCount: mine.length,
  };
}

function categoryView(c) {
  return { id: c.id, name: c.name, order: c.order, color: c.color, ...categoryStats(c.id) };
}

/** 分类名的唯一校验入口：新建与改名共用 */
function validateCategoryName(raw, excludeId = null) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: '请填写分类名称' };
  if (name.length > CAT_NAME_MAX) return { error: `分类名称最多 ${CAT_NAME_MAX} 个字符` };
  const dup = db.categories.some((c) => c.id !== excludeId && c.name.toLowerCase() === name.toLowerCase());
  if (dup) return { error: `已存在同名分类「${name}」` };
  return { name };
}

function hostOf(req) {
  if (PUBLIC_HOST) return PUBLIC_HOST;
  const h = req.headers.host || 'localhost';
  return h.split(':')[0];
}

function view(site, req) {
  const cat = catById(site.categoryId);
  return {
    id: site.id,
    name: site.name,
    emoji: site.emoji || null,
    port: site.port,
    url: `http://${hostOf(req)}:${site.port}/`,
    status: site.status,
    published: Boolean(site.current),
    hidden: Boolean(site.hidden),
    categoryId: cat ? cat.id : null,
    category: cat ? { id: cat.id, name: cat.name, color: cat.color } : null,
    warnings: site.warnings || [],
    updatedAt: site.updatedAt || null,
  };
}

// ---------------------------------------------------------------- 静态服务

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let [, s, e] = m;
  if (s === '' && e === '') return null;
  let start, end;
  if (s === '') {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Number(e);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

function sendFile(req, res, file, st) {
  const ext = path.extname(file).toLowerCase();
  if (BLOCKED_EXT.has(ext)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 forbidden');
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'public, max-age=60',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
  if (range?.invalid) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function makeStaticHandler(siteId) {
  return (req, res) => {
    const site = siteById(siteId);
    if (!site || site.status !== 'active' || !site.current) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>网站尚未发布</h1>');
    }
    const root = path.join(SITES_DIR, site.id, site.current);
    let rel;
    try {
      rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(root, '.' + path.posix.normalize(rel));
    if (full !== root && !full.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 forbidden');
    }
    fs.stat(full, (err, st) => {
      if (!err && st.isFile()) return sendFile(req, res, full, st);

      // 静态资源（有扩展名且非 html）缺失时直接 404，避免误回退成 HTML
      const ext = path.extname(full).toLowerCase();
      if (ext && ext !== '.html' && ext !== '.htm') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 not found');
      }

      // 页面导航回退 index.html（单页应用友好）
      const idx = path.join(root, 'index.html');
      fs.stat(idx, (e2, st2) => {
        if (e2 || !st2.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<h1>404 页面不存在</h1>');
        }
        sendFile(req, res, idx, st2);
      });
    });
  };
}

// ---------------------------------------------------------------- 站点生命周期

async function startListener(site) {
  if (runtime.has(site.id)) return;
  if (!(await probePort(site.port))) throw new Error(`端口 ${site.port} 被占用`);
  const server = http.createServer(makeStaticHandler(site.id));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(site.port, '0.0.0.0', resolve);
  });
  runtime.set(site.id, server);
}

function stopListener(siteId) {
  const server = runtime.get(siteId);
  if (!server) return;
  server.close();
  runtime.delete(siteId);
}

async function restoreAll() {
  for (const site of db.sites) {
    if (site.status !== 'active') continue;
    try {
      await startListener(site);
      console.log(`  ✓ ${site.name} → :${site.port}`);
    } catch (e) {
      site.status = 'degraded';
      console.error(`  ✗ ${site.name} :${site.port} 恢复失败 (${e.message})`);
    }
  }
  saveDB();
}

// ---------------------------------------------------------------- 上传处理

function unzipTo(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name) || name.startsWith('__MACOSX/') || isNoise(path.posix.basename(name))) return zip.readEntry();
        const dest = path.resolve(outDir, name);
        if (dest !== path.resolve(outDir) && !dest.startsWith(path.resolve(outDir) + path.sep)) {
          return fail(new Error(`非法路径：${name}`));
        }
        if (BLOCKED_EXT.has(path.extname(name).toLowerCase())) {
          return fail(new Error(`不支持的文件类型：${name}`));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e) return fail(e);
          const ws = fs.createWriteStream(dest);
          rs.pipe(ws);
          ws.on('close', () => zip.readEntry());
          ws.on('error', fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** 噪点文件/目录（macOS、Windows 自动生成，不参与入口判定） */
function isNoise(name) {
  return (
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name === '__MACOSX' ||
    name.startsWith('._')
  );
}

/** 处理 zip 里套文件夹的情况（www / html / dist / 任意嵌套） */
function findRoot(dir, depth = 0) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !isNoise(e.name));

  // 当前目录已经有 html 入口文件，就用它
  if (entries.some((e) => e.isFile() && /\.html?$/i.test(e.name))) return dir;

  // 否则：若只有一个子目录，继续往下找
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && depth < 6) {
    return findRoot(path.join(dir, dirs[0].name), depth + 1);
  }
  return dir;
}

/** 常见入口文件名优先级 */
const ENTRY_NAMES = ['index.html', 'index.htm', 'main.html', 'default.html', 'home.html', 'demo.html'];

/** 接收 multipart 上传，落盘到临时文件 */
function receiveUpload(req) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(TMP_DIR, `${crypto.randomUUID()}.upload`);
    let filename = '';
    let size = 0;
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    // defParamCharset: 'utf8' —— 浏览器上传的中文文件名是原始 UTF-8 字节，
    // busboy 默认按 latin1 解码，会导致中文文件名乱码（进而污染默认站点名）
    const bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: MAX_UPLOAD, files: 1 } });
    bb.on('file', (_field, file, info) => {
      filename = info.filename || '';
      const ws = fs.createWriteStream(tmpFile);
      file.on('data', (c) => (size += c.length));
      file.on('limit', () => done(reject, new Error(`文件超过 ${MAX_UPLOAD / 1024 / 1024}MB 上限`)));
      file.pipe(ws);
      ws.on('close', () => done(resolve, { tmpFile, filename, size }));
      ws.on('error', (e) => done(reject, e));
    });
    bb.on('error', (e) => done(reject, e));
    bb.on('close', () => {
      if (!filename) done(reject, new Error('没有收到文件'));
    });
    req.pipe(bb);
  });
}

/** 在目录里挑出入口 html 文件 */
function findEntryHtml(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !isNoise(e.name))
    .map((e) => e.name);

  const htmls = files.filter((f) => /\.html?$/i.test(f));
  if (!htmls.length) return null;

  const lower = (s) => s.toLowerCase();
  for (const name of ENTRY_NAMES) {
    const hit = htmls.find((f) => lower(f) === name);
    if (hit) return hit;
  }
  if (htmls.length === 1) return htmls[0];

  // 多个 html：优先体积最大的（通常才是主页面）
  return htmls.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a)).size;
    const sb = fs.statSync(path.join(dir, b)).size;
    return sb - sa;
  })[0];
}

/** 确保根目录有 index.html，否则把找到的入口文件复制为 index.html */
function ensureIndexHtml(dir) {
  const hasIndex = fs
    .readdirSync(dir, { withFileTypes: true })
    .some((e) => e.isFile() && /^index\.html?$/i.test(e.name));
  if (hasIndex) return { entry: 'index.html', created: false };

  const entry = findEntryHtml(dir);
  if (!entry) return { entry: null, created: false };

  fs.copyFileSync(path.join(dir, entry), path.join(dir, 'index.html'));
  return { entry, created: true };
}
/**
 * 发布后体检：检测常见的“包不对”情况，返回提醒（只提示，不阻止发布）
 */
function auditSite(dir) {
  const warnings = [];
  const indexPath = path.join(dir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    if (!fs.readdirSync(dir).some((f) => /\.html?$/i.test(f))) {
      warnings.push('压缩包里没有找到任何 .html 文件');
    }
    return warnings;
  }

  let html = '';
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return warnings;
  }

  // 1. 未构建的模板语法
  if (/<%[\s\S]{0,120}%>/.test(html)) {
    warnings.push('页面里残留模板语法 <% %>，说明上传的是项目源码而不是构建产物；请在本地执行构建（如 npm run build）后上传构建目录');
  }
  if (/%PUBLIC_URL%/.test(html)) {
    warnings.push('页面里残留 %PUBLIC_URL% 占位符，同样是未经构建的源码文件');
  }

  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);

  // 2. 越界引用（../）
  const escaping = refs.filter((r) => r.startsWith('../') || r.startsWith('..\\'));
  if (escaping.length) {
    warnings.push(`页面引用了站点目录之外的文件（${escaping.slice(0, 3).join(', ')}），这些资源将无法访问`);
  }

  // 3. 本地资源缺失
  const missing = [];
  for (const raw of refs) {
    const r = String(raw).split('#')[0].split('?')[0].trim();
    if (!r || /^(https?:)?\/\//i.test(r) || /^(data|mailto|tel|javascript|blob):/i.test(r)) continue;
    if (r.startsWith('#') || r.startsWith('../')) continue;
    const rel = r.startsWith('/') ? r.slice(1) : r;
    if (!fs.existsSync(path.join(dir, rel))) missing.push(r);
  }
  if (missing.length) {
    warnings.push(`${missing.length} 个页面引用的文件不存在（如 ${missing.slice(0, 3).join(', ')}），页面可能显示不完整`);
  }

  // 4. 只有空容器但没有本地脚本
  const hasLocalScript = refs.some((r) => /\.js(\?|#|$)/i.test(r) && !/^(https?:)?\/\//i.test(r));
  if (!hasLocalScript && /<div\s+id=["'](root|app)["']/i.test(html)) {
    warnings.push('页面只有空容器，且未加载任何本地脚本，可能只上传了模板文件而没有上传打包后的 js');
  }

  return warnings;
}

async function publish(site, upload) {
  const version = `${Date.now()}`;
  const outDir = path.join(SITES_DIR, site.id, version);
  const isZip = /\.zip$/i.test(upload.filename);

  try {
    if (isZip) {
      const staging = path.join(TMP_DIR, `stage-${crypto.randomUUID()}`);
      fs.mkdirSync(staging, { recursive: true });
      await unzipTo(upload.tmpFile, staging);
      const root = findRoot(staging);
      fs.mkdirSync(path.dirname(outDir), { recursive: true });
      fs.renameSync(root, outDir);
      fs.rmSync(staging, { recursive: true, force: true });
    } else if (/\.html?$/i.test(upload.filename)) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(upload.tmpFile, path.join(outDir, 'index.html'));
    } else {
      throw new Error('只支持 .zip 压缩包或 .html 文件');
    }
  } finally {
    fs.rmSync(upload.tmpFile, { force: true });
  }

  // 适配“解压后只有一个文件夹”或“入口文件不叫 index.html”的情况
  const { entry } = ensureIndexHtml(outDir);
  const warnings = auditSite(outDir);

  site.versions = site.versions || [];
  site.versions.push(version);
  site.current = version;
  site.status = 'active';
  site.updatedAt = new Date().toISOString();
  site.warnings = warnings;
  while (site.versions.length > KEEP_VERSIONS) {
    const old = site.versions.shift();
    fs.rmSync(path.join(SITES_DIR, site.id, old), { recursive: true, force: true });
  }
  return { version, entry, warnings };
}

function nameFromFilename(filename) {
  const base = path.basename(filename).replace(/\.(zip|html?)$/i, '');
  return base.trim() || '未命名网站';
}

async function allocatePort() {
  const start = Math.max(POOL_START, PORT_MIN);
  for (let p = start; p <= Math.min(POOL_END, PORT_MAX); p++) {
    if (RESERVED_PORTS.has(p)) continue;
    if (db.sites.some((s) => s.port === p)) continue;
    if (await probePort(p)) return p;
  }
  return null;
}

/**
 * 端口校验（唯一入口，创建与修改都必须走这里）
 * @returns {{port?: number, error?: string}}
 */
async function validatePort(raw, excludeSiteId = null) {
  if (raw === undefined || raw === null || raw === '') return { error: '请填写端口' };
  const port = Number(raw);
  if (!Number.isInteger(port)) return { error: '端口必须是整数' };
  if (port < PORT_MIN) return { error: `端口不能小于 ${PORT_MIN}` };
  if (port > PORT_MAX) return { error: `端口不能大于 ${PORT_MAX}` };
  if (RESERVED_PORTS.has(port)) return { error: `端口 ${port} 是系统保留端口` };
  if (db.sites.some((s) => s.port === port && s.id !== excludeSiteId)) {
    return { error: `端口 ${port} 已被其他网站占用` };
  }
  if (!(await probePort(port))) return { error: `端口 ${port} 已被其他程序占用` };
  return { port };
}

// ---------------------------------------------------------------- HTTP 工具

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJSON(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1e6) throw new Error('请求体过大');
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

// ---------------------------------------------------------------- 管理端

const ADMIN_HTML = path.join(ROOT, 'public', 'index.html');
const LLMS_FILE = path.join(ROOT, 'public', 'llms.txt');

/** 渲染给 LLM 阅读的接口说明（公开，无需登录） */
function llmsText(req) {
  const raw = fs.readFileSync(LLMS_FILE, 'utf8');
  const vars = {
    '{{HOST}}': hostOf(req),
    '{{ADMIN_PORT}}': ADMIN_PORT,
    '{{PORTAL_PORT}}': PORTAL_PORT,
    '{{PORT_MIN}}': PORT_MIN,
    '{{PORT_MAX}}': PORT_MAX,
    '{{POOL_START}}': POOL_START,
    '{{POOL_END}}': POOL_END,
    '{{MAX_UPLOAD_MB}}': Math.round(MAX_UPLOAD / 1024 / 1024),
  };
  return Object.entries(vars).reduce(
    (text, [key, val]) => text.split(key).join(String(val)),
    raw,
  );
}

const adminServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // 页面
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(ADMIN_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    // LLM 说明文档（公开，方便模型先读懂能力边界再决定调用）
    if (req.method === 'GET' && p === '/llms.txt') {
      let body;
      try {
        body = Buffer.from(llmsText(req), 'utf8');
      } catch {
        return json(res, 500, { error: '说明文档缺失：public/llms.txt' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }

    // 登录 / 登出 / 会话
    if (p === '/api/login' && req.method === 'POST') {
      const { password } = await readJSON(req);
      if (!checkPassword(password)) return json(res, 401, { error: '密码不正确' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `hp_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'hp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      });
      return res.end('{"ok":true}');
    }
    if (p === '/api/session' && req.method === 'GET') {
      return json(res, 200, {
        authed: isAuthed(req),
        portalUrl: `http://${hostOf(req)}:${PORTAL_PORT}/`,
        portMin: PORT_MIN,
        portMax: PORT_MAX,
      });
    }

    // 以下接口需要登录
    if (!isAuthed(req)) return json(res, 401, { error: '请先登录' });

    // 列表
    if (p === '/api/sites' && req.method === 'GET') {
      ensureEmojis();
      return json(res, 200, { sites: db.sites.map((s) => view(s, req)) });
    }

    // 新建空网站（可指定端口，留空则自动分配）
    if (p === '/api/sites' && req.method === 'POST') {
      const body = await readJSON(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return json(res, 400, { error: '请填写网站名称' });

      let port;
      const wantPort = body.port;
      if (wantPort === undefined || wantPort === null || wantPort === '') {
        port = await allocatePort();
        if (!port) return json(res, 507, { error: '可用端口已用完' });
      } else {
        const r = await validatePort(wantPort);
        if (r.error) return json(res, 400, { error: r.error });
        port = r.port;
      }

      const site = {
        id: crypto.randomUUID().slice(0, 8),
        name,
        emoji: pickEmoji(),
        port,
        categoryId: catById(String(body.categoryId || '')) ? String(body.categoryId) : null,
        status: 'active',
        versions: [],
        current: null,
        createdAt: new Date().toISOString(),
      };
      db.sites.push(site);
      fs.mkdirSync(path.join(SITES_DIR, site.id), { recursive: true });
      try {
        await startListener(site);
      } catch (e) {
        db.sites = db.sites.filter((s) => s.id !== site.id);
        fs.rmSync(path.join(SITES_DIR, site.id), { recursive: true, force: true });
        saveDB();
        return json(res, 400, { error: e.message });
      }
      saveDB();
      return json(res, 201, view(site, req));
    }

    // 一步发布：上传即建站
    if (p === '/api/publish' && req.method === 'POST') {
      const upload = await receiveUpload(req);
      const port = await allocatePort();
      if (!port) {
        fs.rmSync(upload.tmpFile, { force: true });
        return json(res, 507, { error: '可用端口已用完' });
      }
      const site = {
        id: crypto.randomUUID().slice(0, 8),
        name: nameFromFilename(upload.filename),
        emoji: pickEmoji(),
        port,
        status: 'active',
        versions: [],
        current: null,
        createdAt: new Date().toISOString(),
      };
      db.sites.push(site);
      fs.mkdirSync(path.join(SITES_DIR, site.id), { recursive: true });
      let result;
      try {
        result = await publish(site, upload);
        await startListener(site);
      } catch (e) {
        db.sites = db.sites.filter((s) => s.id !== site.id);
        fs.rmSync(path.join(SITES_DIR, site.id), { recursive: true, force: true });
        saveDB();
        return json(res, 400, { error: e.message });
      }
      saveDB();
      return json(res, 201, { ...view(site, req), entry: result?.entry || null, warnings: result?.warnings || [] });
    }

    // 批量设置分类（必须在 idMatch 之前：正则会把 batch-category 当成站点 id）
    if (p === '/api/sites/batch-category' && req.method === 'POST') {
      const body = await readJSON(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length) return json(res, 400, { error: '请选择要归类的站点' });
      const target = body.categoryId === null || body.categoryId === undefined || body.categoryId === ''
        ? null
        : String(body.categoryId);
      if (target !== null && !catById(target)) return json(res, 400, { error: '分类不存在' });

      let moved = 0;
      for (const id of ids) {
        const site = siteById(id);
        if (!site) continue;
        site.categoryId = target;
        moved++;
      }
      if (moved) saveDB();
      return json(res, 200, { ok: true, moved, categoryId: target });
    }

    const idMatch = p.match(/^\/api\/sites\/([\w-]+)$/);
    const deployMatch = p.match(/^\/api\/sites\/([\w-]+)\/deploy$/);

    // 更新（重新上传）
    if (deployMatch && req.method === 'POST') {
      const site = siteById(deployMatch[1]);
      if (!site) return json(res, 404, { error: '网站不存在' });
      const upload = await receiveUpload(req);
      let result;
      try {
        result = await publish(site, upload);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      saveDB();
      return json(res, 200, { ...view(site, req), entry: result?.entry || null, warnings: result?.warnings || [] });
    }

    // 改名 / 改端口 / 门户可见性
    if (idMatch && req.method === 'PATCH') {
      const site = siteById(idMatch[1]);
      if (!site) return json(res, 404, { error: '网站不存在' });
      const body = await readJSON(req);

      if (typeof body.name === 'string' && body.name.trim()) site.name = body.name.trim().slice(0, 60);
      if (typeof body.hidden === 'boolean') site.hidden = body.hidden;

      // 改分类：null / 空字符串 = 未分类
      if (body.categoryId !== undefined) {
        if (body.categoryId === null || body.categoryId === '') {
          site.categoryId = null;
        } else if (catById(String(body.categoryId))) {
          site.categoryId = String(body.categoryId);
        } else {
          return json(res, 400, { error: '分类不存在' });
        }
      }

      // 改端口：先校验，再换监听，失败则回滚
      if (body.port !== undefined && body.port !== null && body.port !== '') {
        const r = await validatePort(body.port, site.id);
        if (r.error) return json(res, 400, { error: r.error });
        if (r.port !== site.port) {
          const oldPort = site.port;
          stopListener(site.id);
          site.port = r.port;
          try {
            await startListener(site);
          } catch (e) {
            site.port = oldPort;
            await startListener(site).catch(() => {});
            return json(res, 400, { error: `切换到端口 ${r.port} 失败：${e.message}` });
          }
        }
      }

      saveDB();
      return json(res, 200, view(site, req));
    }

    // 删除
    if (idMatch && req.method === 'DELETE') {
      const site = siteById(idMatch[1]);
      if (!site) return json(res, 404, { error: '网站不存在' });
      stopListener(site.id);
      db.sites = db.sites.filter((s) => s.id !== site.id);
      fs.rmSync(path.join(SITES_DIR, site.id), { recursive: true, force: true });
      saveDB();
      return json(res, 200, { ok: true });
    }

    // ---------------- 分类 ----------------

    if (p === '/api/categories' && req.method === 'GET') {
      return json(res, 200, {
        categories: sortedCats().map(categoryView),
        uncategorized: categoryStats(null),
        limit: { nameMax: CAT_NAME_MAX, count: CAT_MAX },
      });
    }

    if (p === '/api/categories' && req.method === 'POST') {
      const body = await readJSON(req);
      const r = validateCategoryName(body.name);
      if (r.error) return json(res, 400, { error: r.error });
      if (db.categories.length >= CAT_MAX) return json(res, 400, { error: `分类数量已达上限（${CAT_MAX}）` });

      const maxOrder = db.categories.reduce((m, c) => Math.max(m, c.order), 0);
      const cat = {
        id: crypto.randomUUID().slice(0, 8),
        name: r.name,
        order: maxOrder + 10,
        color: db.categories.length % CAT_COLORS,
      };
      db.categories.push(cat);
      saveDB();
      return json(res, 201, categoryView(cat));
    }

    // 排序：一次提交完整 id 顺序（避免多次 PATCH 产生中间态）
    if (p === '/api/categories/order' && req.method === 'PUT') {
      const body = await readJSON(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      let i = 0;
      for (const id of ids) {
        const cat = catById(id);
        if (!cat) continue;
        i++;
        cat.order = i * 10;
      }
      saveDB();
      return json(res, 200, { ok: true });
    }

    const catMatch = p.match(/^\/api\/categories\/([\w-]+)$/);

    if (catMatch && req.method === 'PATCH') {
      const cat = catById(catMatch[1]);
      if (!cat) return json(res, 404, { error: '分类不存在' });
      const body = await readJSON(req);

      if (body.name !== undefined) {
        const r = validateCategoryName(body.name, cat.id);
        if (r.error) return json(res, 400, { error: r.error });
        cat.name = r.name;
      }
      if (Number.isFinite(Number(body.order))) cat.order = Number(body.order);

      saveDB();
      return json(res, 200, categoryView(cat));
    }

    // 删除分类：站点不删，全部回落为未分类
    if (catMatch && req.method === 'DELETE') {
      const cat = catById(catMatch[1]);
      if (!cat) return json(res, 404, { error: '分类不存在' });
      const moved = db.sites.filter((s) => s.categoryId === cat.id);
      for (const s of moved) s.categoryId = null;
      db.categories = db.categories.filter((c) => c.id !== cat.id);
      saveDB();
      return json(res, 200, { ok: true, moved: moved.length, name: cat.name });
    }

    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('[error]', e.message);
    json(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- 门户页（公开，无需登录）

const PORTAL_HTML = path.join(ROOT, 'public', 'portal.html');

const portalServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(PORTAL_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    } catch {
      res.writeHead(500).end('门户页缺失');
      return;
    }
  }

  // 公开列表：只返回已发布且未隐藏的站点（附带分类字典，供门户分组）
  if (req.method === 'GET' && url.pathname === '/api/sites') {
    ensureEmojis();
    const cats = sortedCats();
    const sites = db.sites
      .filter((s) => s.status === 'active' && s.current && !s.hidden)
      .map((s) => {
        const cat = catById(s.categoryId);
        return {
          id: s.id,
          name: s.name,
          emoji: s.emoji || null,
          url: `http://${hostOf(req)}:${s.port}/`,
          updatedAt: s.updatedAt || null,
          categoryId: cat ? cat.id : null,
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return json(res, 200, {
      categories: cats.map((c) => ({ id: c.id, name: c.name, color: c.color, order: c.order })),
      sites,
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 not found');
});

// ---------------------------------------------------------------- 启动

loadDB();
console.log('');
console.log('  静态网站管理平台');
console.log('  ─────────────────────────────');
console.log(`  运行环境   Node v${process.versions.node}`);
console.log(`  管理页面   http://localhost:${ADMIN_PORT}`);
console.log(`  门户首页   http://localhost:${PORTAL_PORT}`);
console.log(`  端口范围   ${POOL_START} - ${POOL_END}`);
if (IS_GENERATED) {
  console.log(`  登录密码   ${PASSWORD}`);
  console.log(`             （已保存到 ${PASS_FILE}，可用 ADMIN_PASSWORD 环境变量覆盖）`);
}
console.log('');

await restoreAll();

adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
  console.log(`  已就绪，浏览器打开 http://localhost:${ADMIN_PORT}`);
  if (db.sites.length) console.log(`  已恢复 ${db.sites.length} 个网站`);
  console.log('');
});

portalServer.listen(PORTAL_PORT, '0.0.0.0', () => {
  console.log(`  门户页已启动 http://localhost:${PORTAL_PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const id of [...runtime.keys()]) stopListener(id);
    portalServer.close();
    adminServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}
