// 编辑器插件发现与托管（目录即插件）：ctx.pluginsDir 下每个含 config.json 的子目录即一个插件。
//   GET /api/editor-plugins  App.vue 据此动态生成 pluginsData → 放入即发现、删掉即消失
//   GET /plugins/<名>/...    插件静态文件，统一 no-store（勿在 vite/prod 另加缓存特判）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'
import { MIME } from '../lib.mjs'

export function register(ctx) {
  const pluginsDir = () => ctx.pluginsDir

  // 单个插件坏了只 warn 跳过，不拖垮列表
  ctx.get('/api/editor-plugins', (req, res) => {
    const dir = pluginsDir()
    const plugins = []
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { /* 目录不存在 = 空列表 */ }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory()) continue
      const cfgPath = join(dir, ent.name, 'config.json')
      if (!existsSync(cfgPath)) continue
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
        if (!cfg.guid) throw new Error('缺少 guid')
        plugins.push({
          name: cfg.name || ent.name,
          dir: ent.name,
          guid: cfg.guid,
          baseUrl: '/plugins/' + ent.name,
          autostart: cfg.isAutostart === true,
        })
      } catch (e) {
        console.warn('[editor-plugins] 跳过无效插件', ent.name, '-', String(e.message || e))
      }
    }
    ctx.cors(res, req)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ plugins }))
  })

  ctx.get('/plugins/', (req, res, url) => {
    const base = resolve(pluginsDir())
    let rel = ''
    try { rel = decodeURIComponent(url.replace(/[?#].*$/, '').slice('/plugins/'.length)) } catch { rel = '' }
    let file = resolve(base, rel)
    if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403); res.end(); return }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
    ctx.cors(res, req)
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
  }, { prefix: true })
}
