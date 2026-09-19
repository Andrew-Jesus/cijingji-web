"""app/ 图标单源生成脚本 —— 圆形墨底银字「词」字标

────────────────────────────────────────────────────────────
为什么要有个脚本，而不是直接给一张手做的图：

图标是**生成物，不是手改的资源**。以后换色板、换字号、换字形，
改这里重跑一次即可；手改 PNG 的话，下次换色板就会出现
"界面是新颜色、图标还是旧颜色"的脱节。
（小程序那边的 Tab 图标用的是同一套规矩：单源 pipeline。）

────────────────────────────────────────────────────────────
产物（都放 app/，Next.js 按文件名约定自动生成 <link rel="icon">）：

    icon.png        512×512        现代浏览器 / PWA 高清
    apple-icon.png  180×180        iOS「添加到主屏幕」
    favicon.ico     32/48/64/128   浏览器标签页 / 老浏览器

为什么 favicon.ico 里**没有 16px 档**（Andy 2026-09-19 决定不提供）：
16px 下「词」只有 16×16 个像素点，7 画汉字挤进去必然粘连。实测并排比过
三种做法（专门档 / 48→16 LANCZOS / 48→16 BOX）：**三种都糊，且"专门档"
糊得最凶** —— 因为它为了撑开结构把字号放大到 62%，笔画粘成一块白斑。
反倒是**不提供 16 档、由浏览器把 48 档缩下来**，笔画层次更分明。
所以这里的取舍是：与其给一个更糟的小图，不如不给。

跑法（用隔离环境里的 python，别用系统 python）：

    "C:/Users/wangh/.workbuddy/binaries/python/envs/default/Scripts/python.exe" scripts/gen-app-icon.py

依赖：Pillow（已装在上述隔离环境里）。

────────────────────────────────────────────────────────────
设计语言（Andy 2026-09-19 指定：参考 Next.js 默认图标的做法，字改银色、要立体感）

起点是 Next.js 那个图标的几点：**纯深色实心圆 + 几何笔画、等宽、平切端点、高对比，
并且笔画自带一道由实到虚的渐隐**。本脚本沿用它，再往"金属浮雕"推了一步。

**别随手改回去的地方：**

1. **形状是圆，不是圆角方形。** 圆 + 深底 + 亮字是这套语言的核心；
   换圆角方形会立刻变成"普通 App 图标"，科技感就没了。

2. **底色是暖黑，不是纯黑 #000。**
   纯黑是 Next 自己的品牌色；本产品整页是暖调，纯黑上去会显得"外来的冷块"。
   注意现在底色不是一块平色了：左上偏亮、右下偏暗（见第 10 条的打光），
   平均值仍落在 #2b2a27 附近，整体牌面没变。

3. **字形用微软雅黑粗体，不用黑体（SimHei）。**
   实测：黑体笔画偏细，在深底上发灰、发单薄；雅黑粗体笔画饱满，字够"实"。

4. **字号分两档，且都比直觉更小。**
   大图用 38% —— 四周留白要够，字才是"标"而不是"糊满圆的一块亮斑"。
   亮字在深底上本身视觉膨胀，看着比实际大，所以每次都觉得偏大要再收一点。
   （45% 那版 Andy 2026-09-19 反馈"偏大"，就是这条在起作用。）
   ≤32px 用 62% —— 32px 是 favicon 最常用的档，按大图比例缩下去
   「词」会糊成一团，只能靠"更满"把结构撑出来。
   实测：32px 用 62% 比"64 档缩下来"清楚得多，所以这一档必须专门渲染。
   （16px 是另一回事 —— 那是物理极限，已经彻底不做了，见文件头。）

5. **渐隐按"字形墨迹框的对角线"归一化，不按整张画布。**
   这样换字号、换字时，"从字的几成处开始淡"是恒定的，不用跟着调参。
   若按画布算，字一小，渐隐就整段跑到字外面去了，白做。

6. **所有"细节"都随尺寸连续爬坡，不是硬分档（见 DETAIL_RAMP）。**
   小图上再往右下降透明度、再加斜面，等于直接抹掉笔画。
   所以：爬坡下端 0（干净、亮、能认出），上端 1（上满细节）。
   爬坡同时管三件事：渐隐、银色渐变、斜面。
   注意爬坡区间的下端 16 只是"理论零点"：实际最小产物是 32px（k≈⅓，带一点细节），
   再小就不做了（见文件头）。

7. **居中按"实际落墨范围"算，不按字体自报的 metrics。**
   后者与真正落墨位置能差 10px（512 画布上肉眼可见偏）。

8. **`.ico` 是自己拼的，没用 Pillow 的 `sizes=` 参数。**
   Pillow 存 ICO 时是"拿同一张源图往下缩"，那样 32px 那档用的还是
   大图比例，上面第 4 条的按尺寸分档、第 6 条的细节爬坡就全都白做了。
   所以这里给每一档单独渲染（render(32)、render(48)…），再按 ICO
   格式把 PNG 拼进一个文件。

9. **字是"银"，不是"白"。**
   填充用竖直方向的缎面银渐变（上亮下暗），不是纯白平涂。
   纯白在深底上是"贴纸"；有了明暗层次，它才像一块金属。
   反过来，小尺寸又必须退回近乎平的亮银 —— 见第 6 条。

10. **立体感来自"一套自洽的打光"，不是效果堆叠。**
    光源固定在左上（`DISC_LIGHT_AT`），于是三件事必须彼此一致：
      底盘：左上亮、右下暗（径向柔光）+ 贴边一道细高光
      笔画：左上沿亮、右下沿暗（斜面 / 倒角）
      字形：右下角继续化开（渐隐）
    只要光向统一，每处都很轻也能"立"起来；
    反过来，效果再多、光向打架，看着就是脏。

11. **斜面宽度按"字形墨迹的短边"取比例，不按画布。**
    这样换字号、换字都不用重调；而且它会自动随尺寸缩小，
    512px 上约 2~3px（看得见的倒角），32px 上不到半像素（自然消失）。
    这是有意为之：小图标不该有倒角，那是给大尺寸看的细节。
"""

