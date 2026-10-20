// 生产服务器（Bun 单文件编译入口）
// 职责：静态托管 dist（含 /plugin-ai） + 进程内挂载 /api 助手中间件 —— 单进程单端口
// 运行形态：
//   源码调试：bun run server/prod.mjs         （ROOT = frontend/）
//   Windows： ai-editor.exe（bun build --compile 产物，ROOT = exe 所在目录）
import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// === 定位应用根目录 ===
// 编译成 exe 后 import.meta.dir 在 Bun 虚拟文件系统里（/$bunfs/... 或 ~BUN），此时用 exe 自身目录；
// 源码运行时是真实路径，ROOT = frontend/
function appRoot() {
  if (/[\\/$]bunfs|~BUN/i.test(import.meta.dir)) return path.dirname(process.execPath)
  return path.resolve(import.meta.dir, '..')  // frontend/
}
const ROOT = appRoot()
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || process.env.PROD_PORT || 8090)

// === 加载 exe 同目录 .env（零依赖简易版；AI 面板的运行时设置优先级更高） ===
function loadEnvFile(file) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (!(key in process.env)) process.env[key] = val
  }
}
loadEnvFile(path.join(ROOT, '.env'))
loadEnvFile(path.join(ROOT, '..', '.env'))

// 助手的可写数据目录（.settings.json / 点赞记忆 / 活跃会话）→ exe 旁 data/
process.env.ASSISTANT_DATA_DIR = path.join(ROOT, 'data')
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true })

// 必须在环境准备就绪后再 import（assistant 顶层会读 .env / 数据文件）
const { assistantMiddleware } = await import('./assistant.mjs')

// === 静态资源 ===
const MIME = {
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

function safeJoin(base, urlPath) {
  const p = path.normalize(path.join(base, urlPath))
  if (p !== base && !p.startsWith(base + path.sep)) return null
  return p
}

function sendFile(req, res, file, headers) {
  const stat = statSync(file)
  const h = { 'Content-Length': stat.size, ...headers }
  res.writeHead(200, h)
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).pipe(res)
}

function serveStatic(req, res) {
  let urlPath
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    res.writeHead(400); res.end('bad url'); return
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html'

  const file = safeJoin(DIST, urlPath)
  if (file && existsSync(file) && statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase()
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' }
    // 插件文件一律禁缓存：DS iframe 缓存很凶，改完代码刷新也可能跑旧脚本
    if (urlPath.startsWith('/plugin-ai/')) headers['Cache-Control'] = 'no-store, must-revalidate'
    else if (ext === '.html') headers['Cache-Control'] = 'no-cache'
    sendFile(req, res, file, headers)
    return
  }

  // SPA fallback：/edit 等前端路由回退 index.html
  const index = path.join(DIST, 'index.html')
  if (existsSync(index)) {
    sendFile(req, res, index, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
    return
  }
  res.writeHead(404); res.end('not found (dist/ 缺失？请先 vite build)')
}

const server = http.createServer((req, res) => {
  // /api/* → 助手中间件；其余 → 静态
  assistantMiddleware(req, res, () => serveStatic(req, res))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[prod] listening on :${PORT}`)
  console.log(`[prod] root=${ROOT} dist=${DIST}`)
  console.log(`[prod] data=${process.env.ASSISTANT_DATA_DIR}`)
})
