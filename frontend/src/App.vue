<template>
  <div id="app">
    <!-- 加载状态 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <p>正在加载文档...</p>
    </div>

    <!-- 编辑器 -->
    <div v-else-if="editorReady" class="editor-container">
      <div id="editor" class="editor"></div>
    </div>

    <!-- 错误提示 -->
    <div v-else-if="error" class="loading">
      <p style="color: #c00;">{{ error }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const loading = ref(true)
const editorReady = ref(false)
const error = ref('')
const authUser = ref(null) // { userid, name } | null（企微登录后由编辑器插件「企微登录」面板获取）
let currentUrl = ''
let currentSession = ''
let currentF = ''
let currentName = ''
let currentCb = ''

// 编辑器插件列表：后端动态发现（/api/editor-plugins），失败回落内置列表
let editorPlugins = [
  { name: 'AI 助手', guid: 'asc.{7A1B9C0D-5E2F-4A3B-8C4D-000000000001}', baseUrl: '/plugins/plugin-ai', autostart: true },
]
async function loadEditorPlugins() {
  try {
    const r = await fetch('/api/editor-plugins')
    const data = await r.json()
    if (Array.isArray(data.plugins) && data.plugins.length) editorPlugins = data.plugins
  } catch { /* 保持内置列表 */ }
}

// 最近文档：喂给原生「文件-打开最近」面板（点击会 window.open 该 url）
// 本地打开（f=文件id）的条目记 ?f=<id>，远程文档记 ?url=...
const RECENT_KEY = 'oo-recent-docs'
function getRecent() {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY)) || []).filter((it) => it.url) } catch { return [] }
}
function pushRecent(url, f, name) {
  if (!url) return
  let title = name || ''
  if (!title) {
    try { title = decodeURIComponent(url.split('?')[0].split('/').pop()) || '文档' } catch { title = '文档' }
  }
  // DS 最近面板按 format 字段选图标（img-format-<扩展名>），缺了就不显示图标
  const m = title.toLowerCase().match(/\.([a-z0-9]+)/)
  const format = m ? m[1] : ''
  const entry = f
    ? { url: window.location.origin + '/?f=' + f, title, folder: '本机', format }
    : { url: window.location.origin + '/?url=' + encodeURIComponent(url), title, folder: '本机', format }
  const list = [entry, ...getRecent().filter((it) => it.url !== entry.url)]
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))) } catch {}
}

// 用一个简单稳定的算法哈希 URL（避免引入 spark-md5）
function sessionKeyOf(u) {
  let h = 5381
  for (let i = 0; i < u.length; i++) h = ((h << 5) + h + u.charCodeAt(i)) | 0
  return ('00000000' + (h >>> 0).toString(16)).slice(-8)
}

// 企微登录身份恢复（登录入口在编辑器插件「企微登录」面板里，此处只读取登录态注入协同身份）。
// 任何异常都降级为访客，绝不阻断文档加载
async function initAuth() {
  try {
    const me = await (await fetch('/api/auth/me')).json()
    if (me.authed) authUser.value = { userid: me.userid, name: me.name }
  } catch { /* 后端不可用 → 访客模式 */ }
}

