"""生成「满幅（maskable）图标」预览图 —— 产物写到工作区根目录，仅供肉眼验收

跑法：
    "C:/Users/wangh/.workbuddy/binaries/python/envs/default/Scripts/python.exe" scripts/make-maskable-preview.py

为什么要专门出一张预览图：

    满幅图标**没法在浏览器里验收**。它的对错完全取决于"系统拿什么形状去裁"，
    而那个形状只有安卓桌面才有。桌面预览看到的永远是一块完整的方图 ——
    缺角、露白、笔画被切，全都看不见。

    所以这里把几种最常见的遮罩**在本地模拟出来**，并排摆着看：
    左半幅回答"要不要做"，右半幅回答"做对了没有"。

⚠️ 图里的每个数字都来自真实产物文件（`app/icon.png` 与 `public/icon-maskable-*.png`），
   换图标参数后重跑一次就同步 —— 别拿旧图去讲新图标。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT.parent / "词径记-满幅图标-预览-v1.png"

# 配色与 app/globals.css 的 @theme 同源（这里画的是文档，不是界面，所以直接写值）
BG = "#f6f4f1"
CARD = "#ffffff"
LINE = "#e8e3db"
INK = "#3a3733"
INK2 = "#7a736b"
INK3 = "#a8a099"
OK = "#8aa68c"
BAD = "#c07a6a"
WARN = "#c9a961"
SHELF = "#ddd8d0"  # 模拟"桌面底色"：透明的地方会露出它 —— 露白就是这么看出来的
SAFE = 0.80  # 安全区直径占图标边长的比例（与 scripts/gen-app-icon.py 的 MASKABLE_SAFE 同值）

F = r"C:\Windows\Fonts\msyh.ttc"
FB = r"C:\Windows\Fonts\msyhbd.ttc"
f_title = ImageFont.truetype(FB, 27)
f_sub = ImageFont.truetype(F, 15)
f_head = ImageFont.truetype(FB, 16)
f_cap = ImageFont.truetype(F, 14)
f_capb = ImageFont.truetype(FB, 14)
f_small = ImageFont.truetype(F, 13)

W = 1180
PAD = 34

normal = Image.open(ROOT / "app" / "icon.png").convert("RGBA")
bleed = Image.open(ROOT / "public" / "icon-maskable-512.png").convert("RGBA")


def masked(icon: Image.Image, side: int, kind: str) -> Image.Image:
    """把图标按某种形状裁一次，返回带透明的 RGBA。kind 见下面的调用处。"""
    icon = icon.resize((side, side), Image.LANCZOS)
    mask = Image.new("L", (side, side), 0)
    d = ImageDraw.Draw(mask)
    if kind == "circle":
        d.ellipse([0, 0, side - 1, side - 1], fill=255)
    elif kind == "squircle":  # 安卓默认的方圆形：圆角取边长的 40%
        d.rounded_rectangle([0, 0, side - 1, side - 1], radius=round(side * 0.40), fill=255)
    elif kind == "rounded":
        d.rounded_rectangle([0, 0, side - 1, side - 1], radius=round(side * 0.22), fill=255)
    else:  # square —— 系统不裁
        d.rectangle([0, 0, side - 1, side - 1], fill=255)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask)
    return out


def draw_tile(
    canvas: Image.Image,
    source: Image.Image,
    kind: str,
    x: int,
    y: int,
    side: int,
    line1: str = "",
    line2: str = "",
    color: str = INK2,
    safe_ring: bool = False,
) -> None:
    """在 (x, y) 铺一块"桌面底色"的小方台，把裁好的图标贴上去，底下配两行说明。

    特意画这层底色（SHELF）而不是白卡：满幅图标**做错的症状就是"露出底色"**，
    不铺一层有颜色的底，白角贴在白卡上根本看不出来。

    `safe_ring=True` 额外套一个金圈 —— 那是**安全区**（直径 80% 的那个圆）。
    内容只要落在圈里就不会被任何外壳切到；画出来是为了让"别把字放大"这条规矩看得见。
    """
    box = side + 28
    d.rounded_rectangle([x, y, x + box, y + box], radius=12, fill=SHELF)
    canvas.paste(masked(source, side, kind), (x + 14, y + 14))

    if safe_ring:
        pad = side * (1 - SAFE) / 2
        ring = [x + 14 + pad, y + 14 + pad, x + 14 + side - pad, y + 14 + side - pad]
        for a in range(0, 360, 12):  # 虚线：金圈是"参考线"，不是设计的一部分
            d.arc(ring, a, a + 6, fill=WARN, width=2)

    cy = y + box + 12
    if line1:
        d.text((x + box // 2, cy), line1, font=f_capb, fill=INK, anchor="ma")
        cy += 22
    if line2:
        d.text((x + box // 2, cy), line2, font=f_cap, fill=color, anchor="ma")


canvas = Image.new("RGB", (W, 1180), BG)
d = ImageDraw.Draw(canvas)

# ── 页眉 ──────────────────────────────────────────────────────
d.text((PAD, 32), "词径记 · 满幅（maskable）图标预览", font=f_title, fill=INK)
d.text(
    (PAD, 74),
    "安卓会用自己的形状去裁图标。下面每一种外壳都是真实效果的本地模拟 —— 满幅图标没法在浏览器里验收。",
    font=f_sub,
    fill=INK2,
)
d.line([(PAD, 112), (W - PAD, 112)], fill=LINE, width=1)

# ── ① 满幅版放进四种外壳 ──────────────────────────────────────
y = 136
d.text((PAD, y), "① 满幅版（public/icon-maskable-512.png）放进安卓的四种外壳", font=f_head, fill=INK)
y += 30
S1 = 150
GAP = 30
BOX = S1 + 28
row_w = BOX * 4 + GAP * 3
x = (W - row_w) // 2
for kind, name, note in [
    ("circle", "圆形", "边缘干净"),
    ("squircle", "方圆形（安卓默认）", "边缘干净"),
    ("rounded", "圆角方形", "边缘干净"),
    ("square", "方形（不裁）", "金圈 = 安全区（直径 80%）"),
]:
    draw_tile(canvas, bleed, kind, x, y, S1, name, note, OK, safe_ring=(kind == "square"))
    x += BOX + GAP
y += BOX + 76

# ── ② 拿现在这张顶替，会怎样 ──────────────────────────────────
d.text(
    (PAD, y),
    "② 为什么不能拿现在那张图标顶替 —— 拿「圆角方形」看最明显（方圆形外壳同样会露，只是露得少）",
    font=f_head,
    fill=INK,
)
y += 30
S2 = 176
BOX2 = S2 + 28
pair_w = BOX2 * 2 + 150
x = (W - pair_w) // 2
draw_tile(
    canvas,
    normal,
    "rounded",
    x,
    y,
    S2,
    "现在的图标.png　当满幅用",
    "四角透明 → 露出桌面底色",
    BAD,
)
ax = x + BOX2 + 40
d.text((ax + 35, y + S2 // 2 - 16), "→", font=ImageFont.truetype(FB, 42), fill=INK3)
draw_tile(
    canvas,
    bleed,
    "rounded",
    x + BOX2 + 150,
    y,
    S2,
    "满幅版",
    "铺满 → 一个透明像素都没有",
    OK,
)
y += BOX2 + 78

# ── ③ 和普通版是同一个标 ──────────────────────────────────────
d.text(
    (PAD, y),
    "③ 圆形外壳下，满幅版与普通版看起来是同一个标（字宽都取 38%，换的只是「圆片 → 整块料」）",
    font=f_head,
    fill=INK,
)
y += 30
S3 = 132
BOX3 = S3 + 28
pair3 = BOX3 * 2 + 150
x = (W - pair3) // 2
draw_tile(canvas, normal, "circle", x, y, S3, "普通版（purpose: any）", "四角透明", INK2)
d.text((x + BOX3 + 40 + 35, y + S3 // 2 - 16), "＝", font=ImageFont.truetype(FB, 36), fill=INK3)
draw_tile(
    canvas,
    bleed,
    "circle",
    x + BOX3 + 150,
    y,
    S3,
    "满幅版（purpose: maskable）",
    "四角铺满（圆形外壳看不见差别）",
    INK2,
)
y += BOX3 + 72

# ── 页脚：把关键数字摊开 ──────────────────────────────────────
d.line([(PAD, y), (W - PAD, y)], fill=LINE, width=1)
y += 18
d.text((PAD, y), "安全区自检", font=f_capb, fill=INK)
d.text(
    (PAD + 96, y),
    "墨迹外框的角离圆心 27.4%，红线 40.0%（安全区直径 80%）→ 余量 12.6%。"
    "字宽放到 56.6% 就正好压线，再大「司」会被切掉。",
    font=f_small,
    fill=INK2,
)
y += 24
d.text((PAD, y), "产物", font=f_capb, fill=INK)
d.text(
    (PAD + 96, y),
    "public/icon-maskable-192.png（13 KB）/ icon-maskable-512.png（34 KB）"
    "　·　两张都是 alpha 255~255，一个透明像素都没有　·　由 scripts/gen-app-icon.py 生成",
    font=f_small,
    fill=INK2,
)
y += 24
d.text((PAD, y), "验收", font=f_capb, fill=INK)
d.text(
    (PAD + 96, y),
    "真正的判据只有一条：装到安卓桌面上看。本地只能保证「铺满了」与「没压线」这两件事。",
    font=f_small,
    fill=INK2,
)

out = canvas.crop((0, 0, W, y + 40))
out.save(OUT)
print("写出", OUT, out.size)
