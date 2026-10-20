// 助手后端：直连 OpenAI 兼容 API，AI 回复解析成结构化动作写入文档
// 对外接口（均由 Vite/prod.mjs 进程内挂载）：
//   POST /api/chat         {message} → AI 回复 + actions
//   POST /api/queue        {session, instruction} → 进内存队列
//   GET  /api/pending      插件轮询取写入指令
//   POST /api/new-doc|upload、GET /files/<id>/<名>、GET /api/doc?f=<id>  文档托管

import http from 'node:http'
import fs from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// === 自动加载 .env（手动简易实现，零依赖）===
// 路径按优先级（先项目根再子目录）：第一个存在的为准
// 实际已存在的 process.env 优先被保留，不会被 .env 覆盖
function loadEnvFile(file) {
  if (!existsSync(file)) return
  const content = readFileSync(file, 'utf8')
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}
loadEnvFile(path.join(__dirname, '.env'))
loadEnvFile(path.join(__dirname, '..', '..', '.env'))

// 数据目录：编译成 exe 部署时由 prod.mjs 注入（exe 旁 data/），源码开发用默认路径
const DATA_DIR = process.env.ASSISTANT_DATA_DIR || ''

// 文档托管目录：「文件-新建/打开」产生的文档存这里，经 /files/<id>/<名>.docx 提供给 OnlyOffice 下载
const UPLOAD_DIR = DATA_DIR ? path.join(DATA_DIR, 'uploads') : '/tmp/oo-uploads'
mkdirSync(UPLOAD_DIR, { recursive: true })

// 拼给 OnlyOffice 下载用的对外地址：
// dev 下 DS 在 bridge 容器里，访问不到宿主的 localhost，须配成 http://172.17.0.1:8090；
// Windows 原生部署 DS 与本服务同机，留空则回退用请求的 Host（localhost 可直达）
const DOC_PUBLIC_ORIGIN = (process.env.DOC_PUBLIC_ORIGIN || '').replace(/\/+$/, '')

const PORT = Number(process.env.ASSISTANT_PORT || 3001)
const DSH_URL = (process.env.DSH_URL || '').trim()
// 剥掉用户粘贴时可能带上的 /v1 或 /v1beta1 /v2 /openai 这种"版本尾巴"，
// 让拼路径时只拼一处 /v1/chat/completions，避免出现 /v1/v1/chat/completions 双 /v1。
function stripVersionTail(url) {
  return url
    .replace(/\/(v\d+(?:\.\d+)*(?:beta(?:\d+)?)?|openai|api|openapi)\/?$/i, '')
    .replace(/\/$/, '')
}
const DSH_BASE = stripVersionTail(DSH_URL)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

// === 运行时设置：插件设置面板保存的覆盖值（.settings.json 不进 git） ===
const SETTINGS_FILE = DATA_DIR ? path.join(DATA_DIR, '.settings.json') : path.join(path.dirname(fileURLToPath(import.meta.url)), '.settings.json')
let runtimeSettings = {}
try { runtimeSettings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch {}
function saveSettings() {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(runtimeSettings, null, 2)) } catch {}
}
function effectiveConfig() {
  return {
    apiUrl: stripVersionTail(runtimeSettings.apiUrl || DSH_URL),
    apiKey: runtimeSettings.apiKey || DEEPSEEK_API_KEY,
    model: runtimeSettings.model || DEEPSEEK_MODEL,
    extraPrompt: runtimeSettings.extraPrompt || '',
  }
}
function maskKey(k) {
  return k ? (k.length > 8 ? k.slice(0, 3) + '***' + k.slice(-4) : '***') : ''
}

