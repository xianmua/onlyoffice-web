import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { assistantMiddleware } from './server/assistant.mjs'

// 单进程模式：assistant 后端折叠进 Vite dev server，全站只暴露 8090。
//   /            → Vue 前端（Vite 静态服务）
//   /api/*       → assistant middleware（进程内，无需 3001）
//   /web-apps/*  → 代理到 OnlyOffice (:8089)
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'assistant-backend',
      configureServer(server) {
        // 插件文件一律禁缓存：DS iframe 对 plugin.js/index.html 缓存很凶，
        // 改完代码刷新页面也可能跑旧脚本（曾导致"模型输出了 fontName 但插件没执行"）
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/plugin-ai/')) {
            res.setHeader('Cache-Control', 'no-store, must-revalidate')
          }
          next()
        })
        // 注意：要挂在 Vite 内部中间件之前，避免被静态/SPA fallback 抢走
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/@fs/')) return next()
          assistantMiddleware(req, res, next)
        })
      },
    },
  ],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 8090,
    // 监听 0.0.0.0：DS bridge 容器经 docker0 网关（172.17.0.1:8090）回源下载本地文档
    host: true,
    // 插件 config.json 会被 DS 编辑器 frame（8089 源）跨源读取，必须放行
    cors: { origin: '*' },
    fs: {
      strict: false
    },
    proxy: {
      // 开发环境代理 OnlyOffice API
      '/web-apps': {
        target: 'http://localhost:8089',
        changeOrigin: true,
        ws: true
      },
      // 插件 iframe 在 8090 源，SDK 路径代理到 OnlyOffice 容器
      '/sdkjs-plugins': {
        target: 'http://localhost:8089',
        changeOrigin: true
      }
      // '/api' 不再代理 —— assistant 已折叠进本进程（assistantMiddleware）
    },
    historyApiFallback: true
  }
})
