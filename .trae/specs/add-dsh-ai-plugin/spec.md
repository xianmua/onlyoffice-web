# DSH AI 第二插件 + 鉴权/多人文档调研 Spec

## Why
现有 AI 助手只接一种 LLM 后端；用户希望增加第二个 AI 入口——DSH AI（本地 harness 型多功能助手，127.0.0.1:3080，可配置），用机器人图标以独立插件形态并存。同时为后续「鉴权 + 多人在线文档」功能先做一轮可行性调研，输出选型结论，不在本次实施。

## What Changes

### Part 1：DSH AI 插件（本次实施）
- 新增独立插件 `frontend/public/plugin-dsh/`（机器人图标、面板标题「DSH AI」），与现有 AI 助手（plugin-ai）并存互不干扰
- 后端新增 DSH 适配层：`DSH_URL` 环境变量（默认 `http://127.0.0.1:3080`，可配置），新增 `/api/dsh/*` 路由组，与现有 `/api/chat`、队列轮询并行
- 第一步协议探测已完成（2026-10-21 实测定案）：
  - DSH web（3080）无 REST 消息端点，唯一通道是 `/api/remote.mux` WebSocket RPC（typert 私有协议）→ 逆向否决
  - 旧 dsh-bridge 文件桥的三种 HTTP 格式（/v1/chat/completions、/api/v1/chat、/jsonrpc）实测全 404，属旧架构遗留
  - **定案方案：`dsh --profile headless "<任务>"` CLI**（实测「链路通了」成功）——单发即走、回复走 stdout、`--session-id <id>` 续会话、`--json` 机器可读。WSL 侧经 `cmd.exe /c` interop 调用，Windows 原生部署直接 spawn
  - DSH 回复为纯文本 → 不走 actions 协议，按纯文本段落写入文档末尾（pushEnd）
- 后端新增 DSH 适配层：`/api/dsh/*` 路由组（chat/queue/pending/session/settings/log），与现有 /api/chat、队列轮询并行；调用超时 120 秒（agent 型比纯 LLM 慢）

### Part 2：鉴权 + 多人文档（仅调研，结论如下，后续单独立 spec）
- **多人文档技术路径**（低风险，DS 原生支持）：Document Server 同一 `document.key` 即同一实时协作房间（光标/选区同步、头部头像），社区版上限 20 并发。当前 key 是 `doc_${Date.now()}` 每次打开独立 → 改为按文档 id 稳定生成 + 保存后带版本变化；`editorConfig.user` 从写死「访客」改为真实登录用户；复用已有 `docKeyMap` 机制
- **登录方式门槛调研结论**（2026-10 现场核实）：

| 渠道 | 个人开发者 | 硬性要求 |
|---|---|---|
| 钉钉扫码 | ✅ 可（「第三方个人应用」） | 公网可访问回调地址（localhost 不行）；企业通讯录需企业认证 |
| 企业微信扫码 | ❌ 不可 | 企业认证主体 + 可信域名（域名主体须与企业一致）+ 可信公网出口 IP；仅企业内部成员可登录 |
| 微信扫码 | ❌ 基本不可 | 开放平台「网站应用」需企业主体 + 300 元一次性认证 + ICP 备案域名（备案主体一致）+ HTTPS |
| QQ 互联 | ⚠️ 可申请但收紧 | 网站 ICP 备案；个人审核近年趋严，需进一步实测 |

- **选型建议**：四家 OAuth 共同硬门槛是「公网回调 + ICP 备案域名」，与本项目内网/单机部署形态冲突。分两步走：① 先做轻量本地账号（用户名/昵称进入 + 本地会话，支撑多人文档的用户身份与 key 生成），零外部依赖；② 部署形态升级为公网域名后，按用户群体接钉钉（个人可做）或企业微信（企业场景）——**不建议一开始就接 OAuth 插件**
- 登录不是「DS 插件」：登录层在 Web 前端 + 后端会话（middleware 加鉴权中间件），OnlyOffice 侧只需把用户信息传进 editorConfig

## Impact
- Affected specs: 无历史 spec（首个）
- Affected code:
  - 新增 `frontend/public/plugin-dsh/`（index.html/plugin.js/config 等，基于 plugin-ai 复制改造）
  - 修改 `frontend/server/assistant.mjs`（DSH_URL 常量、/api/dsh 路由、callDSH 函数）
  - 修改 `frontend/server/.env.example`（DSH_URL）
  - 修改 `frontend/public/index.html` 或 DS 插件注册处（第二插件 autostart + pluginsData）
  - 文档：README 功能表、API.md 内部接口表
- 不改：现有 plugin-ai 行为、现有 /api/chat 语义（保持兼容）

## ADDED Requirements

### Requirement: DSH AI 独立插件
系统 SHALL 提供第二个 AI 插件入口「DSH AI」（机器人图标），与现有 AI 助手并存，面板独立打开、互不干扰。

#### Scenario: 打开 DSH AI 面板
- **WHEN** 用户在左侧工具栏点击 DSH AI 图标
- **THEN** 弹出「DSH AI」面板（机器人图标 + 标题），输入框可发消息

### Requirement: DSH 后端适配
后端 SHALL 通过 `DSH_URL`（默认 `http://127.0.0.1:3080`，环境变量可配置）调用本地 DSH 服务，并把 DSH 回复转成文档写入指令。

#### Scenario: DSH 正常回复写入文档
- **WHEN** 用户在 DSH AI 面板发送指令且 DSH 服务可用
- **THEN** 回复内容在 30 秒内写入文档（结构化 actions 精确写入；DSH 无法产出协议时按纯文本段写入文档末尾），面板显示回复

#### Scenario: DSH 不可达降级
- **WHEN** DSH_URL 不可达（服务未启动等）
- **THEN** 面板显示明确错误提示（含「检查 DSH 服务是否启动」），不挂死、不影响现有 AI 助手

### Requirement: DSH 协议探测先行
实施 SHALL 先探测 DSH 接口（用户提供 DSH web 带 token 地址），确定认证方式（cookie/token）与消息端点后再写适配层；探测结论记录在任务完成说明中。

### Requirement: 现有功能零回归
现有 AI 助手、表格/图表/图片写入、保存回调、导出接口行为 SHALL 保持不变。

## 调研结论（Part 2，本次不实施）
多人文档：DS 原生协作，改 key 生成策略 + 真实 user 即可，工作量小、风险低，建议下个 change 立 spec 实施。登录：先轻量本地账号，OAuth 按部署形态后置（钉钉个人应用是唯一个人可行渠道）。四家渠道门槛表见上。
