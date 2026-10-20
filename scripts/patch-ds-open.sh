#!/usr/bin/env bash
# 给 OnlyOffice DocumentServer 打补丁：web 版文件菜单显示「打开...」项，
# 点击后 postMessage('oo-open-local') 通知集成页弹出本地文件选择。
# 幂等：已打过补丁则跳过。原文件备份为 *.orig-<日期>。
set -euo pipefail

DS=${DS:-/var/www/onlyoffice/documentserver}
FM="$DS/web-apps/apps/documenteditor/main/app/view/FileMenu.js"
LM="$DS/web-apps/apps/documenteditor/main/app/controller/LeftMenu.js"

command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
[ -f "$FM" ] && [ -f "$LM" ] || { echo "找不到 DS 源文件: $FM"; exit 1; }

for f in "$FM" "$LM"; do
  if ! ls "${f}.orig-"* >/dev/null 2>&1; then cp "$f" "${f}.orig-$(date +%Y%m%d)"; fi
done

python3 - "$FM" "$LM" <<'PYEOF'
import sys, io

fm_path, lm_path = sys.argv[1], sys.argv[2]

# ---- Patch 1: FileMenu.js —— 把「打开...」插入块移出 仅桌面版 条件 ----
fm = io.open(fm_path, encoding='utf-8').read()

OLD1 = """            if ( Common.Controllers.Desktop.isActive()) {
                if (this.$el.find('#fm-btn-local-open').length<1) {"""
NEW1 = """            if (this.$el.find('#fm-btn-local-open').length<1) {"""

OLD2 = """                        }));
                }

                if (this.$el.find('#fm-btn-exit').length<1) {"""
NEW2 = """                        }));
            }

            if ( Common.Controllers.Desktop.isActive()) {
                if (this.$el.find('#fm-btn-exit').length<1) {"""

if OLD1 not in fm and "fm-btn-local-open" in fm:
    print("FileMenu.js: 已打过补丁，跳过")
elif OLD1 in fm and OLD2 in fm:
    fm = fm.replace(OLD1, NEW1, 1).replace(OLD2, NEW2, 1)
    io.open(fm_path, 'w', encoding='utf-8').write(fm)
    print("FileMenu.js: 「打开...」项已移出桌面版限制")
else:
    print("FileMenu.js: 锚点未命中！DS 版本可能不匹配"); sys.exit(1)

# ---- Patch 2: LeftMenu.js —— clickMenuFileItem 增加 file:open 分支 ----
# v2：直接在 DS frame 内注入隐藏 input 弹系统文件对话框（用户手势同 frame，Chrome 必弹），
#     选中后把 File 对象 postMessage 给父页（父页负责上传+跳转）。
#     旧版 v1（postMessage 让父页弹对话框）因跨 frame 激活传播被 Chrome 拒绝而废弃。
lm = io.open(lm_path, encoding='utf-8').read()

# 移除旧 v1 分支（postMessage 委托父页弹框，Chrome 拒绝跨 frame 激活，已废弃）
OLD_V1 = """            case 'file:open':
                try { window.top && window.top.postMessage('oo-open-local', '*'); } catch(e) {}
                break;
"""
lm = lm.replace(OLD_V1, '')

ANCHOR = "            case 'exit': Common.NotificationCenter.trigger('goback'); break;"
CASE = """            case 'file:open':
                try {
                    var ooInput = document.getElementById('oo-local-file');
                    if (!ooInput) {
                        ooInput = document.createElement('input');
                        ooInput.type = 'file';
                        ooInput.id = 'oo-local-file';
                        ooInput.accept = '.docx,.doc,.xlsx,.xls,.pptx,.ppt';
                        ooInput.style.display = 'none';
                        document.body.appendChild(ooInput);
                        ooInput.addEventListener('change', function (e) {
                            var f = e.target.files && e.target.files[0];
                            e.target.value = '';
                            if (f) { try { window.top.postMessage({ type: 'oo-local-file', file: f }, '*'); } catch (err) {} }
                        });
                    }
                    ooInput.click();
                } catch (err) {}
                break;
"""
if "oo-local-file" in lm:
    print("LeftMenu.js: 已打过 v2 补丁，跳过")
elif ANCHOR in lm:
    lm = lm.replace(ANCHOR, CASE + ANCHOR, 1)
    io.open(lm_path, 'w', encoding='utf-8').write(lm)
    print("LeftMenu.js: file:open v2 分支已注入")
else:
    print("LeftMenu.js: 锚点未命中！DS 版本可能不匹配"); sys.exit(1)
PYEOF

# nginx 开了 gzip_static，必须同步重生成 .gz（gzip -c 保留原文件，-n 不带时间戳）
for f in "$FM" "$LM"; do gzip -9n -c "$f" > "$f.gz"; done

echo "==> 完成。刷新浏览器（Ctrl+F5）生效。"
