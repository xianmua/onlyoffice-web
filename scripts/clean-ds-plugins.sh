#!/usr/bin/env bash
# 移除 OnlyOffice DocumentServer 的全部自带插件（插件管理器/YouTube/OCR/翻译/AI 等），
# 插件 tab 只剩集成方注入的 plugin-ai（AI 助手）。
# 做法：把 sdkjs-plugins/ 下除白名单外的插件目录移到 sdkjs-plugins-disabled/，
#       并清空 plugin-list-default.json（docservice 动态生成 plugins.json 时会扫描目录）。
# 幂等：无默认插件时跳过。容器重建后需重跑 + 重启容器。
set -euo pipefail

DS=${DS:-/var/www/onlyoffice/documentserver}
SP="$DS/sdkjs-plugins"
OFF="$DS/sdkjs-plugins-disabled"
LIST="$SP/plugin-list-default.json"

# 白名单：本项目插件（AI 助手 + DSH AI + 插件管理器市场）+ 共享资源 + 本地测试文档
KEEP="plugin-ai plugin-dsh marketplace local-test pluginBase.js plugins.css v1 plugin-list-default.json"

mkdir -p "$OFF"
moved=0
for d in "$SP"/*/ ; do
  name=$(basename "$d")
  skip=0
  for k in $KEEP; do [ "$name" = "$k" ] && skip=1; done
  [ $skip -eq 1 ] && continue
  mv "$SP/$name" "$OFF/" && moved=$((moved+1))
done
echo "已移走 $moved 个自带插件目录"

if [ -f "$LIST" ] && [ "$(cat "$LIST")" != "[]" ]; then
  ls "${LIST}.orig-"* >/dev/null 2>&1 || cp "$LIST" "${LIST}.orig-$(date +%Y%m%d)"
  printf '[]' > "$LIST"
  gzip -9n -c "$LIST" > "$LIST.gz"
  echo "默认插件列表已清空"
fi

echo "==> 完成。需重启容器生效：docker restart <容器名>，浏览器 Ctrl+F5。"