// 从 URL 直接加载文档（跳过后端）；f=本地文件 id、name=文件名（用于最近列表记录）、cbOrigin=DS 保存回调地址前缀
async function loadDocument(url, f, name, cbOrigin) {
  try {
    currentUrl = url
    currentF = f || ''
    currentName = name || ''
    currentCb = cbOrigin || ''
    currentSession = sessionKeyOf(url)
    // 先拿插件列表再组装 editorConfig（两条进入路径都会走到这里，await 一次开销极小）
    await loadEditorPlugins()
    // 登记到后端：插件 iframe 若丢失 query 参数，可通过 /api/session 兜底查到
    fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession }),
    }).catch(() => {})
    // 提取文件扩展名
    const ext = url.split('?')[0].split('.').pop().toLowerCase()

    // 文件类型映射
    const typeMap = {
      'docx': ['word', 'docx'], 'doc': ['word', 'doc'],
      'xlsx': ['cell', 'xlsx'], 'xls': ['cell', 'xls'],
      'pptx': ['slide', 'pptx'], 'ppt': ['slide', 'ppt']
    }

    if (!typeMap[ext]) {
      throw new Error(`不支持的格式: .${ext}`)
    }

    const [docType, fileType] = typeMap[ext]

    // 加载 OnlyOffice API（端口 8089）
    // 前端: http://localhost:8090
    // OnlyOffice: http://localhost:8089
    const onlyofficeUrl = `${window.location.protocol}//${window.location.hostname}:8089`
    await loadAPI(onlyofficeUrl)

    // 直接配置编辑器使用在线 URL
    const config = {
      document: {
        fileType: fileType,
        // key 是 DS 协同会话的分组依据：同一文档必须同 key 才能实时协同；
        // f 与文件一一对应（重新上传会生成新 f），故 key 直接绑 f。
        // 无 f 的临时预览保持旧行为（每次新 key，不参与协同）。
        key: currentF ? `doc_${currentF}` : `doc_${Date.now()}`,
        title: currentName || `在线文档.${ext}`,
        url: url,
        permissions: {
          download: true,
          edit: true,
          print: true
        }
      },
      documentType: docType,
      editorConfig: {
        mode: "edit",
        lang: "zh-CN",
        user: {
          // 未登录也必须每人唯一：固定 id 会让 DS 把多窗口视为同一用户，协同会话互相干扰
          id: authUser.value?.userid || `anon-${Math.random().toString(36).slice(2, 8)}`,
          name: authUser.value?.name || '访客'
        },
        customization: {
          autosave: true,
          // 开启后 Ctrl+S/保存按钮触发 forcesave 回调（status 6 携带最终文档 URL 落盘）；
          // 关闭编辑器时还有 status 2 兜底保存
          forcesave: true,
          // 紧凑头部：logo/文档名所在的首行收起，操作按钮并入工具栏，界面更干净
          compactHeader: true,
          toolbarHideFileName: true,
          // 左上角 ONLYOFFICE 标识隐藏（社区版若忽略此配置则仍显示）
          logo: { visible: false }
        },
        // 保存回调：DS 自动保存/关闭时 POST 最终文档到此地址，后端覆盖原文件（仅本地文档有）
        ...(currentF && currentCb ? { callbackUrl: `${currentCb}/api/callback?f=${encodeURIComponent(currentF)}` } : {}),
        // 最近文档 → 原生「文件-打开最近」面板（本地文件选择走原生「打开」按钮）
        recent: getRecent(),
        // 仅 docx 挂插件；autostart 是串行队列，config.json 里 isAutostart:true 的至多一个
        ...(docType === 'word' && editorPlugins.length ? {
          plugins: {
            autostart: editorPlugins.filter((p) => p.autostart).map((p) => p.guid),
            pluginsData: editorPlugins.map((p) => `${window.location.origin}${p.baseUrl}/config.json`),
          },
        } : {}),
      },
      type: "desktop",
      width: "100%",
      height: "100%"
    }

    // 登记 DS 文档 key：/api/export 导出时后端能对该文档发 forcesave 拉最新版
    if (currentF) {
      fetch('/api/dockey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ f: currentF, key: config.document.key }),
      }).catch(() => {})
    }

    initEditor(config)

  } catch (e) {
    error.value = e.message || '加载失败'
    loading.value = false
  }
}

// 加载 OnlyOffice API
function loadAPI(baseUrl) {
  return new Promise((resolve, reject) => {
    if (window.DocsAPI) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = `${baseUrl}/web-apps/apps/api/documents/api.js`
    script.onload = () => {
      const timer = setInterval(() => {
        if (window.DocsAPI?.DocEditor) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('OnlyOffice API 加载超时'))
      }, 5000)
    }
    script.onerror = () => reject(new Error('无法加载 OnlyOffice API，请检查服务是否运行'))
    document.head.appendChild(script)
  })
}

