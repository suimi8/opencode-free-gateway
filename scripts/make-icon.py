#!/usr/bin/env python3
"""生成桌面应用图标 build/icon.png (1024x1024)。

设计：深色圆角方块 + 青绿渐变的双箭头（表示 chat ⇄ responses 协议互转），
右下角三点暗示「模型池 / 节点池」。

electron-builder 会从这张 1024 的 PNG 自动派生 .ico 与 .icns，所以只需这一张。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build', 'icon.png')

BG_TOP = (18, 20, 26)      # #12141a
BG_BOT = (10, 11, 15)      # #0a0b0f
CYAN = (34, 211, 238)      # #22d3ee
GREEN = (52, 211, 153)     # #34d399
SLATE = (148, 163, 184)    # #94a3b8


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_rect_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    g = Image.new('RGB', (1, size))
    for y in range(size):
        g.putpixel((0, y), lerp(top, bottom, y / max(1, size - 1)))
    return g.resize((size, size))


def arrow(draw, box, direction, color, shaft_h):
    """画一个带箭头的粗圆角矩形箭头。direction: 'right' | 'left'"""
    x0, y0, x1, y1 = box
    cy = (y0 + y1) // 2
    head_w = int((y1 - y0) * 1.35)
    head_h = (y1 - y0)
    if direction == 'right':
        shaft = [x0, cy - shaft_h // 2, x1 - head_w, cy + shaft_h // 2]
        head = [(x1 - head_w, cy - head_h // 2), (x1, cy), (x1 - head_w, cy + head_h // 2)]
    else:
        shaft = [x0 + head_w, cy - shaft_h // 2, x1, cy + shaft_h // 2]
        head = [(x0 + head_w, cy - head_h // 2), (x0, cy), (x0 + head_w, cy + head_h // 2)]
    draw.rounded_rectangle(shaft, radius=shaft_h // 2, fill=color)
    draw.polygon(head, fill=color)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    # 背景：圆角 + 竖向渐变
    bg = vertical_gradient(SIZE, BG_TOP, BG_BOT)
    icon = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), rounded_rect_mask(SIZE, int(SIZE * 0.22)))

    # 外发光边（细一圈亮边，增强识别度）
    border = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border)
    bd.rounded_rectangle([6, 6, SIZE - 7, SIZE - 7], radius=int(SIZE * 0.22),
                         outline=(255, 255, 255, 26), width=6)
    icon = Image.alpha_composite(icon, border.filter(ImageFilter.GaussianBlur(2)))

    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 双箭头：上青（chat →），下绿（← responses）
    pad = int(SIZE * 0.24)
    bar = int(SIZE * 0.105)
    gap = int(SIZE * 0.025)
    mid = SIZE // 2
    arrow(d, [pad, mid - gap - bar, SIZE - pad, mid - gap], 'right', CYAN + (255,), bar)
    arrow(d, [pad, mid + gap, SIZE - pad, mid + gap + bar], 'left', GREEN + (255,), bar)

    # 右下三点：模型 / 节点池
    r = int(SIZE * 0.030)
    cy2 = int(SIZE * 0.795)
    for i, c in enumerate([CYAN, GREEN, SLATE]):
        cx = int(SIZE * 0.365) + i * int(SIZE * 0.135)
        d.ellipse([cx - r, cy2 - r, cx + r, cy2 + r], fill=c + (235,))

    icon = Image.alpha_composite(icon, layer)

    # 箭头加一层柔光，显得不那么硬
    glow = layer.filter(ImageFilter.GaussianBlur(int(SIZE * 0.018)))
    glow.putalpha(glow.getchannel('A').point(lambda v: int(v * 0.55)))
    icon = Image.alpha_composite(icon, glow)

    # 裁回圆角
    icon.putalpha(Image.composite(icon.getchannel('A'), Image.new('L', (SIZE, SIZE), 0),
                                  rounded_rect_mask(SIZE, int(SIZE * 0.22))))

    icon.save(OUT)
    icon.resize((256, 256), Image.LANCZOS).save(OUT.replace('.png', '-256.png'))
    icon.resize((64, 64), Image.LANCZOS).save(OUT.replace('.png', '-64.png'))
    print(f'  已生成 {OUT}  ({os.path.getsize(OUT)} B)')
    print(f'  预览: {OUT.replace(".png", "-256.png")}')


if __name__ == '__main__':
    main()