import io
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# ── 造型参数（要调就调这几个）─────────────────────────────────
GLYPH = "词"  # 单字标。换字注意：笔画比「词」更密的字（如「径」）在小尺寸下会糊
SHAPE = "circle"  # "circle" = 参考 Next 的做法；"squircle" = 圆角方形（备用）
CORNER_RATIO = 0.225  # 仅 SHAPE="squircle" 时生效
GLYPH_RATIO = 0.38  # 墨迹宽占画布比例（大尺寸）
GLYPH_RATIO_SMALL = 0.62  # 同上，小尺寸专用 —— 见上文第 4 条
SMALL_MAX = 32  # 小于等于这个尺寸算"小图"
OPTICAL_SHIFT = -0.004  # 光学修正：中文字下部笔画偏重，几何居中后略上移才"看着正"
SUPERSAMPLE = 4  # 超采样倍数：先画大图再缩，边缘才平滑（不缩会看到锯齿）

# ── 细节强度爬坡（渐隐 / 银色渐变 / 斜面 共用）────────────────
# 0 = 不上细节（小图：要干净、要亮、要认得出）
# 1 = 满细节（大图：要质感、要立体）
DETAIL_RAMP = (16, 64)  # 强度 0 → 1 对应的尺寸区间

# ── 打光（光源固定在左上，全局统一 —— 见上文第 10 条）─────────
DISC_LIGHT_AT = (0.33, 0.29)  # 底盘受光点（相对画布）。改了它，斜面方向也得跟着改
DISC_LIGHT = (57, 55, 50)  # 底盘受光处（暖灰，比原 #2b2a27 略亮）
DISC_DARK = (27, 26, 24)  # 底盘背光处（暖黑，比原色略暗）
DISC_FALLOFF = 1.45  # 径向衰减增益：越大，四周压得越暗（1.0 = 只到 68% 就停）
DISC_RIM = (70, 66, 59)  # 贴着圆周的一圈细高光（金属片倒角的感觉）
#   并排比过四档（无环 / 62 / 70 / 80）：80 那版一眼就是"给圆描了条边框"，
#   无环又太平、像个贴纸。70 是"看得出盘边被光扫到、但不会看成线条"的位置。
DISC_RIM_W = 0.008  # 圈宽（占画布比例）
DISC_RIM_FADE = 0.45  # 圈高光沿对角线的衰减指数：**必须 < 1**
#   实测（γ=1.1 那版）：整圈都亮，左右两侧也有 75，看着像"描了一圈边框"。
#   圈高光是"光扫过圆边留下的一道" —— 只有左上那一段该亮，
#   过了侧面就该基本没了，所以衰减要前陡后缓（指数 < 1）。