// 系统提示词：结构化选址协议——模型决定内容写到文档哪个位置
const PROTOCOL_PROMPT = [
  '你是文档编辑助手。你的输出会被程序解析后写入用户正在编辑的 OnlyOffice 文档。',
  '【输出格式】只输出一个 JSON 对象，禁止 markdown 代码块和任何多余文字：',
  '{"summary":"给用户的一句简短中文说明","actions":[{"type":"insert","target":"end","content":"要写入的纯文本"}]}',
  'actions 每项字段：',
  '- type: "insert"（新增内容）| "replace"（替换已有段落）| "format"（给已有段落设置格式）',
  '- target（仅 insert 需要）: "end"=文档末尾 | "cursor"=光标处 | "after"=anchor 定位的段落之后 | "before"=之前',
  '- anchor（after/before/replace/format 必填）: 从文档内容中【原样摘取】的连续文字片段，程序用它精确定位段落',
  '- format 用法：{"type":"format","anchor":"原文字片段", ...格式字段}。支持全部字段：bold 加粗(true/false)、italic 斜体、underline 下划线、strikeout 删除线、fontSize 字号(磅数，"大一点"约+2)、fontName 字体名(如"宋体"、"黑体"、"Times New Roman")、color 文字颜色(6位HEX如"FF0000"红色)、highlight 高亮底色(颜色英文名如"yellow"/"green")、align 段落对齐("left"/"center"/"right"/"justify")。以上字段全部可选，只给要改的，没给的不动，可一次组合多个',
  '- 中文字号→磅数换算表（必须严格按此表，不要自己估）：初号=42、小初=36、一号=26、小一=24、二号=22、小二=18、三号=16、小三=15、四号=14、小四=12、五号=10.5、小五=9。用户说"一号"就是 fontSize:26，"小四"就是 12',
  '- fontName 只允许用这些标准字体名（白名单）：宋体、黑体、楷体、仿宋、微软雅黑、隶书、幼圆、Times New Roman、Arial、Courier New、Calibri、Georgia。用户说"黑体"就输出"黑体"，禁止自造名（如"正黑""粗黑"）；用户提的字不在表里时选最接近的并在 summary 里说明',
  '- content: 要写入的纯文本，禁止 markdown 符号（**、##、`）。分页用单独一行 [[PAGE_BREAK]] 标记，程序会转成真分页符。',
  '【选址规则】',
  '- target end 追加到文档末尾。"写到第N页" = content 开头输出 N-1 个 [[PAGE_BREAK]]（单独成行），程序会先分页再写；"新起一页" = 开头 1 个 [[PAGE_BREAK]]',
  '- "XX后面" = after + anchor；改写已有文字 → replace；改格式（字体/字号/颜色/对齐等）已有文字 → format',
  '- 用户没提位置 → 默认 end（不加分页符）',
  '- 内容要写到多个位置 → 拆成多个 action',
  '- summary 里不要重复 content 全文，只说明你做了什么、写到了哪',
].join('\n')

function buildSystemPrompt(docContext) {
  const cfg = effectiveConfig()
  let s = PROTOCOL_PROMPT
  if (cfg.extraPrompt) s += '\n【用户附加要求（需遵守）】\n' + cfg.extraPrompt
  if (!docContext) return s
  const trimmed = String(docContext).slice(0, 4000)
  return s + '\n【文档当前内容（供选址/anchor 参考）】\n' + trimmed
}

