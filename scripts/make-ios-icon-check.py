"""iPhone 主屏图标 —— 「改前 / 改后」对照与验收（产物写到工作区根目录）

跑法：
    "C:/Users/wangh/.workbuddy/binaries/python/envs/default/Scripts/python.exe" scripts/make-ios-icon-check.py

为什么要专门出这张图：

    **同一张图标，安卓和 iPhone 的规矩正好相反。**

      · 安卓：允许你给"四角透明的圆片"。不认识 maskable 时自己垫一块底色
              （所以那两张满幅图是"保险"，不是"必需"）。
      · iPhone：**不许有透明**。它先画一块圆角方形的底，把图标合成上去，
              再把所有透明像素**一律填成纯黑** —— Apple 图标规范与多家
              图标服务商口径一致：*"A transparent Apple touch icon shows up
              as your logo on an ugly black square."*

    2026-10-01 之前给 iPhone 的那张（`app/apple-icon.png`）正是
    **内切圆、四角 alpha = 0** ⇒ 正好踩在这条上：深墨圆片外面裹一层纯黑方底，
    圆与方之间一道看得见的弧线，一眼就是没做好的样子。
    **最坑的是它在桌面浏览器里完全看不出问题** —— 只有真加到主屏才现形，
    而 iOS 还会缓存图标（装完才发现的话，得先删桌面图标再重装一次）。

    现在那张已经改成满幅（`gen-app-icon.py` 里走 `render(180, maskable=True)`）。

**这张图是验收图**：右格读的是**磁盘上那个真身文件**（不是现场重画的），
并当场量出"圆角方之内有多少面积会被填黑"。

⚠️ 这是**模拟**，不是真机截图：圆角半径按 22.37%（iOS 图标网格的常规比例）近似，
   真实的 iOS 用的是连续曲率的超椭圆，视觉上会更"圆润"一点。
   **最终判据仍然是真机**：把图标加进主屏时，预览框里直接就能看到。
"""

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT.parent / "词径记-iPhone图标-预览-v1.png"

sys.path.insert(0, str(HERE))
from importlib import import_module

# gen-app-icon.py 里有 main guard，import 不会触发写盘
icon_gen = import_module("gen-app-icon")  # noqa: E402

BG = "#f6f4f1"
CARD = "#ffffff"
LINE = "#e8e3db"
INK = "#3a3733"
INK2 = "#7a736b"
INK3 = "#a8a099"
OK = "#8aa68c"
BAD = "#c07a6a"
WARN = "#c9a961"
SHELF = "#e2ded8"

F = r"C:\Windows\Fonts\msyh.ttc"
FB = r"C:\Windows\Fonts\msyhbd.ttc"
f_title = ImageFont.truetype(FB, 27)
f_sub = ImageFont.truetype(F, 15)
f_head = ImageFont.truetype(FB, 16)
f_cap = ImageFont.truetype(F, 14)
f_capb = ImageFont.truetype(FB, 14)
f_small = ImageFont.truetype(F, 13)
f_note = ImageFont.truetype(F, 14)

W = 1180
PAD = 34
IOS_RADIUS = 0.2237  # iOS 圆角方半径 / 边长（近似值）


def ios_mask(side: int) -> Image.Image:
    """iOS 主屏图标的圆角方遮罩（圆角取边长的 22.37%，近似）。"""
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, side - 1, side - 1], radius=round(side * IOS_RADIUS), fill=255
    )
    return mask


def ios_tile(icon: Image.Image, side: int) -> Image.Image:
    """按 iOS 的规矩把图标做成主屏上的样子。

    iOS 的做法：先画一块圆角方形的底 → 把图标合成上去 → **透明处填黑**。
    所以"透明"不会露桌面，会变成实打实的黑色（纯黑 #000，
    而我们的图标底色是暖黑 #2b2a27 —— 两者很接近，这正是要亲眼确认的原因）。
    """
    icon = icon.resize((side, side), Image.LANCZOS)
    on_black = Image.new("RGBA", (side, side), (0, 0, 0, 255))
    on_black.alpha_composite(icon)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(on_black, (0, 0), ios_mask(side))
    return out


