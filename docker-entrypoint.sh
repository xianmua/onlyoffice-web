#!/bin/bash
# 容器启动入口：先应用 DS 补丁与插件清理（两个脚本均幂等，可重复执行），再启动 documentserver。
# 单个脚本失败不阻塞启动（如 DS 版本变化导致补丁锚点未命中），错误打到日志便于排查。
set +e
echo "[entrypoint] 应用 web-apps 补丁（文件菜单打开/最近图标/隐藏右侧栏）..."
bash /app/scripts/patch-ds-open.sh
echo "[entrypoint] 清理自带插件（保留 plugin-ai/marketplace 等）..."
bash /app/scripts/clean-ds-plugins.sh
echo "[entrypoint] 启动 OnlyOffice DocumentServer..."
exec /app/ds/run-document-server.sh