// 模型回复 → 结构化动作。解析失败则整体当作 end 插入（向后兼容）
function tryParseActions(text) {
  if (!text) return null
  // 兼容 ```json 包裹、前后杂文字
  const cleaned = String(text).replace(/```(?:json)?/g, '').trim()
  const candidates = [cleaned, (cleaned.match(/\{[\s\S]*\}/) || [])[0] || '']
  for (const c of candidates) {
    try {
      const o = JSON.parse(c)
      if (o && typeof o === 'object') {
        if (Array.isArray(o.actions) && o.actions.length) {
          return { summary: String(o.summary || '已处理'), actions: o.actions }
        }
        // 有 summary 没 actions：至少把 summary 提出来显示，别把 JSON 原样贴给用户
        if (o.summary) return { summary: String(o.summary), actions: [] }
      }
    } catch {}
  }
  return null
}

// === 内存队列 ===
const pendingQueue = new Map()
function queuePut(session, instruction) {
  if (!pendingQueue.has(session)) pendingQueue.set(session, [])
  pendingQueue.get(session).push({ instruction, ts: Date.now() })
}
function queueTake(session) {
  const q = pendingQueue.get(session)
  if (!q || q.length === 0) return null
  return q.shift()
}

// 当前活跃会话：插件 iframe 可能丢失 query 参数，用这个兜底
// 持久化到磁盘，重启后不丢（否则插件要重载页面才能重新拿到 session）
const SESSION_FILE = DATA_DIR ? path.join(DATA_DIR, 'active-session.txt') : '/tmp/oo-active-session'
let activeSession = ''
try { activeSession = readFileSync(SESSION_FILE, 'utf8').trim() } catch {}
function saveActiveSession(s) {
  activeSession = s
  try { writeFileSync(SESSION_FILE, s) } catch {}
}

// 远程日志：插件 iframe 里看不到 console，用它回传调试信息（直接打到服务端 stdout）
function pushLog(source, msg) {
  console.log(`[remote][${new Date().toISOString().slice(11, 19)}][${source}] ${msg}`)
}

// === 调 OpenAI 兼容 API ===
async function callLLM(message, ctx) {
  const cfg = effectiveConfig()
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey
  const r = await fetch(cfg.apiUrl + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx) },
        { role: 'user', content: message },
      ],
    }),
  })
  const j = await r.json()
  return j.choices?.[0]?.message?.content || j.choices?.[0]?.text || j.reply || ''
}

async function stubReply(message) {
  return {
    source: 'stub',
    message: `（stub）已收到：${message}。未配置可用的 AI API，请检查 .env 或面板设置。`,
    actions: [],
  }
}

// === 点赞记忆：用户点👍的问答存起来，相似提问优先复用 ===
const MEMORY_FILE = DATA_DIR ? path.join(DATA_DIR, 'ai-memory.json') : '/tmp/oo-ai-memory.json'
let memoryItems = []  // {message, summary, actions, ts}
try { memoryItems = JSON.parse(readFileSync(MEMORY_FILE, 'utf8')) } catch {}
function saveMemory() {
  try { writeFileSync(MEMORY_FILE, JSON.stringify(memoryItems.slice(-100))) } catch {}
}
function normText(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}
function textSim(a, b) {
  a = normText(a); b = normText(b)
  if (!a || !b) return 0
  if (a === b) return 1
  const A = [], B = []
  for (let i = 0; i < a.length - 1; i++) A.push(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) B.push(b.slice(i, i + 2))
  const map = {}
  A.forEach((x) => { map[x] = (map[x] || 0) + 1 })
  let inter = 0
  B.forEach((x) => { if (map[x] > 0) { inter++; map[x]-- } })
  return (2 * inter) / (A.length + B.length)
}
function findMemoryHit(message) {
  let best = null
  for (const it of memoryItems) {
    const score = textSim(message, it.message)
    if (!best || score > best.score) best = { score, item: it }
  }
  return best
}

// 文档上下文缓存：插件从编辑器里抽出正文回传，选址时给模型当锚点参考
const docContextMap = new Map()
let lastDocContext = ''

async function dispatch(message, ctx) {
  try {
    const reply = (await callLLM(message, ctx)).trim()
    const parsed = tryParseActions(reply)
    if (parsed) {
      return { source: 'ai', message: parsed.summary, reply: parsed.summary, actions: parsed.actions }
    }
    // 模型没按 JSON 输出：整体作为内容插到文末（兜底仍能写入）
    return { source: 'ai', message: reply.slice(0, 120), reply, actions: [{ type: 'insert', target: 'end', content: reply }] }
  } catch (e) {
    console.warn('[assistant] LLM failed, stub fallback:', e.message)
    return await stubReply(message)
  }
}

// === 空白 docx 生成（零依赖：STORED 方式打 zip，无需 deflate）===
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// entries: [{ name, data: Buffer }] → zip Buffer（全部 STORED 不压缩）
function makeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  const dosTime = 0, dosDate = 0x2100  // 固定一个合法日期即可
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)      // UTF-8 文件名
    local.writeUInt16LE(0, 8)           // STORED
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, end])
}

function blankDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>'),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document ${W}><w:body>`
        + '<w:p><w:pPr><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:pPr></w:p>'
        + '</w:body></w:document>'),
    },
  ])
}

// 上传/新建的文件落盘到 uploads/<id>/<安全文件名>，返回 { id, name }
function sanitizeName(name) {
  const base = path.basename(String(name || ''))
  const clean = base.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(-100)
  return clean || 'document.docx'
}
async function saveUploaded(id, name, data) {
  const dir = path.join(UPLOAD_DIR, id)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, data)
  return file
}
// OnlyOffice 服务器能下载到的地址
function publicDocUrl(req, id, name) {
  const base = DOC_PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost:8090'}`
  return `${base}/files/${encodeURIComponent(id)}/${encodeURIComponent(name)}`
}
// /files/<id>/<名> → 磁盘绝对路径（防路径穿越）；非法/越界返回 null
function resolveUploadPath(url) {
  try {
    const rel = decodeURIComponent(url.slice('/files/'.length).split('?')[0])
    const file = path.normalize(path.join(UPLOAD_DIR, rel))
    if (!file.startsWith(UPLOAD_DIR + path.sep)) return null
    return file
  } catch { return null }
}

// === 导出 connect 风格 middleware（供 Vite / Nginx 前置使用）===
// 只接管 /api/*；其余请求 next() 交给后续中间件（Vite 静态资源等）

