// 助手后端：加载器 + 分发器。路由在两处：
//   plugins/<名>/server.mjs  编辑器插件的后端（前端+后端一体）
//   server/plugins/*.mjs     平台核心（docs 文档托管 / editor-plugins 插件发现与托管）
// 内置模块静态 import（bun exe 编译打不进动态 import）；外挂：ASSISTANT_PLUGINS_DIR/*.mjs
// 及插件运行时目录下的 */server.mjs 动态接入（exe 里须是真实磁盘文件）。共享能力在 lib.mjs 经 ctx 注入。

// env.mjs 必须是第一个 import：先加载 .env，后面静态 import 的插件模块顶层才能读到环境变量
import './env.mjs'
import http from 'node:http'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cors, readBody, pushLog, tryParseActions, createMemory, createDocContext, PROTOCOL_PROMPT } from './lib.mjs'
import * as modDocs from './plugins/docs.mjs'
import * as modEditorPlugins from './plugins/editor-plugins.mjs'
import * as modAiServer from '../../plugins/plugin-ai/server.mjs'
import * as modDshServer from '../../plugins/plugin-dsh/server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR = process.env.ASSISTANT_DATA_DIR || ''
const PORT = Number(process.env.ASSISTANT_PORT || 3001)

// 插件运行时目录：env 优先；prod 默认 ~/.onlyoffice/plugins/，dev 默认项目根 plugins/
const PLUGINS_RUNTIME_DIR = process.env.OO_PLUGINS_DIR
  || (DATA_DIR ? path.join(os.homedir(), '.onlyoffice', 'plugins') : path.join(__dirname, '..', '..', 'plugins'))

const ctx = {
  dataDir: DATA_DIR,
  pluginsDir: PLUGINS_RUNTIME_DIR,
  serverDir: __dirname,
  cors,
  readBody,
  pushLog,
  tryParseActions,
  memory: createMemory(DATA_DIR),
  docContext: createDocContext(),
  prompt: PROTOCOL_PROMPT,
  routes: [],
}
ctx.get = (pattern, handler, opts) => ctx.routes.push({ method: 'GET', pattern, handler, prefix: !!(opts && opts.prefix) })
ctx.post = (pattern, handler, opts) => ctx.routes.push({ method: 'POST', pattern, handler, prefix: !!(opts && opts.prefix) })

// 同一文件静态/动态 import 是两个模块实例，须按磁盘路径判重，防外挂扫描重复注册
const registered = new Set()
function loadModule(mod, label, realPath) {
  try {
    if (typeof mod.register !== 'function') throw new Error('缺少 export register(ctx)')
    if (registered.has(realPath)) return
    registered.add(realPath)
    mod.register(ctx)
    console.log('[assistant] plugin loaded:', label)
  } catch (e) {
    console.error('[assistant] plugin load failed:', label, '-', String(e.message || e))
  }
}
for (const [rel, mod, label] of [
  ['./plugins/docs.mjs', modDocs, 'docs.mjs'],
  ['./plugins/editor-plugins.mjs', modEditorPlugins, 'editor-plugins.mjs'],
  ['../../plugins/plugin-ai/server.mjs', modAiServer, 'plugin-ai/server.mjs'],
  ['../../plugins/plugin-dsh/server.mjs', modDshServer, 'plugin-dsh/server.mjs'],
]) loadModule(mod, label, path.resolve(__dirname, rel))

// 外挂 1：ASSISTANT_PLUGINS_DIR 下的 *.mjs（_ 开头跳过）
const EXTERNAL_DIR = process.env.ASSISTANT_PLUGINS_DIR
if (EXTERNAL_DIR) {
  let files = []
  try { files = readdirSync(EXTERNAL_DIR).sort() } catch { /* 无目录 */ }
  for (const f of files) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue
    const p = path.join(EXTERNAL_DIR, f)
    try {
      loadModule(await import(pathToFileURL(p).href), f + '（外挂）', path.resolve(p))
    } catch (e) {
      console.error('[assistant] plugin load failed:', f, '-', String(e.message || e))
    }
  }
}

// 外挂 2：插件运行时目录 plugins/*/server.mjs（prod 即 ~/.onlyoffice/plugins/，与前端发现同目录）
let rootEntries = []
try { rootEntries = readdirSync(PLUGINS_RUNTIME_DIR, { withFileTypes: true }) } catch { /* 无目录 */ }
for (const ent of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
  const p = path.join(PLUGINS_RUNTIME_DIR, ent.name, 'server.mjs')
  if (!ent.isDirectory()) continue
  try {
    loadModule(await import(pathToFileURL(p).href), ent.name + '/server.mjs（外挂）', path.resolve(p))
  } catch (e) {
    console.error('[assistant] plugin load failed:', ent.name, '-', String(e.message || e))
  }
}

// === connect 风格 middleware（供 Vite / Nginx 前置使用）===
// 只接管 /api/*、/files/* 与 /plugins/*（编辑器插件静态文件）；其余请求 next() 交给后续中间件
export function assistantMiddleware(req, res, next) {
  const url = req.url || ''
  if (!url.startsWith('/api/') && !url.startsWith('/files/') && !url.startsWith('/plugins/')) return next()

  if (req.method === 'OPTIONS') {
    cors(res, req)  // 必须在 writeHead 之前设置，否则头会丢
    res.writeHead(204)
    res.end(); return
  }

  // 匹配规则：默认「全等 或 路径+查询串」（覆盖 /api/pending?session= 这类原前缀写法）；
  // 纯路径前缀（/files/<id>/<名>）由插件注册时显式传 {prefix:true}
  for (const r of ctx.routes) {
    if (req.method !== r.method) continue
    const hit = r.prefix ? url.startsWith(r.pattern) : (url === r.pattern || url.startsWith(r.pattern + '?'))
    if (!hit) continue
    Promise.resolve(r.handler(req, res, url)).catch((e) => {
      console.error('[assistant]', req.method, r.pattern, '-', String(e.message || e))
      if (!res.headersSent) res.writeHead(500)
      if (!res.writableEnded) res.end(JSON.stringify({ error: String(e.message || e) }))
    })
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
    console.log(`[assistant] standalone listening on :${PORT}, AI_API_URL=${process.env.AI_API_URL || ''}`)
  })
}