# ── 银色填充（竖直渐变，位置 = 从字形墨迹框顶部算起的比例）─────
# 横向对比过三档（平银 / 中间 / 强对比）：**平了就不像金属，只有拉开明暗才"银"**。
# 具体数值以 512px 为准调；小尺寸会自动退回 SILVER_FLAT（见上文第 6 条）。
SILVER_STOPS = [
    (0.00, (252, 254, 255)),
    (0.34, (200, 207, 216)),
    (0.68, (154, 162, 172)),
    (1.00, (114, 121, 130)),
]
SILVER_FLAT = (235, 238, 241)  # 强度 0（小图）时退化成近乎平的亮银

# ── 斜面（倒角）：左上受光、右下背光 ──────────────────────────
# 实测（见上文第 11 条的对照）：0.013 偏重、像 WordArt 的凸字；
# 0.007 太轻、看着还是平贴。0.010 是"看得出倒角但不抢戏"的位置。
BEVEL_DEPTH = 0.010  # 斜面宽度占"字形墨迹短边"的比例
BEVEL_MIN = 2  # 小于这个像素宽度就不做斜面（超采样坐标下）
BEVEL_LIGHT = (255, 255, 255)
BEVEL_DARK = (72, 76, 82)

# ── 渐隐（参考 Next.js「N」：左上实、右下淡）──────────────────
FADE_START = 0.55  # 满强度：从墨迹框对角线的几成处开始淡（1.0 = 一直不淡）
FADE_FLOOR = 0.05  # 满强度：右下角最低保留多少不透明度
FADE_GAMMA = 1.7  # >1 = 前段"多撑一会儿"、后段收得更快。
#                   线性（=1）会让字的中段糊成一片均匀的灰，看着像打了高光，
#                   而不是"淡出"。

# ── 颜色 ──────────────────────────────────────────────────────
ICON_BG = "#2b2a27"  # 底盘的平均色，仅供 SHAPE="squircle" 兜底与文档表述

# ── 字体：微软雅黑粗体优先（见上文第 3 条）────────────────────
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\Deng.ttf",
]


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit(
        "找不到任何中文字体，请把可用字体路径加进 FONT_CANDIDATES：\n  "
        + "\n  ".join(FONT_CANDIDATES)
    )


def ink_box(mask: Image.Image) -> tuple[int, int, int, int]:
    """取墨迹外框。空图时 getbbox() 返回 None，这里明确报错而不是静默出错图。"""
    box = mask.getbbox()
    if box is None:
        raise SystemExit("字形渲染为空，检查 GLYPH 与字体是否正常")
    return box  # type: ignore[return-value]


def glyph_mask(s: int, font: ImageFont.FreeTypeFont, at: tuple[float, float]) -> Image.Image:
    layer = Image.new("L", (s, s), 0)
    ImageDraw.Draw(layer).text(at, GLYPH, font=font, fill=255)
    return layer


def lerp_color(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))  # type: ignore[return-value]


def ramp_color(stops: list[tuple[float, tuple[int, ...]]], t: float) -> tuple[int, ...]:
    """在多档色标之间取色。t 是 0..1 的位置。"""
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        if t <= p1:
            return lerp_color(c0, c1, (t - p0) / max(1e-6, p1 - p0))
    return stops[-1][1]