// CORS 帮手：必须回显请求方的 Origin（插件 iframe 源是 8089，前端是 8090），
// 写死 CORS_ORIGIN 会导致跨源 JSON POST 的预检失败
function cors(res, req) {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
}

export function assistantMiddleware(req, res, next) {
  const url = req.url || ''
  if (!url.startsWith('/api/') && !url.startsWith('/files/')) return next()

  if (req.method === 'OPTIONS') {
    cors(res, req)  // 必须在 writeHead 之前设置，否则头会丢
    res.writeHead(204)
    res.end(); return
  }

  // === POST /api/chat ===
  if (req.method === 'POST' && url === '/api/chat') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      cors(res, req)
      let payload
      try { payload = JSON.parse(body) }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); return }
      const message = (payload.message || '').trim()
      const session = (payload.docUrl || '').trim() || (payload.session || '').trim()
      if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'empty' })); return }
      // 点赞记忆命中：相似提问直接复用赞过的回复与写入动作
      const hit = findMemoryHit(message)
      if (hit && hit.score >= 0.7 && hit.item.actions) {
        res.end(JSON.stringify({
          source: 'memory',
          message: hit.item.summary,
          actions: hit.item.actions,
          memoryHit: true,
          score: Number(hit.score.toFixed(2)),
        }))
        return
      }
      // 文档上下文：优先用请求自带（插件直聊实时抽取），否则用插件回传的缓存
      let ctx = String(payload.docContext || docContextMap.get(session) || lastDocContext || '')
      // 次相似命中：把赞过的问答作为风格参考注入
      if (hit && hit.score >= 0.35) {
        ctx += `\n【参考：用户曾点赞的类似提问】问：${hit.item.message} 你当时的回复（风格与选址偏好供参考）：${hit.item.summary}`
      }
      try {
        const r = await dispatch(message, ctx)
        if (hit && hit.score >= 0.35) r.memoryRef = true
        res.end(JSON.stringify(r))
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ source: 'error', message: String(e.message || e) }))
      }
    })
    return
  }

  // === GET /api/settings（Key 只回掩码）===
  if (req.method === 'GET' && url === '/api/settings') {
    cors(res, req)
    const cfg = effectiveConfig()
    res.end(JSON.stringify({
      apiUrl: runtimeSettings.apiUrl || '',           // 空 = 用 .env 默认
      apiKeyMasked: maskKey(cfg.apiKey),
      apiKeySet: !!cfg.apiKey,
      model: runtimeSettings.model || '',            // 空 = 用 .env 默认
      extraPrompt: runtimeSettings.extraPrompt || '',
    }))
    return
  }

  // === POST /api/settings（保存覆盖值；传 null/'' 恢复 .env 默认）===
  if (req.method === 'POST' && url === '/api/settings') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try {
        const p = JSON.parse(body)
        for (const k of ['apiUrl', 'apiKey', 'model', 'extraPrompt']) {
          if (k in p) {
            const v = typeof p[k] === 'string' ? p[k].trim() : ''
            if (v) runtimeSettings[k] = v
            else delete runtimeSettings[k]
          }
        }
        saveSettings()
        const cfg = effectiveConfig()
        res.end(JSON.stringify({ ok: true, apiKeyMasked: maskKey(cfg.apiKey), apiKeySet: !!cfg.apiKey }))
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })) }
    })
    return
  }

  // === POST /api/like（点赞记忆）===
  if (req.method === 'POST' && url === '/api/like') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try {
        const p = JSON.parse(body)
        if (!p.message || !p.summary) { res.writeHead(400); res.end(JSON.stringify({ error: 'message/summary required' })); return }
        const dup = memoryItems.find((it) => it.message === p.message && it.summary === p.summary)
        if (!dup) {
          memoryItems.push({ message: String(p.message), summary: String(p.summary), actions: p.actions || null, ts: Date.now() })
          saveMemory()
        }
        res.end(JSON.stringify({ ok: true, total: memoryItems.length }))
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })) }
    })
    return
  }

  // === POST /api/queue ===
  if (req.method === 'POST' && url === '/api/queue') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try {
        const { session, instruction } = JSON.parse(body)
        if (!session || !instruction) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing' })); return }
        queuePut(session, instruction)
        res.end(JSON.stringify({ ok: true }))
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })) }
    })
    return
  }

  // === GET /api/pending ===
  if (req.method === 'GET' && url.startsWith('/api/pending')) {
    const u = new URL(url, 'http://x')
    const session = u.searchParams.get('session') || ''
    cors(res, req)
    const item = queueTake(session)
    res.end(JSON.stringify({ instruction: item ? item.instruction : null }))
    return
  }

  // === POST /api/log（插件远程日志，直接打到服务端 stdout）===
  if (req.method === 'POST' && url === '/api/log') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try {
        const j = JSON.parse(body)
        pushLog(j.source || 'plugin', String(j.msg || '').slice(0, 500))
      } catch {}
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  // === POST /api/context（插件回传文档正文，供选址参考）===
  if (req.method === 'POST' && url === '/api/context') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try {
        const { session, text } = JSON.parse(body)
        const t = String(text || '').slice(0, 8000)
        if (session) docContextMap.set(session, t)
        lastDocContext = t
      } catch {}
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  // === POST /api/session（登记当前文档会话）===
  if (req.method === 'POST' && url === '/api/session') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors(res, req)
      try { saveActiveSession((JSON.parse(body).session || '').trim()) } catch {}
      res.end(JSON.stringify({ ok: true, session: activeSession }))
    })
    return
  }

  // === GET /api/session（插件兜底查询）===
  if (req.method === 'GET' && url === '/api/session') {
    cors(res, req)
    res.end(JSON.stringify({ session: activeSession }))
    return
  }

  // === GET /api/health ===
  if (req.method === 'GET' && url === '/api/health') {
    cors(res, req)
    res.end(JSON.stringify({ ok: true, apiUrl: DSH_BASE }))
    return
  }

  // === POST /api/new-doc（新建空白文档，返回 DS 可下载的 URL）===
  if (req.method === 'POST' && url === '/api/new-doc') {
    cors(res, req)
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const name = '新建文档.docx'
    saveUploaded(id, name, blankDocx())
      .then(() => res.end(JSON.stringify({ ok: true, id, name, url: publicDocUrl(req, id, name) })))
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })) })
    return
  }

  // === POST /api/upload?name=<文件名>（本地文件上传，原文体二进制 body）===
  if (req.method === 'POST' && url.startsWith('/api/upload')) {
    const u = new URL(url, 'http://x')
    const name = sanitizeName(u.searchParams.get('name') || '')
    const ext = path.extname(name).toLowerCase()
    if (!['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'].includes(ext)) {
      cors(res, req)
      res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式，仅 doc/docx/xls/xlsx/ppt/pptx' }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      cors(res, req)
      try {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        await saveUploaded(id, name, Buffer.concat(chunks))
        res.end(JSON.stringify({ ok: true, id, name, url: publicDocUrl(req, id, name) }))
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) }))
      }
    })
    return
  }

  // === GET /api/doc?f=<id>（按文件 id 反查文档 URL，前端 ?f= 打开方式用）===
  if (req.method === 'GET' && url.startsWith('/api/doc?')) {
    cors(res, req)
    const u = new URL(url, 'http://x')
    const fid = (u.searchParams.get('f') || '').replace(/[^a-z0-9]/gi, '')
    const dir = fid ? path.join(UPLOAD_DIR, fid) : ''
    let name = null
    try { name = readdirSync(dir)[0] } catch {}
    if (!name) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在或已过期' })) ; return }
    res.end(JSON.stringify({ ok: true, id: fid, name, url: publicDocUrl(req, fid, name) }))
    return
  }

  // === GET /files/<id>/<名>（给 OnlyOffice 服务器下载用）===
  if (req.method === 'GET' && url.startsWith('/files/')) {
    const MIME = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.ppt': 'application/vnd.ms-powerpoint' }
    fs.readFile(resolveUploadPath(url))
      .then((data) => {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(url.split('?')[0]).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length })
        res.end(data)
      })
      .catch(() => { res.writeHead(404); res.end('not found') })
    return
  }

  res.writeHead(404); res.end('not found')
}

// 直接 `node assistant.mjs` 运行时，仍以独立进程模式起在 ASSISTANT_PORT（默认 3001）。
// 被 Vite / prod.mjs import 时（单进程模式）不会触发监听。
// 编译成 exe（Bun 虚拟文件系统）时 import.meta.url 在 bunfs 里，必须排除，否则会误判多起一个 3001
const isDirectRun = !/[\\/$]bunfs|~BUN/i.test(import.meta.url)
  && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const server = http.createServer((req, res) => {
    assistantMiddleware(req, res, () => {
      res.writeHead(404); res.end('not found')
    })
  })
  server.listen(PORT, () => {
    console.log(`[assistant] standalone listening on :${PORT}, DSH_URL=${DSH_URL}`)
  })
}
