# ONLYOFFICE 插件目录化 + 动态发现（cordis 式）

## Context
用户希望 plugin-ai / plugin-dsh 等 ONLYOFFICE 插件像 cordis 插件一样：独立目录、发布时放入 `~/.onlyoffice/plugins/` 即被编辑器发现，删掉即消失。

调研结论：ONLYOFFICE 服务器版**没有**用户目录扫描机制（那是桌面版专属）。但本项目插件本来就不走 DS 目录——编辑器启动时通过 `editorConfig.plugins.pluginsData`（config.json URL 数组，[App.vue](file:///home/deren/works/my/onlyoffice-demo/frontend/src/App.vue#L131-L143) 硬编码）注入。**把硬编码列表改为「服务端扫描目录动态生成」即可实现目录即插件**，无需依赖 ONLYOFFICE 原生机制。

注：Docker 形态（build.sh --linux）容器内只有 nginx、无 node 后端，`/api/editor-plugins` 不可用 → App.vue 内置 fallback 列表兜底，插件可用但 Docker 形态不支持动态发现（文档注明）。

## 约定
- 插件源码目录：`frontend/plugins/<name>/`（repo 维护，替代 `frontend/public/plugin-ai|dsh`；目录名保持原名不改）
- 运行时插件目录：env `OO_PLUGINS_DIR` 优先；否则 dev（vite）默认 `frontend/plugins/`（改文件即生效），prod（prod.mjs）默认 `~/.onlyoffice/plugins/`
- autostart：config.json 顶层自定义字段 `"isAutostart": true`（约定至多一个插件设 true，多个会互相排队卡住）
- 发布 = `pnpm plugins:install`（拷贝 frontend/plugins/* → ~/.onlyoffice/plugins/）

## 实现

### 新建
1. **`frontend/server/plugins/editor-plugins.mjs`**（assistant 体系路由模块，dev/prod 自动生效）
   - `pluginsDir()`：`OO_PLUGINS_DIR` env 优先；以 `ASSISTANT_DATA_DIR` 是否已设判定 prod（prod.mjs 在 import assistant 前注入，顺序不能动）→ prod 默认 `~/.onlyoffice/plugins/`（os.homedir()），dev 默认 `frontend/plugins/`
   - `GET /api/editor-plugins`：每次请求现扫目录（readdirSync），逐个读 `<name>/config.json`（解析失败 warn 跳过），提取 `guid`/`name`/`isAutostart`，返回 `{plugins:[{name,guid,baseUrl:'/plugins/<name>',autostart}]}`；目录不存在返回空列表。零缓存 = 增删即生效
   - `GET /plugins/` 静态服务（prefix）：decodeURIComponent + normalize/startsWith 防穿越（仿 prod.mjs L67）；目录请求补 index.html；内置 MIME 表（json/html/js/css/png/svg/ico）；所有响应 `Cache-Control: no-store`（收敛到此一处）
2. **`frontend/scripts/plugins-install.mjs`**：fs.cpSync 拷贝，`package.json` 加 `"plugins:install"`

### 修改
3. **`frontend/server/assistant.mjs`**：gate（L63 附近）放行 `/plugins/` 前缀
4. **`frontend/server/prod.mjs`**：删 `/plugin-ai/` no-store 特判（dist 不再含插件）
5. **`frontend/vite.config.js`**：删 /plugin-ai|/plugin-dsh 的 no-store 中间件（统一由路由模块设置）；/sdkjs-plugins 代理与 cors 不动
6. **`frontend/src/App.vue`**：加 `loadEditorPlugins()`（fetch /api/editor-plugins，失败回落内置 DEFAULT_PLUGINS 两项指向 /plugins/plugin-ai|plugin-dsh）；L131-143 改为动态生成 pluginsData 与 autostart（列表为空时不挂 plugins 键）
7. **迁移**：`git mv frontend/public/plugin-ai frontend/plugins/plugin-ai`、同理 plugin-dsh；`plugin-ai/config.json` 顶层加 `"isAutostart": true`
8. **`Dockerfile`**：`COPY frontend/plugins /usr/share/nginx/html/plugins`；nginx conf 加 `location /plugins/ { add_header Cache-Control "no-store"; try_files $uri =404; }`（App.vue 走 fallback 列表）

## 验证
1. dev：`pnpm dev` → 打开编辑器 → Network 看 `/api/editor-plugins` 返回两项、`/plugins/plugin-ai/config.json` 带 no-store、两个面板正常；`cp -r` 测试插件进 `frontend/plugins/` → 刷新出现、删除后消失
2. prod：`vite build` → `pnpm plugins:install` → `node server/prod.mjs` → 验证扫描 `~/.onlyoffice/plugins/`、插件加载正常、增删生效
3. 回归：plugin-ai 的 apiBase 探测（8090）与 plugin-dsh 同源 apiBase 不受路径迁移影响；DSH 面板对话/写入正常

## 已识别的坑
- assistant 中间件先于 Vite 静态服务，/plugins/ 进 gate 即生效，无顺序问题
- `frontend/plugins/`（编辑器插件）与 `frontend/server/plugins/`（后端路由模块）并存，注释写清区分
- App.vue 两条进入路径（/api/doc 与 /api/import）都要在 config 组装前完成插件列表获取；文档切换是整页跳转，无 DocsAPI 重建问题
