# 企业微信登录授权插件 实施计划

## Context

当前编辑器用户身份写死为 `user={id:"1",name:"访客"}`，多人协同无法区分身份。需求：加一个企业微信 OAuth 登录插件，**登录是可选增强而非门禁**——不登录仍以访客身份编辑；登录后取 userid + 真实姓名注入 `editorConfig.user`，使协同可区分身份。授权方式两者都支持（后端按 UA 自动分流：企微内静默授权 / 普通浏览器扫码登录）。未配置企微凭据时功能整体关闭，向后兼容。项目原则：单进程单端口、零外部依赖（内存 session，不用 passport/redis）、UI 极简。

## 涉及文件

| 文件 | 操作 |
|---|---|
| `frontend/server/plugins/wecom-auth.mjs` | **新建**，核心后端插件 |
| `frontend/server/assistant.mjs` | 静态注册（import + L58-63 插件数组各加一行） |
| `frontend/src/App.vue` | initAuth 流程 + user 注入（L130-133）+ 右下角登录 chip |
| `frontend/server/.env.example` | 追加 WECOM 配置块 |

## 1. 后端插件 wecom-auth.mjs

配置：`WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET` 三项齐全才启用；`WECOM_MOCK=1` 为本地/无凭据验证开关（authorize 直接 302 弹回假 code，login 接受任意 name 造用户）。

模块级状态（零依赖）：
- `pendingStates: Map<state, ts>` —— 一次性 CSRF state，10 分钟 TTL，校验即删
- `sessions: Map<sid, {userid, name, ts}>` —— 滑动过期（/me 续期 + 惰性清理），TTL 默认 7 天
- `tok = {v, exp}` —— access_token 缓存，提前 300s 过期 + single-flight 并发合并；40014/42001 时强制刷新重试一次

帮手：`parseCookies(req)`、`getOrigin(req)`（WECOM_PUBLIC_ORIGIN 优先，回退请求 Host）、`isWxwork(req)`（UA 含 `wxwork`）、`qyapiGet(path, params)`（fetch + 10s 超时 + errcode 检查）。

路由（经 `ctx.get/ctx.post`，复用 ctx.cors / ctx.readBody）：

| 路由 | 行为 |
|---|---|
| `GET /api/auth/wecom/config` | 返回 `{enabled, corpId, agentId, mock}`，前端据此决定是否显示登录入口 |
| `GET /api/auth/wecom/authorize` | **302 跳转**（非 JSON）。redirect_uri = 站点 origin + 透传原始 query（剔除 code/state/wecom_login），并追加 `wecom_login=1&state=<随机12字节hex>`。UA 含 wxwork → `open.weixin.qq.com/connect/oauth2/authorize`（snsapi_base，`#wechat_redirect` 结尾）；否则 → `login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp`。mock 模式直接 302 弹回带假 code |
| `POST /api/auth/wecom/login` | body `{code,state}` → state 一次性校验（过期/无效 401）→ `GET /cgi-bin/auth/getuserinfo` 换 userid（兼容旧字段 `UserId`；返回 openid 非企业成员则 401 拒绝）→ `GET /cgi-bin/user/get` 拉姓名（失败不阻断，兜底用 userid）→ 建 session → `Set-Cookie: oo_sid=<24字节hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>` → `{ok, userid, name}` |
| `GET /api/auth/me` | 读 cookie，命中则 `{authed:true, userid, name}` 并续期，否则 `{authed:false}` |
| `POST /api/auth/logout` | 删 session + 清 cookie |

## 2. assistant.mjs 静态注册

内置核心模块必须静态 import（bun exe 打不进动态 import；env.mjs 已是首个 import，插件顶层读 `process.env.WECOM_*` 安全）：
- import 区加 `import * as modWecomAuth from './plugins/wecom-auth.mjs'`
- L58-63 静态插件数组加 `['./plugins/wecom-auth.mjs', modWecomAuth, 'wecom-auth.mjs'],`

## 3. App.vue 改动

