// 文档托管后端：新建/上传/导入文档、DS 保存回调、导出转格式、静态文件下载
// 路由：POST /api/new-doc、POST /api/upload?name=、POST /api/import、POST /api/callback?f=、
//       POST /api/dockey、GET /api/export?f=|url=&format=、GET /api/doc?f=、GET /files/<id>/<名>
import fs from 'node:fs/promises'
import { mkdirSync, readdirSync } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

// 对外地址：dev 下 DS 在 bridge 容器里，访问不到宿主的 localhost，须配成 http://172.17.0.1:8090；
// Windows 原生部署 DS 与本服务同机，留空则回退用请求的 Host（localhost 可直达）
const DOC_PUBLIC_ORIGIN = (process.env.DOC_PUBLIC_ORIGIN || '').replace(/\/+$/, '')

// Document Server 对本服务可见的地址（命令服务/转换服务/回调兜底下载）
const DS_BASE = (process.env.DS_PUBLIC_ORIGIN || 'http://localhost:8089').replace(/\/+$/, '')

// 文件扩展名 → MIME（/files 下载与 /api/export 共用）
const FILE_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pdf': 'application/pdf',
}
const ALLOWED_EXTS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']

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
// /files/<id>/<名> → 磁盘绝对路径（防路径穿越）；非法/越界返回 null
function resolveUploadPath(uploadDir, url) {
  try {
    const rel = decodeURIComponent(url.slice('/files/'.length).split('?')[0])
    const file = path.normalize(path.join(uploadDir, rel))
    if (!file.startsWith(uploadDir + path.sep)) return null
    return file
  } catch { return null }
}

