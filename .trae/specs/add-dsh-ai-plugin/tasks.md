# Tasks

- [x] Task 1: 探测 DSH 接口协议（阻断项：需用户提供 DSH web 带 token 地址）
  - [x] 1.1 用户提供 `dsh web` 输出的带 token URL（Windows 侧）
  - [x] 1.2 curl 枚举 3080 的 /api/* 端点（带认证 cookie/token），确定认证方式与消息收发端点、响应格式
  - [x] 1.3 产出协议结论（headless CLI：`dsh --profile headless "<任务>"`，--json NDJSON 取会话号，--session-id 续会话）
- [x] Task 2: 后端 DSH 适配层（依赖 Task 1 结论）
  - [x] 2.1 assistant.mjs DSH 配置（DSH_CMD/DSH_CWD/DSH_TIMEOUT_MS，.env.example 更新；服务地址 dshUrl 走面板设置）
  - [x] 2.2 callDSH：spawn CLI（stdin 传消息，--json 解析回复与会话号，120s 超时，killChildTree 兜底）
  - [x] 2.3 /api/dsh/chat|queue|pending|session|settings|log|health|context|like 路由（独立队列与会话空间，chat 后登记 dshActiveSession）
- [x] Task 3: 前端第二插件 plugin-dsh（可与 Task 2 并行，接口约定按 2.3 先行）
  - [x] 3.1 复制 plugin-ai → plugin-dsh，改面板标题「DSH AI」、apiBase 指向 /api/dsh、轮询走 dsh 端点
  - [x] 3.2 机器人图标（SVG 内联，DS 插件 pluginsData icons 规范），独立 GUID（标准十六进制 UUID）
  - [x] 3.3 index.html 版本号与 no-store 规则沿用现有机制
- [x] Task 4: DS 插件注册与端到端验证（依赖 Task 2 + 3）
  - [x] 4.1 第二插件注册进 DS 容器（pluginsData 挂 config.json；**不进 autostart**——autostart 是串行队列，DSH 会卡在常驻的 plugin-ai 后面永远轮不到，改为「插件」页签手动点击打开）
  - [x] 4.2 e2e 验证：工具栏真实点击打开面板 → queue 注入 → 文档写入 PASS + 截图（/tmp/pwtest/dsh-e2e.js）；DSH CLI 不可达 → 面板明确显示错误不挂死（真机 CLI 传输层故障时验证了该路径）
  - [x] 4.3 回归验证：plugin-ai 队列写入 PASS（/tmp/pwtest/ai-regress.js，零回归）
  - [x] 4.4 真机 DSH chat 全链路（PASS：headless 网关 patch 对齐 plugin-ai（id123/deepseek-v4-flash）后，面板直聊 → DSH 回复 → 自动写入文档）
- [x] Task 5: 文档更新（依赖 Task 4）
  - [x] 5.1 README 功能表加 DSH AI 一行
  - [x] 5.2 API.md 内部接口表加 /api/dsh/* 行
- [ ] Task 6: 多人文档 + 登录立项建议（仅输出结论，不实施）
  - [ ] 6.1 在会话总结中给出：多人文档（key 稳定化 + user 真实化）单独立 spec；登录先轻量本地账号，OAuth 后置

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 可与 Task 2 并行
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 4
