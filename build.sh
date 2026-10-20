#!/usr/bin/env bash
# 统一打包入口
#   ./build.sh --windows   产出 frontend/dist-win/：ai-editor.exe（Bun 单文件）+ dist + 部署说明
#                          配合 OnlyOffice Docs Windows 原生安装包部署
#   ./build.sh --linux     构建 Docker 镜像（OnlyOffice 一体化），docker run 部署
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
case "$MODE" in
  --windows|--linux) ;;
  *) echo "用法: ./build.sh --windows | --linux"; exit 1 ;;
esac

echo "==> 构建前端 (vite build)"
(cd frontend && npm run build)

if [ "$MODE" = "--windows" ]; then
  OUT=frontend/dist-win
  echo "==> 交叉编译 Windows 单文件 (bun build --compile)"
  rm -rf "$OUT"
  mkdir -p "$OUT"
  (cd frontend && bun build --compile --target=bun-windows-x64 server/prod.mjs --outfile "../$OUT/ai-editor.exe")
  cp -r frontend/dist "$OUT/dist"
  cp frontend/server/.env.example "$OUT/.env.example"
  cat > "$OUT/部署说明.txt" <<'EOF'
Windows 部署步骤
================
1. 安装 OnlyOffice Docs（Windows 版 Community Edition），安装时端口选 8089
   （前端页面固定连 8089 取编辑器 API）。
2. 把本目录整体复制到服务器任意位置（如 D:\ai-editor）。
3. 复制 .env.example 为 .env，填入 DEEPSEEK_API_KEY。
   不填也行：启动后在 AI 面板右上角齿轮设置里填，立即生效。
4. 双击 ai-editor.exe（或命令行运行），看到 "listening on :8090" 即成功。
5. 浏览器访问  http://服务器IP:8090/?url=<文档地址>

提示
----
- ai-editor.exe 单进程托管：前端页面 + /api AI 接口 + AI 插件文件，端口 8090。
- <文档地址> 必须是 OnlyOffice 服务器（8089）能下载到的 URL。
- data/ 目录存放运行时配置与点赞记忆，可随目录整体备份。
- 开机自启：用 NSSM 或 WinSW 把 ai-editor.exe 注册成 Windows 服务。
EOF
  echo "==> 完成: $OUT/"
  ls -la "$OUT"
else
  echo "==> 构建 Docker 镜像"
  docker build -t onlyoffice-demo .
  echo "==> 完成。运行:"
  echo "    docker run -d --name onlyoffice-demo -p 8089:80 -p 8090:8090 --restart=always onlyoffice-demo"
fi
