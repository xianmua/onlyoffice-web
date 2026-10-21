// 生产服务器（Bun 单文件编译入口）：静态托管 dist + 进程内挂载助手中间件，单进程单端口。
// 源码调试 bun run server/prod.mjs（ROOT=frontend/）；exe 形态 ROOT=exe 所在目录
import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadEnvFile, MIME } from './lib.mjs'

// exe 形态 import.meta.dir 在 Bun 虚拟文件系统里，此时用 exe 自身目录；源码运行 ROOT=frontend/
const ROOT = /[\\/$]bunfs|~BUN/i.test(import.meta.dir) ? path.dirname(process.execPath) : path.resolve(import.meta.dir, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || process.env.PROD_PORT || 8090)

loadEnvFile(path.join(ROOT, '.env'))
loadEnvFile(path.join(ROOT, '..', '.env'))

// 助手的可写数据目录（.settings.json / 点赞记忆 / 活跃会话）→ exe 旁 data/
process.env.ASSISTANT_DATA_DIR = path.join(ROOT, 'data')
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true })

// 必须在环境准备就绪后再 import（assistant 顶层会读 .env / 数据文件）
const { assistantMiddleware } = await import('./assistant.mjs')

// === 静态资源 ===
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
    if (ext === '.html') headers['Cache-Control'] = 'no-cache'
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