export function register(ctx) {
  const { cors, readBody } = ctx

  // 文档托管目录：「文件-新建/打开」产生的文档存这里，经 /files/<id>/<名>.docx 提供给 OnlyOffice 下载
  const UPLOAD_DIR = ctx.dataDir ? path.join(ctx.dataDir, 'uploads') : '/tmp/oo-uploads'
  mkdirSync(UPLOAD_DIR, { recursive: true })

  // OnlyOffice 服务器能下载到的地址
  function publicDocUrl(req, id, name) {
    const base = DOC_PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost:8090'}`
    return `${base}/files/${encodeURIComponent(id)}/${encodeURIComponent(name)}`
  }
  async function saveUploaded(id, name, data) {
    const dir = path.join(UPLOAD_DIR, id)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await fs.writeFile(file, data)
    return file
  }

  // 编辑器当前打开的文档 key（前端注册），forcesave 用
  const docKeyMap = new Map()

  // 下载 DS 保存回调里的最终文档。DS 给的 URL 基于它自己认识的地址，
  // 一般 host 侧可直接访问；失败则换 DS 对外地址（DS_BASE）重试
  async function fetchSavedDoc(fileUrl) {
    try {
      const r = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) })
      if (r.ok) return Buffer.from(await r.arrayBuffer())
    } catch {}
    const u = new URL(fileUrl, 'http://x')
    const r2 = await fetch(DS_BASE + u.pathname + u.search, { signal: AbortSignal.timeout(15000) })
    if (!r2.ok) throw new Error('DS 最终文档下载失败 HTTP ' + r2.status)
    return Buffer.from(await r2.arrayBuffer())
  }

  // 对编辑器中打开的文档发 forcesave（经 DS 命令服务），等保存回调把最新版写到磁盘（最多 8s）。
  // 编辑器没开 / DS 不可达 / 没有改动时静默放弃，导出走磁盘上的最近保存版本
  async function forcesaveLatest(fid) {
    const key = docKeyMap.get(fid)
    if (!key) return
    try {
      await fetch(DS_BASE + '/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ c: 'forcesave', key }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
    try {
      const dir = path.join(UPLOAD_DIR, fid)
      const file = path.join(dir, readdirSync(dir)[0])
      const m0 = (await fs.stat(file)).mtimeMs
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if ((await fs.stat(file)).mtimeMs !== m0) return
      }
    } catch {}
  }

  // 经 DS 转换服务转格式，返回转换后的文件字节。srcUrl 须是 DS 能访问到的源文件地址
  async function convertViaDS(srcUrl, srcExt, fmt, title) {
    const key = 'e' + crypto.createHash('md5').update(srcUrl + Date.now() + Math.random()).digest('hex').slice(0, 15)
    const r = await fetch(DS_BASE + '/converter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ async: false, filetype: srcExt, outputtype: fmt, key, url: srcUrl, title }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await r.text()
    let j
    try { j = JSON.parse(text) } catch { throw new Error('转换服务响应异常: ' + text.slice(0, 120)) }
    if (j.fileUrl) return fetchSavedDoc(j.fileUrl)
    if (j.endConvert === false) throw new Error('转换未完成（应改用 async 或重试）')
    throw new Error('转换失败: ' + JSON.stringify(j.error !== undefined ? { error: j.error } : j).slice(0, 200))
  }

  // === POST /api/new-doc（新建空白文档，返回 DS 可下载的 URL）===
  ctx.post('/api/new-doc', async (req, res) => {
    cors(res, req)
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const name = '新建文档.docx'
    try {
      await saveUploaded(id, name, blankDocx())
      res.end(JSON.stringify({ ok: true, id, name, url: publicDocUrl(req, id, name) }))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  // === POST /api/upload?name=<文件名>（本地文件上传，原文体二进制 body）===
  ctx.post('/api/upload', async (req, res, url) => {
    const u = new URL(url, 'http://x')
    const name = sanitizeName(u.searchParams.get('name') || '')
    const ext = path.extname(name).toLowerCase()
    if (!ALLOWED_EXTS.includes(ext)) {
      cors(res, req)
      res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式，仅 doc/docx/xls/xlsx/ppt/pptx' }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    await new Promise((r) => req.on('end', r))
    cors(res, req)
    try {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      await saveUploaded(id, name, Buffer.concat(chunks))
      res.end(JSON.stringify({ ok: true, id, name, url: publicDocUrl(req, id, name) }))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  // === POST /api/import（远程 URL 导入为托管文档：业务系统传文件 URL，落盘后返回 ?f= 可用的 id）===
  ctx.post('/api/import', async (req, res) => {
    const body = await readBody(req)
    cors(res, req)
    try {
      const { url: src, name } = JSON.parse(body)
      if (!src || !/^https?:\/\//i.test(src)) {
        res.writeHead(400); res.end(JSON.stringify({ error: '需要 {url: "http(s)://..."} ' })); return
      }
      const r = await fetch(src, { signal: AbortSignal.timeout(60000) })
      if (!r.ok) { res.writeHead(502); res.end(JSON.stringify({ error: '源文件下载失败 HTTP ' + r.status })); return }
      const buf = Buffer.from(await r.arrayBuffer())
      // 文件名优先用调用方给的，否则从 URL 路径取，再不行按内容猜个默认名
      const fromUrl = decodeURIComponent(new URL(src).pathname.split('/').pop() || '')
      const finalName = sanitizeName(name || fromUrl || '远程文档.docx')
      const ext = path.extname(finalName).toLowerCase()
      if (!ALLOWED_EXTS.includes(ext)) {
        res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式，仅 doc/docx/xls/xlsx/ppt/pptx' })); return
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      await saveUploaded(id, finalName, buf)
      // callbackOrigin 与 /api/doc 同源：DS 保存回调回访本服务的地址
      res.end(JSON.stringify({ ok: true, id, name: finalName, url: publicDocUrl(req, id, finalName), callbackOrigin: DOC_PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost:8090'}` }))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  // === POST /api/callback?f=<id>（DS 保存回调：status 2/6 携带最终文档 URL，覆盖原文件）===
  ctx.post('/api/callback', async (req, res, url) => {
    const body = await readBody(req)
    cors(res, req)
    try {
      const u = new URL(url, 'http://x')
      const fid = (u.searchParams.get('f') || '').replace(/[^a-z0-9]/gi, '')
      const data = JSON.parse(body)
      // status: 2=编辑中自动保存 6=关闭前保存；均携带最新文档 URL。老二进制格式(.doc/.xls/.ppt) DS 会在保存时转回原格式
      if (fid && (data.status === 2 || data.status === 6) && data.url) {
        const dir = path.join(UPLOAD_DIR, fid)
        const name = readdirSync(dir)[0]
        if (name) await fs.writeFile(path.join(dir, name), await fetchSavedDoc(data.url))
      }
    } catch (e) {
      console.error('[callback] 保存失败:', String(e.message || e))
    }
    // DS 协议固定回 {"error":0}（失败已内部记日志，回非 0 会让 DS 弹保存错误）
    res.end(JSON.stringify({ error: 0 }))
  })

  // === POST /api/dockey（前端登记编辑器当前打开的 DS 文档 key，export forcesave 用）===
  ctx.post('/api/dockey', async (req, res) => {
    const body = await readBody(req)
    cors(res, req)
    try {
      const { f, key } = JSON.parse(body)
      if (f && key) docKeyMap.set(String(f).replace(/[^a-z0-9]/gi, ''), String(key))
    } catch {}
    res.end(JSON.stringify({ ok: true }))
  })

  // === GET /api/export（导出文件流，两种模式）===
  //   ?f=<id>&format=pdf        托管文档：先 forcesave 拉最新，再按需转格式
  //   ?url=<直链>&format=pdf    远程直链：直接交 DS 转换服务（不经本服务落盘，须扩展名结尾的公开直链）
  ctx.get('/api/export', async (req, res, url) => {
    cors(res, req)
    const u = new URL(url, 'http://x')
    const fmt = (u.searchParams.get('format') || '').toLowerCase().replace(/[^a-z0-9]/g, '')

    // --- 远程直链模式 ---
    const remote = u.searchParams.get('url')
    if (remote) {
      if (!/^https?:\/\//i.test(remote)) { res.writeHead(400); res.end(JSON.stringify({ error: 'url 须为 http(s) 直链' })); return }
      const srcName = decodeURIComponent(new URL(remote).pathname.split('/').pop() || '')
      const ext = path.extname(srcName).slice(1).toLowerCase()
      if (!ALLOWED_EXTS.includes('.' + ext)) {
        res.writeHead(400); res.end(JSON.stringify({ error: '远程链接须以 doc/docx/xls/xlsx/ppt/pptx 结尾（DS 靠扩展名认格式）；需登录态的链接请改走 POST /api/import' })); return
      }
      try {
        const bin = await convertViaDS(remote, ext, fmt || ext, srcName)
        res.writeHead(200, {
          'Content-Type': FILE_MIME['.' + (fmt || ext)] || 'application/octet-stream',
          'Content-Length': bin.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(srcName.replace(/\.[^.]+$/, '.' + (fmt || ext)))}`,
        })
        res.end(bin)
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) }))
      }
      return
    }

    // --- 托管文档模式 ---
    const fid = (u.searchParams.get('f') || '').replace(/[^a-z0-9]/gi, '')
    const dir = fid ? path.join(UPLOAD_DIR, fid) : ''
    let name = null
    try { name = readdirSync(dir)[0] } catch {}
    if (!name) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在' })); return }
    const ext = path.extname(name).slice(1).toLowerCase()
    try {
      await forcesaveLatest(fid)
      if (!fmt || fmt === ext) {
        // 原格式：直接吐磁盘文件流
        const data = await fs.readFile(path.join(dir, name))
        const outName = fmt && fmt !== ext ? name.replace(/\.[^.]+$/, '.' + fmt) : name
        res.writeHead(200, {
          'Content-Type': FILE_MIME['.' + ext] || 'application/octet-stream',
          'Content-Length': data.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`,
        })
        res.end(data)
        return
      }
      // 跨格式：走 DS 转换服务
      const bin = await convertViaDS(publicDocUrl(req, fid, name), ext, fmt, name)
      res.writeHead(200, {
        'Content-Type': FILE_MIME['.' + fmt] || 'application/octet-stream',
        'Content-Length': bin.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/\.[^.]+$/, '.' + fmt))}`,
      })
      res.end(bin)
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  // === GET /api/doc?f=<id>（按文件 id 反查文档 URL，前端 ?f= 打开方式用）===
  ctx.get('/api/doc', async (req, res, url) => {
    cors(res, req)
    const u = new URL(url, 'http://x')
    const fid = (u.searchParams.get('f') || '').replace(/[^a-z0-9]/gi, '')
    const dir = fid ? path.join(UPLOAD_DIR, fid) : ''
    let name = null
    try { name = readdirSync(dir)[0] } catch {}
    if (!name) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在或已过期' })) ; return }
    // callbackOrigin：DS 容器回访本服务的地址（dev 下 DS 在 bridge 里够不到 localhost，用 docker0 网关；同机部署则用请求 Host）
    res.end(JSON.stringify({ ok: true, id: fid, name, url: publicDocUrl(req, fid, name), callbackOrigin: DOC_PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost:8090'}` }))
  })

  // === GET /files/<id>/<名>（给 OnlyOffice 服务器下载用；纯路径前缀匹配）===
  ctx.get('/files/', async (req, res, url) => {
    fs.readFile(resolveUploadPath(UPLOAD_DIR, url))
      .then((data) => {
        res.writeHead(200, { 'Content-Type': FILE_MIME[path.extname(url.split('?')[0]).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length })
        res.end(data)
      })
      .catch(() => { res.writeHead(404); res.end('not found') })
  }, { prefix: true })
}
