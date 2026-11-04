多模态知识库 前端部署说明（第三方服务器）

【包内容】
index.html + assets/  ：已构建好的前端静态文件（可直接部署）
nginx.conf.example    ：Nginx 配置参考（根目录 + 非根目录两种）

【部署步骤（Nginx，根目录方式）】
1. 将本文件夹全部内容拷贝到服务器，例如 /var/www/kb/
2. Nginx 站点配置：
   server {
       listen 80;
       server_name your.host.name;
       root /var/www/kb;
       index index.html;
       location / {
           try_files $uri $uri/ /index.html;
       }
       gzip on;
       gzip_types text/css application/javascript application/json image/svg+xml;
   }
3. nginx -t 校验后 reload，浏览器访问 http://服务器IP/ 即可
4. 其他静态服务器（IIS/Tomcat/Apache）同理：指向本目录，并把所有 404 回退到 index.html

【注意事项】
1. try_files 回退规则必须配置，否则刷新 /templates 等路由会 404
2. 本包按“根目录部署”构建；如需部署在子路径（如 /kb/），需提供子路径由研发重新构建
3. 纯前端静态应用，无需 Node/数据库；对接后端时由 Nginx 反向代理 /api 即可