def gray_values(im: Image.Image) -> list[int]:
    """把一张单通道图的所有像素值取成列表。

    Pillow 14（2027-10）起 `getdata()` 被弃用，改叫 `get_flattened_data()`；
    为了新老环境都能跑，两个都认一下 —— 不要因为一句 DeprecationWarning
    把好好的脚本改成只能在某一版 Pillow 上跑。
    """
    if hasattr(im, "get_flattened_data"):
        return list(im.get_flattened_data())
    return list(im.getdata())  # Pillow < 11.3


def transparent_inside(icon: Image.Image, side: int) -> float:
    """圆角方之内、**原图是透明**的面积占比 —— 也就是会被 iOS 填黑的那部分。

    ⚠️ 别拿"合成后是不是黑色"来判断：图标自己的底色就是深墨（#2b2a27），
       按颜色判定会把整个图标都算进去（实测得出过离谱的 90%）。
       要判的是**原图的 alpha**。
    """
    small = icon.resize((side, side), Image.LANCZOS)
    alpha = gray_values(small.getchannel("A"))
    inside_mask = gray_values(ios_mask(side))
    inside = sum(1 for v in inside_mask if v > 127)
    clear = sum(1 for a, m in zip(alpha, inside_mask) if m > 127 and a < 128)
    return clear / inside * 100 if inside else 0.0


# 左：**改前**的做法 —— 现场按老参数画一张（内切圆、四角透明），没有再留旧产物文件。
# 右：**改后**的真身 —— 直接读磁盘上要发给 iPhone 的那个文件，不重画。
before = icon_gen.render(icon_gen.APPLE_PX)
after = Image.open(ROOT / "app" / "apple-icon.png").convert("RGBA")

SIDE = 300
before_dark = transparent_inside(before, SIDE)
after_dark = transparent_inside(after, SIDE)
fixed_ok = after_dark < 0.05

# ── 版面 ─────────────────────────────────────────────────────
canvas = Image.new("RGB", (W, 880), BG)
d = ImageDraw.Draw(canvas)

d.text((PAD, 30), "iPhone 装到主屏之后，图标会长什么样", font=f_title, fill=INK)
d.text(
    (PAD, 70),
    "同一张图，安卓和 iPhone 的规矩正好相反 —— 这是 iPhone 那一边的模拟结果",
    font=f_sub,
    fill=INK2,
)

BOX = SIDE + 40
GAP = 150
left_x = (W - (BOX * 2 + GAP)) // 2
top = 122