# ── 细节强度 ──────────────────────────────────────────────────

def detail_strength(size: int) -> float:
    """这个尺寸该上几成细节：0 = 干净亮银，1 = 满强度金属浮雕。"""
    lo, hi = DETAIL_RAMP
    return min(1.0, max(0.0, (size - lo) / (hi - lo)))


def mix(full: float, k: float) -> float:
    """把满强度参数按 k 向"完全不淡"(= 1.0) 插值。

    k = 0 时 start 会变成 1.0，而 fade_curve 在 u ≤ 1.0 时恒返回 1.0，
    于是"不淡"不需要另写一条分支。
    """
    return 1.0 + (full - 1.0) * k


# ── 渐隐 ──────────────────────────────────────────────────────

def fade_curve(u: float, start: float, floor: float, gamma: float) -> float:
    """把"沿对角线的进度 u"换算成不透明度。u ≤ start 全实，之后降到 floor。"""
    if u <= start:
        return 1.0
    t = ((u - start) / (1.0 - start)) ** gamma
    return max(floor, 1.0 - (1.0 - floor) * t)


def fade_mask(
    s: int,
    box: tuple[int, int, int, int],
    start: float,
    floor: float,
    gamma: float,
) -> Image.Image:
    """对角线渐隐遮罩（L 模式，与画布同尺寸）。

    为什么用仿射变换而不是写两层 for 循环：
    我们需要的不透明度只取决于 x + y（对角线方向），这是**线性**关系，
    而仿射变换能精确表达线性映射。所以先做一条 1px 宽的一维斜坡，
    再用 AFFINE 把它"斜着铺满"整张画布。
    s = 2048 时是 400 万像素，逐像素的 Python 循环会肉眼可见地卡。
    """
    x0, y0, x1, y1 = box
    w = max(1, x1 - x0)
    h = max(1, y1 - y0)
    span = s - 1

    ramp = Image.new("L", (1, s))
    ramp.putdata([round(255 * fade_curve(i / span, start, floor, gamma)) for i in range(s)])

    # 目标：input_y = u * span，其中 u = ½·(x−x0)/w + ½·(y−y0)/h
    # input_x 恒为 0（斜坡只有 1px 宽，横向无需变化）
    data = (
        0,
        0,
        0,
        0.5 * span / w,
        0.5 * span / h,
        -0.5 * span * (x0 / w + y0 / h),
    )
    return ramp.transform((s, s), Image.AFFINE, data, resample=Image.BILINEAR)


# ── 底盘 / 字形填充 / 斜面 ────────────────────────────────────

def shape_mask(s: int) -> Image.Image:
    layer = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(layer)
    if SHAPE == "circle":
        d.ellipse([0, 0, s - 1, s - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * CORNER_RATIO), fill=255)
    return layer


