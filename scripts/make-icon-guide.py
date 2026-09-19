"""生成「图标尺寸说明书」配图 —— 产物写到工作区根目录，仅作文档使用

跑法：
    "C:/Users/wangh/.workbuddy/binaries/python/envs/default/Scripts/python.exe" scripts/make-icon-guide.py

为什么值得留一个脚本：这份配图里的每个数字都来自真实的产物文件
（app/icon.png / apple-icon.png / favicon.ico 的四个内嵌档），
换图标参数后重跑一次就同步了 —— 别拿旧的图去讲新的图标。
"""

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
APP = ROOT / "app"
OUT = ROOT.parent / "词径记-图标尺寸说明-v2.png"

# 配色与 app/globals.css 的 @theme 同源（这里画的是文档，不是界面，所以直接写值）
BG = "#f6f4f1"
CARD = "#ffffff"
LINE = "#e8e3db"
INK = "#3a3733"
INK2 = "#7a736b"
INK3 = "#a8a099"
OK = "#8aa68c"
WARN = "#c9a961"

F = r"C:\Windows\Fonts\msyh.ttc"
FB = r"C:\Windows\Fonts\msyhbd.ttc"
f_title = ImageFont.truetype(FB, 26)
f_sub = ImageFont.truetype(F, 15)
f_name = ImageFont.truetype(FB, 17)
f_body = ImageFont.truetype(F, 15)
f_small = ImageFont.truetype(F, 13)


def ico_frames(p: Path) -> dict[int, Image.Image]:
    b = p.read_bytes()
    _, _, n = struct.unpack("<HHH", b[:6])
    out: dict[int, Image.Image] = {}
    off = 6
    for _ in range(n):
        w, h, _, _, _, _, sz, at = struct.unpack("<BBBBHHII", b[off : off + 16])
        out[w or 256] = Image.open(io.BytesIO(b[at : at + sz])).convert("RGBA")
        off += 16
    return out


frames = ico_frames(APP / "favicon.ico")

# (尺寸, 来源图, 用在哪, 评价, 评价色)
ROWS = [
    (512, Image.open(APP / "icon.png").convert("RGBA"), "PWA 安装图标 / 高清屏首屏", "清晰", OK),
    (180, Image.open(APP / "apple-icon.png").convert("RGBA"), "iOS「添加到主屏幕」", "清晰", OK),
    (128, frames[128], "高 DPI 标签页 / 书签栏大图标", "清晰", OK),
    (64, frames[64], "标签页 · 高分屏（DPR 2）", "清晰", OK),
    (48, frames[48], "标签页 · 普通屏 / Windows 小图标", "清晰", OK),
    (32, frames[32], "标签页 · 最常遇到的一档（已专门优化）", "可辨认", WARN),
    (16, None, "——", "已移除", INK3),
]

SLOT = 128  # 左侧图标槽位宽度
COL_NAME = 300  # 尺寸文字列起点
COL_USE = 470  # 用途列起点
COL_VERDICT = 1010  # 评价列起点（右对齐用）
ROW_H = 132
PAD = 34
HEAD = 132
TAIL = 176
W = 1180
H = HEAD + ROW_H * len(ROWS) + TAIL

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 标题
d.text((PAD, 34), "词径记 · 图标尺寸说明", font=f_title, fill=INK)
d.text((PAD, 76), "左列为 1:1 真实大小（大图按比例缩显示）。深色圆底 + 银字「词」。", font=f_sub, fill=INK2)
d.line([(PAD, HEAD - 22), (W - PAD, HEAD - 22)], fill=LINE, width=1)

y = HEAD
for size, im, use, verdict, color in ROWS:
    # 槽位底卡
    d.rounded_rectangle(
        [PAD, y + 4, PAD + SLOT - 14, y + ROW_H - 16], radius=10, fill=CARD, outline=LINE
    )
    if im is not None:
        # 1:1 摆进槽位；比槽位大的按比例缩到槽位里（512 / 180 这两档）
        box = SLOT - 14 - 28
        show = im if im.width <= box else im.resize((box, box), Image.LANCZOS)
        img.paste(show, (PAD + (SLOT - 14 - show.width) // 2, y + 4 + (ROW_H - 20 - show.height) // 2), show)

    mid = y + ROW_H // 2
    if im is None:
        d.text((PAD + SLOT + 8, mid - 10), "（不提供）", font=f_body, fill=INK3)
    d.text((COL_NAME, mid - 12), f"{size} × {size}", font=f_name, fill=INK if im else INK3)
    d.text((COL_USE, mid - 11), use, font=f_body, fill=INK2 if im else INK3)
    d.text((COL_VERDICT, mid - 11), verdict, font=f_body, fill=color)

    y += ROW_H
    if size != ROWS[-1][0]:
        d.line([(PAD, y - 8), (W - PAD, y - 8)], fill=LINE, width=1)

# 尾部：把 32px 放大 6 倍，证明它是"可辨认"而不是一坨
d.line([(PAD, H - TAIL), (W - PAD, H - TAIL)], fill=LINE, width=1)
big = frames[32].resize((32 * 3, 32 * 3), Image.NEAREST)
img.paste(big, (PAD, H - TAIL + 26), big)
d.text((PAD + big.width + 22, H - TAIL + 30), "32px 放大 3 倍（看真实像素）", font=f_body, fill=INK2)
d.text(
    (PAD + big.width + 22, H - TAIL + 58),
    "「讠」和「司」分得开，是专门按 62% 大字号单独渲染的；\n"
    "如果让它拿 64 档缩下来，会糊成一团。",
    font=f_small,
    fill=INK3,
    spacing=6,
)
d.text(
    (PAD + big.width + 22, H - TAIL + 100),
    "16px 已彻底移除：7 画汉字在 16 个像素里必然粘连，实测三种做法全糊。",
    font=f_small,
    fill=INK3,
)

img.save(OUT)
print("写出", OUT, img.size)
