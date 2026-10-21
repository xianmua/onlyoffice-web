# OnlyOffice Web 对外接口文档

供外部业务系统集成的 HTTP 接口说明。

## 接口速查

| 接口 | 方法 | 用途 | 必要性 |
|---|---|---|---|
| `/api/export` | GET | **导出下载**（文件流，支持 PDF 等格式转换） | 核心 |
| `/api/import` | POST | 远程 URL 导入为托管文档 | 对接推荐 |
| `/api/upload?name=` | POST | 上传本地文档（二进制 body） | 可选 |
| `/api/doc?f=` | GET | 查询文档信息 | 辅助 |
| `/files/<id>/<名>` | GET | 下载原格式文件流 | 辅助 |
| `/api/new-doc` | POST | 新建空白文档 | 可选 |

## 基础约定

- 基础地址：`http://<服务主机>:8090`（前端与接口同端口，单进程单服务）
- 请求/响应均为 UTF-8 JSON（文件下载类接口返回二进制流）
- CORS 已全开放（响应头 `Access-Control-Allow-Origin: *`）
- **鉴权：当前版本所有接口无鉴权**，仅限内网/受信网络使用。对外暴露前须自行加网关或等 token 鉴权版本
- 支持的文档格式：`.docx .doc .xlsx .xls .pptx .ppt`（下称「文档格式」）

---

## 一、导出下载（核心接口）

```http
GET /api/export?f=<文件id>&format=pdf        # 模式A：托管文档
GET /api/export?url=<文件直链>&format=pdf    # 模式B：远程直链，无需先导入
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `f` | query | 模式A 必填 | 文件 id（导入/上传返回的） |
| `url` | query | 模式B 必填 | 文件直链，须以文档格式扩展名结尾，且 Document Server 可匿名访问 |
| `format` | query | 否 | 目标格式：`pdf` / `docx` / `xlsx` / `pptx` 等；省略 = 原格式 |

两种模式的行为：

| | 模式A（`f=`） | 模式B（`url=`） |
|---|---|---|
| 文件来源 | 本服务托管的文档 | 直接交 Document Server 转换，本服务不经手存储 |
| 编辑中的最新改动 | ✅ 自动 forcesave 落盘后再导出（最多等 8 秒） | ❌ 无副本，导出的是原始文件 |
| 需登录态的链接 | —（已落盘，无此问题） | ❌ 不支持，改走 `/api/import` |

**响应 200**：文件二进制流，`Content-Disposition: attachment`（带 UTF-8 文件名）。

```bash
# 托管文档导出 PDF 并传文件桶（伪代码）
curl -o report.pdf "http://localhost:8090/api/export?f=mvggpag24h5qek&format=pdf"

# 远程直链直接转 PDF
curl -o out.pdf "http://localhost:8090/api/export?url=https%3A%2F%2Fexample.com%2F报告.docx&format=pdf"
```

**错误**：404 `{"error":"文件不存在"}`；400 `{"error":"..."}`（url 非法 / 扩展名不支持）；500 `{"error":"..."}`（转换失败等）。

> 模式B 导出的是**原文件**的转换结果，与编辑器状态无关。注意：编辑器里打开 `?url=` 时前端会自动转托管（见第二节），想带走用户 AI 修改后的版本，请从导入返回的 `id` 走模式A导出。

---

## 二、文档接入

### 1. 远程 URL 导入（对接推荐）

```http
POST /api/import
Content-Type: application/json

{ "url": "https://文件桶或业务系统/报告.docx", "name": "可选，自定义文件名" }
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `url` | body JSON | 是 | 文件直链，`http(s)://` 开头 |
| `name` | body JSON | 否 | 自定义文件名；省略时从 URL 路径取 |

**响应 200**

```json
{ "ok": true, "id": "mvghejcx4yfo1f", "name": "报告.docx", "url": "http://172.17.0.1:8090/files/mvghejcx4yfo1f/报告.docx" }
```

**错误**：400（URL 非法 / 扩展名不支持）；502 `{"error":"源文件下载失败..."}`（源站不可达）；500（下载超时等，内置 60 秒超时）。