def disc_layer(s: int) -> Image.Image:
    """圆盘本身：径向柔光（左上受光）+ 贴边细高光，返回 RGB。

    径向渐变用 Pillow 自带的 `Image.radial_gradient`，它是 256×256、
    中心 0 → 四角 255 的线性斜坡（实测过：边缘中点 179、四角 254）。
    把它放大到 2s×2s 再按想要的光源位置裁一块 s×s 出来，
    就等于"把光心挪到了画布的某个点"，不用逐像素算距离。
    """
    grad = Image.radial_gradient("L").resize((s * 2, s * 2), Image.BILINEAR)
    # 裁窗的左上角 = 渐变中心 (s,s) 减去"光心在画布内的位置"
    ox = int(s - DISC_LIGHT_AT[0] * s)
    oy = int(s - DISC_LIGHT_AT[1] * s)
    grad = grad.crop((ox, oy, ox + s, oy + s))
    # 增益：裁窗最远处只用到渐变 68% 的量程，乘回去才真的能压到 DISC_DARK
    grad = grad.point(lambda v: min(255, round(v * DISC_FALLOFF)))

    out = Image.composite(
        Image.new("RGB", (s, s), DISC_DARK), Image.new("RGB", (s, s), DISC_LIGHT), grad
    )

    # 贴边细高光：圆环 ∩ "左上亮、右下暗"的对角斜坡
    r = max(1, int(s * DISC_RIM_W))
    inner = Image.new("L", (s, s), 0)
    ImageDraw.Draw(inner).ellipse([r, r, s - 1 - r, s - 1 - r], fill=255)
    ring = ImageChops.subtract(shape_mask(s), inner)
    ring = ImageChops.multiply(ring, fade_mask(s, (0, 0, s, s), 0.0, 0.0, DISC_RIM_FADE))
    # 内侧要软。等宽的硬边看着像"给圆描了一条边框"；
    # 模糊之后再裁回圆内，就变成"光从左上扫过盘边、往内侧散掉"。
    # 裁回圆内是必须的 —— 否则高光会糊到圆外面的浅色背景上，出现一圈脏边。
    ring = ImageChops.multiply(
        ring.filter(ImageFilter.GaussianBlur(max(1, r // 3))), shape_mask(s)
    )
    out.paste(Image.new("RGB", (s, s), DISC_RIM), (0, 0), ring)
    return out


def silver_layer(s: int, ink: tuple[int, int, int, int], k: float) -> Image.Image:
    """字形内的银色填充：竖直方向的缎面金属渐变（见上文第 9 条）。

    为什么是"竖直"而不是跟着光走斜的：斜面高光已经按左上→右下打了光，
    填充再斜着来一根光轴，两套光会打架、看着乱。
    竖直渐变只负责"上亮下暗"这一件事，斜的事交给渐隐去办。
    """
    x0, y0, x1, y1 = ink
    h = max(1, y1 - y0)
    stops = [(p, lerp_color(SILVER_FLAT, c, k)) for p, c in SILVER_STOPS]

    ramp = Image.new("RGB", (1, h))
    ramp.putdata([ramp_color(stops, i / max(1, h - 1)) for i in range(h)])

    layer = Image.new("RGB", (s, s), stops[-1][1])
    layer.paste(ramp.resize((s, h), Image.BILINEAR), (0, y0))
    return layer


def shift(mask: Image.Image, dx: int, dy: int) -> Image.Image:
    """整体平移遮罩。不用 ImageChops.offset —— 那是**环绕**平移，会把字绕回来。"""
    out = Image.new("L", mask.size, 0)
    out.paste(mask, (dx, dy))
    return out


def bevel_masks(mask: Image.Image, d: int) -> tuple[Image.Image, Image.Image]:
    """内侧斜面：左上受光的一圈（light）与右下背光的一圈（shade）。

    原理：把遮罩沿某个方向挪 d 像素，再与原遮罩相减，
    留下的正是"这一侧的内边"—— 挪向右下，留下的是左上边；
    挪向左上，留下的是右下边。比求梯度省事，也不会算出负数。
    """
    light = ImageChops.subtract(mask, shift(mask, d, d))
    shade = ImageChops.subtract(mask, shift(mask, -d, -d))
    blur = ImageFilter.GaussianBlur(max(1, d // 4))
    return light.filter(blur), shade.filter(blur)


def render(size: int) -> Image.Image:
    """画一张 size×size 的图标（内部按 SUPERSAMPLE 倍超采样，最后缩回来）。"""
    s = size * SUPERSAMPLE
    ratio = GLYPH_RATIO_SMALL if size <= SMALL_MAX else GLYPH_RATIO
    k = detail_strength(size)
    start, floor = mix(FADE_START, k), mix(FADE_FLOOR, k)

    # ① 底盘（含柔光与贴边高光）
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(disc_layer(s), (0, 0), shape_mask(s))

    # ② 定字号：先随便给个字号量出墨迹宽度，再按比例缩到目标宽度。
    #    这样换字体也不用重调数字，不会跑版。
    base = load_font(int(s * 0.6))
    box = ink_box(glyph_mask(s, base, (0, 0)))
    font = load_font(max(1, round(base.size * (s * ratio) / (box[2] - box[0]))))

    # ③ 定位置：按**实际落墨范围**的中心对齐画布中心（见上文第 7 条）。
    box = ink_box(glyph_mask(s, font, (0, 0)))
    dx = (s - (box[2] - box[0])) / 2 - box[0]
    dy = (s - (box[3] - box[1])) / 2 - box[1] + s * OPTICAL_SHIFT

    mask = glyph_mask(s, font, (dx, dy))
    ink = ink_box(mask)

    # ④ 银底 + 斜面：先把字本身画成一块"有倒角的金属"
    glyph = silver_layer(s, ink, k)
    d = round(min(ink[2] - ink[0], ink[3] - ink[1]) * BEVEL_DEPTH)
    if d >= BEVEL_MIN:
        light, shade = bevel_masks(mask, d)
        glyph.paste(Image.new("RGB", (s, s), BEVEL_LIGHT), (0, 0), light)
        glyph.paste(Image.new("RGB", (s, s), BEVEL_DARK), (0, 0), shade)

    # ⑤ 落墨 + 渐隐：字形遮罩与"越往右下越透"的对角遮罩相乘，即为最终 alpha
    alpha = ImageChops.multiply(mask, fade_mask(s, ink, start, floor, FADE_GAMMA))
    img.paste(glyph, (0, 0), alpha)

    return img.resize((size, size), Image.LANCZOS)


def save_ico(path: Path, images: list[Image.Image]) -> None:
    """把若干张 PNG 拼成一个 ICO 文件。

    自己拼的原因见文件头第 8 条：Pillow 的 sizes= 是"同一张源图缩多档"，
    做不到"每档单独渲染"。ICO 头结构很简单，一共三块：
        ICONDIR        6 字节：保留位 + 类型(1=图标) + 图片数量
        ICONDIRENTRY   每张 16 字节：宽高 + 色深 + 数据长度 + 数据偏移
        数据区          各张 PNG 的字节流（Vista 起支持内嵌 PNG）
    宽/高写 0 表示 256（一个字节装不下 256）。
    """
    blobs: list[bytes] = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)

    entries = b""
    for im, blob in zip(images, blobs):
        side = im.size[0]
        dim = 0 if side >= 256 else side
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset
        )
        offset += len(blob)

    path.write_bytes(header + entries + b"".join(blobs))


def main() -> None:
    APP.mkdir(exist_ok=True)

    render(512).save(APP / "icon.png")
    print("icon.png        512×512")

    render(180).save(APP / "apple-icon.png")
    print("apple-icon.png  180×180")

    # 为什么不放 16：见文件头（实测三种做法全糊，不给反而更好看）。
    # 128 是给高 DPI 标签页 / 书签栏大图标用的；再大（256）在 favicon 场景
    # 用不到，只会白涨体积 —— PWA 那边有 512 的 icon.png 兜着。
    ico_sizes = [32, 48, 64, 128]
    save_ico(APP / "favicon.ico", [render(n) for n in ico_sizes])
    print("favicon.ico     " + " / ".join(str(n) for n in ico_sizes))

    print(
        f"\n字形「{GLYPH}」 · {SHAPE} · {ICON_BG} 底 + 银字"
        f" · 字宽 {GLYPH_RATIO:.0%}（≤{SMALL_MAX}px 用 {GLYPH_RATIO_SMALL:.0%}）"
        f" · 渐隐 {FADE_START:.0%}→{FADE_FLOOR:.0%}（γ{FADE_GAMMA}）"
        f" · 细节爬坡 {DETAIL_RAMP[0]}px→{DETAIL_RAMP[1]}px"
        f" · 光心 {DISC_LIGHT_AT[0]:.0%},{DISC_LIGHT_AT[1]:.0%}"
    )
    print("改造型/配色请改本脚本后重跑，不要手改 PNG。")


if __name__ == "__main__":
    main()