// 初始化编辑器
function initEditor(config) {
  loading.value = false
  editorReady.value = true

  setTimeout(() => {
    new window.DocsAPI.DocEditor("editor", {
      ...config,
      events: {
        onAppReady: () => {
          console.log('✅ 编辑器就绪')
          pushRecent(currentUrl, currentF, currentName)
        },
        // 原生「文件-新建」→ 生成空白 docx 后整页重载打开（地址栏只留文件 id）
        onRequestCreateNew: async () => {
          try {
            const r = await fetch('/api/new-doc', { method: 'POST' })
            const j = await r.json()
            if (j.id) window.location.href = '/?f=' + j.id
            else if (j.url) window.location.href = '/?url=' + encodeURIComponent(j.url)
            else error.value = j.error || '新建失败'
          } catch (e) { error.value = '新建失败：' + e.message }
        },
      }
    })
  }, 100)
}

// 本地文件选择：DS frame 内弹系统对话框（patch），选中的 File 对象 postMessage 过来 → 上传 → 整页重载打开
async function onPickFile(file) {
  if (!file) return
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
    const j = await r.json()
    if (j.id) window.location.href = '/?f=' + j.id
    else if (j.url) window.location.href = '/?url=' + encodeURIComponent(j.url)
    else console.error('上传失败：', j.error)
  } catch (err) { console.error('上传失败：', err.message) }
}

// 页面加载时从 URL 参数读取
onMounted(async () => {
  // DS 文件菜单「打开...」在 DS frame 内弹系统文件对话框（patch v2），
  // 选中后 File 对象 postMessage 过来（structured clone 跨 frame 传输），本页负责上传与跳转
  window.addEventListener('message', (e) => {
    const d = e.data
    if (d && d.type === 'oo-local-file' && d.file) onPickFile(d.file)
  })
  const params = new URLSearchParams(window.location.search)
  // 企微登录态先行：本地毫秒级调用，保证 loadDocument 时编辑器身份已就位
  await initAuth()
  // 本地文件：地址栏只带文件 id（?f=<id>），向后端反查真实 URL
  const fid = params.get('f')
  if (fid) {
    fetch('/api/doc?f=' + encodeURIComponent(fid))
      .then((r) => r.json())
      .then((j) => {
        if (j.url) loadDocument(j.url, fid, j.name, j.callbackOrigin)
        else { error.value = j.error || '文件不存在或已过期'; loading.value = false }
      })
      .catch((e) => { error.value = '加载失败：' + e.message; loading.value = false })
    return
  }
  const url = params.get('url')
  if (url) {
    console.log('📥 加载在线文档:', url)
    // ?url= 自动转托管：先导入落盘再按 ?f= 流程打开，
    // 保存回调 / AI 改动落盘 / 导出全部可用；导入失败（源站不可达等）回退直连预览
    fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.id) {
          console.log('📦 已转托管:', j.id, j.name)
          // 地址栏换成 ?f=<id>：f 即协同房间号，此后分享/刷新都走同一房间；
          // 否则链接里的 ?url= 会让下一个人再次转存生成新 id，协同分裂
          history.replaceState(null, '', '/?f=' + encodeURIComponent(j.id))
          loadDocument(j.url, j.id, j.name, j.callbackOrigin)
        } else {
          console.warn('⚠️ 转托管失败，回退直连预览', j)
          loadDocument(url)
        }
      })
      .catch(() => loadDocument(url))
  } else {
    error.value = '请提供 url 参数，例如: ?url=http://example.com/doc.xlsx'
    loading.value = false
  }
})
</script>

<style>
/* 全局清除所有间距 */
* {
  margin: 0 !important;
  padding: 0 !important;
  box-sizing: border-box;
}

html, body, #app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: 'Segoe UI', Arial, sans-serif;
}

/* 加载状态 */
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: #f5f5f5;
}

.spinner {
  width: 50px;
  height: 50px;
  border: 4px solid #f3f3f3;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading p {
  margin-top: 1rem !important;
  color: #666;
}

/* 编辑器 - 100% 全屏，零间距 */
.editor-container {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden;
}

.editor {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
}
</style>
