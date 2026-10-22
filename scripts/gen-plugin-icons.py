#!/usr/bin/env python3
# 批量生成 OnlyOffice 插件的多 DPI 图标（官方 marketplace 分档规范）：
#   resources/light|dark/{icon.png, icon@1.25x.png, icon@1.5x.png, icon@1.75x.png, icon@2x.png, icon.svg}
# 尺寸基准：100%=20px，1.25x=25、1.5x=30、1.75x=35、2x=40（与 DS 官方插件一致）。
# master 源优先级：icon.png（≥64px）→ icon.svg（cairosvg 渲染 512px）。
# dark 档默认与 light 同图（彩色品牌图标两主题通用），如需专用暗色图放 resources/dark-src.png。
# SVG 兜底：源为 svg 直接拷贝；源为 png 生成 base64 <image> 包装 svg，保证 icons2 的 "*" 档始终有文件。
# 用法：python3 scripts/gen-plugin-icons.py [插件目录 ...]（缺省扫描 plugins/ 下全部插件）
import base64
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / 'plugins'
# 官方命名：100%→icon.png，125%→icon@1.25x.png，150%→icon@1.5x.png，175%→icon@1.75x.png，200%→icon@2x.png
SIZES = [('icon.png', 20), ('icon@1.25x.png', 25), ('icon@1.5x.png', 30), ('icon@1.75x.png', 35), ('icon@2x.png', 40)]


def load_master(plug: Path) -> tuple[Image.Image, str]:
    """返回 (master RGBA 图, 源类型 'png'|'svg')"""
    svg = plug / 'icon.svg'
    dark_src = plug / 'resources' / 'dark-src.png'
    for png in (plug / 'icon.png', plug / 'icon64.png'):
        if png.exists():
            im = Image.open(png).convert('RGBA')
            if im.width >= 64:
                return im, 'png'
    if svg.exists():
        import cairosvg
        out = io.BytesIO()
        cairosvg.svg2png(url=str(svg), output_width=512, output_height=512, write_to=out)
        return Image.open(out).convert('RGBA'), 'svg'
    if dark_src.exists():
        im = Image.open(dark_src).convert('RGBA')
        if im.width >= 64:
            return im, 'png'
    raise SystemExit(f'{plug.name}: 无可用 master（icon.png ≥64px 或 icon.svg）')


def wrap_svg(im: Image.Image) -> str:
    """png master 包装成合法 svg（icons2 '*' 档兜底用）"""
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'viewBox="0 0 {im.width} {im.width}">'
            f'<image width="{im.width}" height="{im.width}" xlink:href="data:image/png;base64,{b64}"/></svg>')


def gen_one(plug: Path) -> str:
    master, src_type = load_master(plug)
    dark = plug / 'resources' / 'dark-src.png'
    dark_master = Image.open(dark).convert('RGBA') if dark.exists() else master
    made = []
    for theme, im in (('light', master), ('dark', dark_master)):
        d = plug / 'resources' / theme
        d.mkdir(parents=True, exist_ok=True)
        for name, px in SIZES:
            im.resize((px, px), Image.LANCZOS).save(d / name)
            made.append(f'{theme}/{name}')
        svg_out = d / 'icon.svg'
        if src_type == 'svg':
            svg_out.write_text((plug / 'icon.svg').read_text())
        else:
            svg_out.write_text(wrap_svg(im))
        made.append(f'{theme}/icon.svg')
    return f'{plug.name}: {len(made)} 个文件（master={src_type}）'


def main():
    targets = [Path(p) for p in sys.argv[1:]] or sorted(d for d in ROOT.iterdir() if d.is_dir() and (d / 'config.json').exists())
    for t in targets:
        print('[gen-icons]', gen_one(t))


if __name__ == '__main__':
    main()