> 编辑器直接打开 `?url=<文件URL>` 时前端也会**自动转托管**（内部就是先调本接口再按托管文档打开），AI 改动同样可保存、可导出；导入失败自动回退为直连预览（该模式下改动不落盘）。

### 2. 上传本地文档

```http
POST /api/upload?name=<文件名>
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `name` | query | 是 | 文件名（含扩展名，需 URL 编码） |
| body | body | 是 | 文件二进制内容（`application/octet-stream`） |

**响应 200**：与导入相同（`ok / id / name / url`）。错误：400（扩展名不支持）。

```bash
curl -X POST "http://localhost:8090/api/upload?name=%E6%8A%A5%E5%91%8A.docx" \
     --data-binary @报告.docx
```

### 3. 新建空白文档

```http
POST /api/new-doc
```

无请求体。**响应 200**：与导入相同（`ok / id / name / url`）。

---

## 三、辅助接口

### 查询文档信息

```http
GET /api/doc?f=<文件id>
```

**响应 200**

```json
{
  "ok": true, "id": "mvggpag24h5qek", "name": "新建文档.docx",
  "url": "http://172.17.0.1:8090/files/mvggpag24h5qek/新建文档.docx",
  "callbackOrigin": "http://172.17.0.1:8090"
}
```

**错误**：404 `{"error":"文件不存在或已过期"}`。

### 下载原格式文件流

```http
GET /files/<文件id>/<文件名>
```

**响应 200**：文件二进制流，`Content-Type` 按扩展名给出。

> 何时最新：编辑器里 **Ctrl+S** 或**关闭文档**后落盘（Document Server 保存回调机制）。纯挂机不保存时拿到的是上次保存的版本；要强制最新用 `/api/export`（模式A自带 forcesave）。

---

## 四、内部接口（插件/编辑器专用，不建议外部调用）

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 健康检查 |
| `POST /api/chat` | AI 对话：返回结构化写入动作（由插件执行到文档） |
| `POST /api/dockey` | 前端登记编辑器当前文档 key（export forcesave 用） |
| `POST /api/queue` + `GET /api/pending` | 网页悬浮窗 → 插件的写入指令队列 |
| `POST /api/callback?f=<id>` | Document Server 保存回调（DS 专用） |
| `GET/POST /api/session` | 当前活跃文档会话登记 |
| `GET/POST /api/settings` | AI 运行时配置（API 地址/Key/模型） |
| `POST /api/like` | 点赞记忆入库 |
| `POST /api/context` | 插件回传文档文本上下文 |
| `POST /api/log` | 插件调试日志上报 |

**DSH AI 插件独立一套**（与上表同构，互不干扰）：

| 接口 | 用途 |
|---|---|
| `GET /api/dsh/health` | DSH 插件健康探测 |
| `POST /api/dsh/chat` | DSH 对话：调本机 DSH CLI，回复由插件写入文档 |
| `POST /api/dsh/queue` + `GET /api/dsh/pending` | DSH 写入指令队列 |
| `GET/POST /api/dsh/session` | DSH 活跃会话登记 |
| `GET/POST /api/dsh/settings` | DSH 配置（服务地址，默认 `127.0.0.1:3080`） |
| `POST /api/dsh/like` / `POST /api/dsh/context` / `POST /api/dsh/log` | 点赞 / 文档上下文 / 日志 |

---

## 五、规划中

- **Token 鉴权**：`Authorization: Bearer <token>` 中间件（计划与多人文档协作一起做）

---

## 六、典型集成流程

```
业务系统                     本服务                        Document Server
   │  1. POST /api/import（传URL）或 /api/upload（传文件）│
   │──────────────────────────>  │  存盘 /tmp/oo-uploads/<id>/   │
   │  <── {id, url}              │                               │
   │                             │  2. 用户/浏览器打开 ?f=<id>    │
   │                             │  3. AI 助手修改文档            │
   │                             │  4. Ctrl+S/关闭 → 保存回调落盘 │
   │  5. GET /api/export?f=&format=pdf           │               │
   │──────────────────────────>  │  forcesave + 转格式            │
   │  <── 文件二进制流            │                               │
   │  6. PUT 到第三方文件桶       │                               │
```