def draw_panel(x: int, y: int, icon: Image.Image, caption: str, sub: str, bad: bool) -> None:
    """画一块"手机桌面"的台子，把 iOS 裁好的图标贴上去，底下配两行字。"""
    # 桌面底色：故意用浅灰 —— 黑角在浅底上最扎眼
    d.rounded_rectangle([x, y, x + BOX, y + BOX], radius=14, fill=SHELF)
    tile = ios_tile(icon, SIDE)
    canvas.paste(tile, (x + 20, y + 20), tile)

    cy = y + BOX + 16
    d.text((x + BOX // 2, cy), caption, font=f_capb, fill=INK, anchor="ma")
    cy += 24
    d.text((x + BOX // 2, cy), sub, font=f_cap, fill=BAD if bad else OK, anchor="ma")


draw_panel(
    left_x,
    top,
    before,
    "改前：内切圆（四角透明）",
    f"会被填黑：约 {before_dark:.0f}%",
    bad=True,
)
draw_panel(
    left_x + BOX + GAP,
    top,
    after,
    "改后：满幅（现在这张）",
    f"会被填黑：约 {after_dark:.0f}%",
    bad=not fixed_ok,
)

# 中间放一个箭头
ax = left_x + BOX + GAP // 2
d.text((ax, top + BOX // 2 - 20), "→", font=ImageFont.truetype(FB, 46), fill=INK3, anchor="mm")

# ── 结论横幅（这张图的主要用途：一眼看出修没修好）──────────────
y = top + BOX + 62
flag_fill = OK if fixed_ok else BAD
d.rounded_rectangle([PAD, y, W - PAD, y + 44], radius=12, fill=CARD, outline=flag_fill, width=2)
# 别用 ✓ / ★ 这类符号表态：微软雅黑里没有它们的字形，画出来是个方框（豆腐块）。
# 改成"画一个实心圆点" —— 字体里有没有这个符号，就都不影响了。
d.ellipse([PAD + 26, y + 18, PAD + 40, y + 32], fill=flag_fill)
if fixed_ok:
    d.text(
        (PAD + 52, y + 13),
        "已修好：现在这张 apple-icon.png 是满幅的，iPhone 上不会再露黑角。",
        font=f_capb,
        fill=INK,
    )
else:
    d.text(
        (PAD + 52, y + 13),
        f"还没修好：右边这张仍有约 {after_dark:.1f}% 会被填黑 —— 改 gen-app-icon.py 重跑。",
        font=f_capb,
        fill=BAD,
    )

# ── 说明区 ───────────────────────────────────────────────────
y += 68
d.rounded_rectangle([PAD, y, W - PAD, y + 250], radius=14, fill=CARD, outline=LINE, width=1)

d.text((PAD + 26, y + 22), "为什么会这样", font=f_head, fill=INK)

lines = [
    ("iPhone 的规矩：", "不允许透明。它会先画一块圆角方形的底，把图标贴上去，再把透明的地方一律填成黑。"),
    ("改前的那张：", "是一张「内切圆、四个角透明」的图 —— 正好踩在这条上，圆片外面裹了一层纯黑方底。"),
    ("现在怎么改的：", "和安卓那两张满幅图走同一条路：底色铺满整张画布，形状交给 iOS 自己去切圆角。"),
    # ⚠️ 画进图里的文案只用中文字体确实有的字符。实测 ⇔ ⇒ ✓ ★ 这类符号
    #    在微软雅黑里没有字形，PIL 会画成方框（豆腐块）—— 而这一点在代码里完全看不出来。
    ("字为什么没变大：", "字宽仍是 38%。图标在主屏上都会被缩成同样大小的格子，字宽同为 38%，三个平台字一样大。"),
]
cy = y + 56
for head, body in lines:
    d.text((PAD + 26, cy), head, font=f_capb, fill=INK)
    d.text((PAD + 168, cy), body, font=f_note, fill=INK2)
    cy += 26

cy += 8
d.text(
    (PAD + 26, cy),
    "※ 这是按 iOS 规则画的模拟图（圆角按 22.37% 近似），真机才是最终判据。",
    font=f_small,
    fill=WARN,
)
cy += 22
d.text(
    (PAD + 26, cy),
    "装的时候在「添加到主屏幕」的预览框里就能看到 —— 拍下来发我。",
    font=f_small,
    fill=INK3,
)
cy += 30
d.text((PAD + 26, cy), "注意：", font=f_capb, fill=INK)
d.text(
    (PAD + 90, cy),
    "iOS 会缓存主屏图标。换过图标之后要重装才看得到新的 —— 先把桌面上的旧图标删掉再添加。",
    font=f_note,
    fill=INK2,
)

canvas.save(OUT)
print(f"已生成 {OUT.name}")
print(f"  改前（内切圆）：被填黑约 {before_dark:.1f}%")
print(f"  改后（满幅）：  被填黑约 {after_dark:.1f}%")
print(f"  结论：{'已修好 ✅' if fixed_ok else '★ 还没修好'}")
