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
let currentUrl = ''
let currentSession = ''
let currentF = ''
let currentName = ''

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

// 从 URL 直接加载文档（跳过后端）；f=本地文件 id、name=文件名（用于最近列表记录）
async function loadDocument(url, f, name) {
  try {
    currentUrl = url
    currentF = f || ''
    currentName = name || ''
    currentSession = sessionKeyOf(url)
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
        key: `doc_${Date.now()}`,
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
          id: "1",
          name: "访客"
        },
        customization: {
          autosave: true
        },
        // 最近文档 → 原生「文件-打开最近」面板（本地文件选择走原生「打开」按钮）
        recent: getRecent(),
        // 仅当 docx 时挂 AI 插件（其他格式 PasteText 行为不一致）
        ...(docType === 'word' ? {
          plugins: {
            // autostart 只接受 GUID 字符串数组
            autostart: ['asc.{7A1B9C0D-5E2F-4A3B-8C4D-000000000001}'],
            // 此版本 DS 的 pluginsData 是 config.json 路径数组（不是元数据对象）。
            // 插件文件由 Vite 同域提供（8090），与 /api 同源，轮询无任何 CORS 问题
            pluginsData: [
              `${window.location.origin}/plugin-ai/config.json`,
            ],
          },
        } : {}),
      },
      type: "desktop",
      width: "100%",
      height: "100%"
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
onMounted(() => {
  // DS 文件菜单「打开...」在 DS frame 内弹系统文件对话框（patch v2），
  // 选中后 File 对象 postMessage 过来（structured clone 跨 frame 传输），本页负责上传与跳转
  window.addEventListener('message', (e) => {
    const d = e.data
    if (d && d.type === 'oo-local-file' && d.file) onPickFile(d.file)
  })
  const params = new URLSearchParams(window.location.search)
  // 本地文件：地址栏只带文件 id（?f=<id>），向后端反查真实 URL
  const fid = params.get('f')
  if (fid) {
    fetch('/api/doc?f=' + encodeURIComponent(fid))
      .then((r) => r.json())
      .then((j) => {
        if (j.url) loadDocument(j.url, fid, j.name)
        else { error.value = j.error || '文件不存在或已过期'; loading.value = false }
      })
      .catch((e) => { error.value = '加载失败：' + e.message; loading.value = false })
    return
  }
  const url = params.get('url')
  if (url) {
    console.log('📥 直接加载在线文档:', url)
    loadDocument(url)
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