- 新增 `authEnabled` / `authUser` 两个 ref
- `initAuth(params)`：① 拉 config，未启用直接 return（零 UI 向后兼容）；② 若 URL 带 `wecom_login=1&code&state` → POST login，成功设 authUser，随后 `history.replaceState` 清掉 code/state/wecom_login（保留 f=/url= 文档参数）；③ 否则拉 `/api/auth/me` 恢复登录态。整体 try/catch，任何异常降级访客，绝不阻断文档加载
- onMounted（L242-287）改 async，在 f=/url= 分支前 `await initAuth(params)`（本地毫秒级调用）
- `loadDocument` L130-133 身份注入：`user: { id: authUser.value?.userid || '1', name: authUser.value?.name || '访客' }`
- 登录 chip（`v-if="authEnabled"`，fixed 右下角 right:10px bottom:10px z-index:9999，半透明白底圆角 12px）：未登录显示「企微登录」，点击 → `window.location.href = '/api/auth/wecom/authorize' + location.search`（必须整页导航，不能 fetch）；已登录显示姓名，点击 → POST logout + reload
- **样式坑**：App.vue 全局 `* { margin:0 !important; padding:0 !important }` 会清零 chip 内边距，须用 `#auth-chip` ID 选择器 + `!important` 覆盖

## 4. .env.example 追加

```bash
# === 企业微信登录（可选功能；三项全部留空则整体关闭，不显示登录入口）===
# 获取方式：企业微信管理后台 work.weixin.qq.com
#   企业ID：我的企业 → 企业信息 → 企业ID
#   AgentId / Secret：应用管理 → 自建应用
# 应用详情里还需配置两项，缺一会登录失败：
#   ① 网页授权及JS-SDK 可信域名：填本服务对外访问域名（redirect_uri 须完全匹配，否则 50001）
#   ② 企业可信IP：填本服务出口 IP（服务端调 qyapi 必需，否则 60020）
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
# 本服务对外地址（一般留空自动取请求 Host；https 反代场景才需显式指定）
#WECOM_PUBLIC_ORIGIN=
# 会话有效期秒数（默认 7 天）
#WECOM_SESSION_TTL=604800
# 本地/无凭据验证：设 1 启用模拟登录（不访问企微 API），仅供开发与 e2e，生产严禁开启
#WECOM_MOCK=0
```

## 5. 关键企业微信 API 核对结论

- 扫码：`wwlogin/sso/login?login_type=CorpApp&appid=&agentid=&redirect_uri=&state=`；企微内：`connect/oauth2/authorize?appid=<corpid>&redirect_uri=&response_type=code&scope=snsapi_base&agentid=&state=#wechat_redirect`
- code 换身份（现行接口）：`GET /cgi-bin/auth/getuserinfo?access_token=&code=`；拉姓名：`GET /cgi-bin/user/get?access_token=&userid=` → `name`
- token：`GET /cgi-bin/gettoken?corpid=&corpsecret=`，7200s
- 高频错误码：60020=可信 IP 缺失；50001=redirect_uri 域名不匹配；40029=code 复用/过期
- localhost 无法配可信域名 → 真实链路必须域名访问；mock 模式即为此设计的本地验证路径

## 验证

1. **关闭态回归**：无 WECOM 配置启动 → config 返回 enabled:false → 页面无 chip → 文档照常打开（向后兼容）
2. **mock 全链路**（`WECOM_MOCK=1`，重启 dev——改 .env 不触发 Vite 自动重启）：chip 出现 → 点击 → URL 回跳后无 code/state 残留 → /me 返回 authed → chip 显示姓名 → reload 后仍保持 → 点击登出恢复
3. **Playwright e2e**（沿用 /tmp/pwtest + BASE 环境变量约定）：state 复用二次 login 应 401；两个 browser context 用不同 name 登录同一文档，确认协同身份不同
4. 真实凭据验证按错误码 checklist（60020/50001/40029）排查

## 边界（明确不做）

- 不给任何 /api/* 加门禁，API.md「接口无鉴权」承诺不变
- session 不持久化（重启后重新登录）；未来需要再落 data/ 目录 JSON
- `?url=` 授权回跳后重复 import 一次属既有行为小冗余，不处理
