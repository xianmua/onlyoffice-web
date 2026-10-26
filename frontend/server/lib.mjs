// 助手后端共享库：多插件公用的 HTTP 帮手 / 动作解析 / 点赞记忆 / 文档上下文。
// 只放「至少两个模块要用」的东西；插件私有配置与状态留在各 server.mjs 内部。
export { PROTOCOL_PROMPT } from './prompt.mjs'  // 经 ctx.prompt 注入插件
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 静态文件 MIME 表（prod.mjs 托管 dist 与 editor-plugins.mjs 托管插件共用）
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

// 自动加载 .env（手动简易实现，零依赖）。
// 路径按优先级（先项目根再子目录）：第一个存在的为准
// 实际已存在的 process.env 优先被保留，不会被 .env 覆盖
export function loadEnvFile(file) {
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

// CORS 帮手：必须回显请求方的 Origin（插件 iframe 源是 8089，前端是 8090），
// 写死 CORS_ORIGIN 会导致跨源 JSON POST 的预检失败
export function cors(res, req) {
  const origin = req.headers.origin || '*'
  // 允许插件独立安装到 DS（跨源 iframe）时携带 session cookie 调后端；
  // 带 credentials 时 ACAO 必须回显具体 origin（不能是 *），上方 echo 已满足
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
}

// 读文本 body（JSON 路由用；二进制上传路由自行收 chunks）
export function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(body))
  })
}

// 远程日志：插件 iframe 里看不到 console，用它回传调试信息（直接打到服务端 stdout）
export function pushLog(source, msg) {
  console.log(`[remote][${new Date().toISOString().slice(11, 19)}][${source}] ${msg}`)
}

// 模型回复 → 结构化动作。解析失败则整体当作 end 插入（向后兼容）
export function tryParseActions(text) {
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

// 点赞记忆 store：用户点👍的问答存起来，相似提问优先复用。
// plugin-ai 与 DSH 共用一张表；DSH 条目带 source:'dsh'，不参与 plugin-ai 检索
export function createMemory(dataDir) {
  const MEMORY_FILE = dataDir ? path.join(dataDir, 'ai-memory.json') : '/tmp/oo-ai-memory.json'
  let items = []  // {message, summary, actions, source?, ts}
  try { items = JSON.parse(readFileSync(MEMORY_FILE, 'utf8')) } catch {}
  function save() {
    try { writeFileSync(MEMORY_FILE, JSON.stringify(items.slice(-100))) } catch {}
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
  function findHit(message) {
    let best = null
    for (const it of items) {
      if (it.source === 'dsh') continue // DSH 点赞记忆不参与 plugin-ai 复用
      const score = textSim(message, it.message)
      if (!best || score > best.score) best = { score, item: it }
    }
    return best
  }
  return { items, save, findHit }
}

// 文档上下文缓存：插件从编辑器里抽出正文回传，选址时给模型当锚点参考
export function createDocContext() {
  const map = new Map()
  let last = ''
  return {
    map,
    get last() { return last },
    set last(v) { last = v },
  }
}
