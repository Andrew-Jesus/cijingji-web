import { describe, expect, it } from "vitest";

import { BALL_PX } from "@/lib/console/dock";
import type { Notice } from "@/lib/console/notices";

import {
  BANNER_EDGE_PX,
  BANNER_HOLD_MS,
  BANNER_H_PX,
  BANNER_MAX_W_PX,
  BANNER_WIDTH_CSS,
  CARD_EDGE_PX,
  CARD_WIDTH_CSS,
  CARD_W_PX,
  CONTENT_DELAY_MS,
  CONTENT_SLIDE_PX,
  DOT_FRAME_PX,
  DOT_PX,
  ISLAND_W_PX,
  LIVE_HOLD_MS,
  MIN_HIT_PX,
  SHEEN_MS,
  SQUASH_MS,
  SQUASH_SCALE,
  THICKNESS_PX,
  bannerNotice,
  bannerWidth,
  cardWidth,
  contentFadeStyle,
  islandBox,
  islandForm,
  islandHeight,
  islandRank,
  islandShape,
  isStretching,
  motionMode,
  radiusFor,
  shouldSpeak,
} from "./form";

/** 造一条动态。只需要 id / level / key，其余随便填 */
function notice(partial: Partial<Notice> & { id: string }): Notice {
  return {
    level: "info",
    title: "测试用",
    at: "2026-09-26T12:00:00.000Z",
    ...partial,
  };
}

const BASE = {
  presentation: "full",
  tucked: false,
  open: false,
  speaking: false,
  live: false,
} as const;

/** 非 dot 的三档 —— "厚度恒定"那条硬规则管的就是它们 */
const THICK_SHAPES = ["ball", "island", "banner"] as const;

describe("islandForm —— 该长什么样", () => {
  it("日常待命是那颗**正圆球**", () => {
    // 2026-09-30 Andy 定的：回到最初那颗球。
    // 它比原来那条 164 宽的胶囊窄得多 —— 这就是"不挡字"最实在的一招。
    expect(islandForm({ ...BASE })).toBe("ball");
  });

  it("你点开了 → 卡片（面板）", () => {
    expect(islandForm({ ...BASE, open: true })).toBe("card");
  });

  it("你收起了它 → 小点，哪怕它正有话要说", () => {
    expect(islandForm({ ...BASE, tucked: true })).toBe("dot");
    expect(islandForm({ ...BASE, tucked: true, speaking: true })).toBe("dot");
  });

  it("引导前半段 → 小点（真实渲染里根本不出现，这里只要求答案确定）", () => {
    expect(islandForm({ ...BASE, presentation: "hidden" })).toBe("dot");
    expect(islandForm({ ...BASE, presentation: "hidden", speaking: true })).toBe("dot");
  });

  it("★ 背词进行中 → **仍然是那颗球**（2026-09-30 改，以前是小点）", () => {
    // 改的理由：球现在只有 44px、又缩在角落，本来就不挡字；
    // 而背词恰恰是它被用得最多的时候 —— 那时候反而缩没，
    // 等于"球"这个形态在**主场景**里根本不存在。
    // "少一点打扰"改由 ConsoleDock 把它淡到 70% 不透明来给。
    expect(islandForm({ ...BASE, presentation: "mini" })).toBe("ball");
    // 横幅在背词时仍然一个字不说（老规矩：专注时闭嘴）——
    // 该不该在背词页小声提示，属于 I2 的场景表。
    expect(islandForm({ ...BASE, presentation: "mini", speaking: true })).toBe("ball");
  });

  it("★ 背词进行中 + 有件正在跑的事 → 拉长成岛（进度压过 mini）", () => {
    // 2026-09-26 Andy 点头定的。理由：`mini` 当初是为了"别被**横幅**打断"，
    // 而岛不是打断 —— 它是一条不吵的进度，正好呼应"你正在背、还剩多少"。
    // ⚠️ 若不这么做，岛档永远看不到：进度跳一格只发生在背词时。
    expect(islandForm({ ...BASE, presentation: "mini", live: true })).toBe("island");
  });

  it("有件正在跑的事 → 拉长成岛", () => {
    expect(islandForm({ ...BASE, live: true })).toBe("island");
  });

  it("有话要说 → 横幅", () => {
    expect(islandForm({ ...BASE, speaking: true })).toBe("banner");
  });

  it("★ 不在背词页时：提醒压过进度（断网了就先报断网）", () => {
    expect(islandForm({ ...BASE, speaking: true, live: true })).toBe("banner");
  });

  it("优先级：卡片 ＞ 收起 ＞ 页面隐藏 ＞（背词 / 提醒 / 进度）＞ 常驻", () => {
    // 一次把输入全打开，答案只能是优先级最高的那个
    expect(
      islandForm({ presentation: "mini", tucked: true, open: true, speaking: true, live: true }),
    ).toBe("card");
    expect(
      islandForm({ presentation: "mini", tucked: true, open: false, speaking: true, live: true }),
    ).toBe("dot");
    expect(
      islandForm({ presentation: "hidden", tucked: false, open: false, speaking: true, live: true }),
    ).toBe("dot");
    // 背词 + 进度 → 岛（而不是球）
    expect(
      islandForm({ presentation: "mini", tucked: false, open: false, speaking: false, live: true }),
    ).toBe("island");
    // 背词 + 提醒（没进度）→ 仍是球，一个字不说
    expect(
      islandForm({ presentation: "mini", tucked: false, open: false, speaking: true, live: false }),
    ).toBe("ball");
    // 不在专注页：提醒赢
    expect(
      islandForm({ presentation: "full", tucked: false, open: false, speaking: true, live: true }),
    ).toBe("banner");
  });
});

describe("islandShape —— 卡片不是岛的材料", () => {
  it("面板开着时，岛本身还是那颗球（它是面板的把手，不跟着变形）", () => {
    expect(islandShape("card")).toBe("ball");
  });

  it("其余各档原样透传", () => {
    expect(islandShape("dot")).toBe("dot");
    expect(islandShape("ball")).toBe("ball");
    expect(islandShape("island")).toBe("island");
    expect(islandShape("banner")).toBe("banner");
  });
});

/** 从 `44px` 这种 CSS 长度里取数值。Banner 档是 `min(...)`，取不到，另用 bannerWidth() 验 */
function px(value: string): number {
  return Number.parseFloat(value);
}

describe("★ 厚度恒定 —— 「球 ⇄ 岛 是同一块材料」的数学底子", () => {
  /*
    这一组是 2026-09-30 立的**核心不变量**，也是那一次改造的全部理由。

    改造前各档厚度是 44 / 48 / 58：拉长的时候**又长又胖**，
    眼睛读到的是"变大了 / 换了个东西"，不是"被拉开"。
    钉死厚度之后，圆角恒为 22，形变里**只有宽度在动** ——
    正圆成了"长度恰好等于厚度"的那一档，岛就是同一根东西被拉开。
  */

  it("三档（球 / 岛 / 横幅）的厚度**一模一样**", () => {
    const heights = THICK_SHAPES.map((shape) => islandBox(shape).matH);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(`${THICKNESS_PX}px`);
  });

  it("圆角因此在整场形变里是个**常量**", () => {
    const radii = THICK_SHAPES.map((shape) => islandBox(shape).radius);
    expect(new Set(radii).size).toBe(1);
    expect(radii[0]).toBe(`${radiusFor(THICKNESS_PX)}px`);
  });

  it("于是形变中真正会变的只有**宽度**这一个属性", () => {
    const widths = THICK_SHAPES.map((shape) => islandBox(shape).matW);
    expect(new Set(widths).size).toBe(THICK_SHAPES.length);
  });

  it("★ 球是**正圆**：宽 = 高 = 厚度", () => {
    const box = islandBox("ball");
    expect(box.matW).toBe(box.matH);
    expect(px(box.matW)).toBe(THICKNESS_PX);
    // 正圆 = 圆角恰好是半径
    expect(box.radius).toBe(`${THICKNESS_PX / 2}px`);
  });

  it("球就是改造前那颗球 —— 尺寸一像素都没挪（防漂移）", () => {
    // `BALL_PX` 在 `lib/console/dock.ts`，是改造前那颗悬浮球的直径。
    // 谁哪天动了它，这里会立刻红 —— 那时必须回头重看文件头那条硬规则。
    expect(THICKNESS_PX).toBe(BALL_PX);
    expect(DOT_FRAME_PX).toBe(BALL_PX);
    expect(BANNER_H_PX).toBe(BALL_PX);
  });

  it("只有 dot 一档厚度不同 —— 写成一个三元表达式，就是为了让破坏规则要改函数体", () => {
    expect(islandHeight("dot")).toBe(DOT_PX);
    expect(islandHeight("ball")).toBe(THICKNESS_PX);
    expect(islandHeight("island")).toBe(THICKNESS_PX);
    expect(islandHeight("banner")).toBe(THICKNESS_PX);
  });
});

describe("radiusFor", () => {
  it("圆角永远等于高的一半 —— 正圆和胶囊都是它算出来的", () => {
    expect(radiusFor(THICKNESS_PX)).toBe(THICKNESS_PX / 2);
    expect(radiusFor(DOT_PX)).toBe(DOT_PX / 2);
    // 16 的圆：半径 8 —— 它就是个正圆，不是"小方块"
    expect(radiusFor(DOT_PX) * 2).toBe(DOT_PX);
    // 44 的球：半径 22 —— 所以球档的"圆角"其实是在把它切成一个正圆
    expect(radiusFor(THICKNESS_PX) * 2).toBe(THICKNESS_PX);
  });
});

describe("islandBox —— 每一档的完整几何", () => {
  const VIEWPORTS = [320, 360, 390, 414, 768, 1280];

  it("Dot 档：看得见 16，点得到 44，所以热区每边外扩 14", () => {
    const box = islandBox("dot");
    expect(box.matW).toBe(`${DOT_PX}px`);
    expect(box.matH).toBe(`${DOT_PX}px`);
    expect(box.hitW).toBe(`${DOT_FRAME_PX}px`);
    expect(box.hitH).toBe(`${DOT_FRAME_PX}px`);
    expect(box.radius).toBe(`${radiusFor(DOT_PX)}px`);
    expect(box.hitInset).toBe((DOT_FRAME_PX - DOT_PX) / 2);
  });

  it("球档：热区与材料一样大（这一档没有「隐形扩边」）", () => {
    const box = islandBox("ball");
    expect(box.hitW).toBe(box.matW);
    expect(box.hitH).toBe(box.matH);
    expect(box.hitInset).toBe(0);
    expect(px(box.hitW)).toBe(THICKNESS_PX);
  });

  it("岛档：固定 240 宽的一枚长球 —— **不拉满屏**", () => {
    const box = islandBox("island");
    expect(box.hitW).toBe(`${ISLAND_W_PX}px`);
    expect(box.matW).toBe(`${ISLAND_W_PX}px`);
    expect(box.hitH).toBe(`${THICKNESS_PX}px`);
    expect(box.matH).toBe(`${THICKNESS_PX}px`);
    expect(box.radius).toBe(`${radiusFor(THICKNESS_PX)}px`);
    expect(box.hitInset).toBe(0);
  });

  it("★ 岛必须比满屏横幅窄 —— 这就是它「不压迫」的物理保证", () => {
    // 苹果那边常驻的 Live Activity 也是这样：一枚小胶囊，不是一块巨幕。
    // 谁哪天把 ISLAND_W_PX 调到跟横幅一样宽，这里会立刻红。
    expect(ISLAND_W_PX).toBeLessThan(BANNER_MAX_W_PX);
    expect(ISLAND_W_PX).toBeLessThanOrEqual(320);
  });

  it("Banner 档：宽度交给浏览器算 min()，不缩进", () => {
    const box = islandBox("banner");
    expect(box.hitW).toBe(BANNER_WIDTH_CSS);
    expect(box.matW).toBe(BANNER_WIDTH_CSS);
    expect(box.hitH).toBe(`${BANNER_H_PX}px`);
    expect(box.radius).toBe(`${radiusFor(BANNER_H_PX)}px`);
    expect(box.hitInset).toBe(0);
  });

  it("★ 可点范围从不小于 44 —— Dot 也不例外", () => {
    for (const shape of ["dot", "ball", "island"] as const) {
      const box = islandBox(shape);
      // 材料 + 两侧外扩 = 真实可点范围
      expect(px(box.matW) + box.hitInset * 2).toBeGreaterThanOrEqual(MIN_HIT_PX);
      expect(px(box.matH) + box.hitInset * 2).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }
    for (const viewportW of VIEWPORTS) {
      expect(bannerWidth(viewportW)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }
  });

  it("★ 在任何真实屏幕上都不比屏幕宽，也不顶到边（否则横向溢出）", () => {
    const ballW = px(islandBox("ball").hitW);
    const islandW = px(islandBox("island").hitW);
    for (const viewportW of VIEWPORTS) {
      expect(bannerWidth(viewportW)).toBeLessThanOrEqual(viewportW);
      // 球 / 岛贴在左右任一边：宽度 + 两侧留白，必须装得下
      expect(ballW + CARD_EDGE_PX * 2).toBeLessThanOrEqual(viewportW);
      expect(islandW + CARD_EDGE_PX * 2).toBeLessThanOrEqual(viewportW);
    }
  });

  it("islandHeight 必须能跟几何盒子对上 —— 两处各写一遍就会飘", () => {
    for (const shape of ["dot", "ball", "island", "banner"] as const) {
      expect(`${islandHeight(shape)}px`).toBe(islandBox(shape).matH);
    }
  });
});

describe("宽度算式：数值版与 CSS 版必须一致", () => {
  it("banner", () => {
    expect(BANNER_WIDTH_CSS).toContain(`${BANNER_EDGE_PX * 2}px`);
    expect(BANNER_WIDTH_CSS).toContain(`${BANNER_MAX_W_PX}px`);
    expect(bannerWidth(320)).toBe(320 - BANNER_EDGE_PX * 2);
    expect(bannerWidth(1280)).toBe(BANNER_MAX_W_PX);
  });

  it("card", () => {
    expect(CARD_WIDTH_CSS).toContain(`${CARD_W_PX}px`);
    expect(CARD_WIDTH_CSS).toContain(`${CARD_EDGE_PX * 2}px`);
    // 面板在 320 的窄屏上要缩到 280，不许横向溢出
    expect(cardWidth(320)).toBe(320 - CARD_EDGE_PX * 2);
    expect(cardWidth(390)).toBe(CARD_W_PX);
  });
});

describe("motionMode —— 降级不是「慢一点」，是「不演」", () => {
  it("正常：形变 240ms，内容等形变过半再淡入", () => {
    const mode = motionMode(false);
    expect(mode.material).toContain("var(--duration-slow)");
    // 悬停放大也走同一条过渡，只动 transform
    expect(mode.material).toContain("opacity");
    expect(mode.material).toContain("transform");
    expect(mode.contentDelayMs).toBe(CONTENT_DELAY_MS);
  });

  it("降级：材料块整个不演，内容也不等，收细与银光都不演", () => {
    expect(motionMode(true)).toEqual({
      material: "none",
      contentDelayMs: 0,
      squash: false,
      sheen: false,
    });
  });

  it("正常：中段收细和银光扫过都是要演的", () => {
    expect(motionMode(false).squash).toBe(true);
    expect(motionMode(false).sheen).toBe(true);
  });

  it("内容延迟必须落在形变过程之内 —— 早了看到糊字，晚了像卡住", () => {
    // 240 是 --duration-slow（globals.css）。写成字面量是故意的：
    // 这里要断言的是"延迟必须小于总时长"，而不是再抄一遍那个变量。
    expect(CONTENT_DELAY_MS).toBeGreaterThan(0);
    expect(CONTENT_DELAY_MS).toBeLessThan(240);
  });
});

describe("contentFadeStyle —— 出得快、进得慢，而且从锚点那侧滑出来", () => {
  const LEFT = -CONTENT_SLIDE_PX;

  it("出现：延迟等形变过半", () => {
    expect(contentFadeStyle(true, CONTENT_DELAY_MS, LEFT).opacity).toBe(1);
    expect(contentFadeStyle(true, CONTENT_DELAY_MS, LEFT).transitionDelay).toBe(
      `${CONTENT_DELAY_MS}ms`,
    );
  });

  it("消失：不给延迟，立刻让开 —— 原则是「内容先走，形状再收」", () => {
    expect(contentFadeStyle(false, CONTENT_DELAY_MS, LEFT).opacity).toBe(0);
    expect(contentFadeStyle(false, CONTENT_DELAY_MS, LEFT).transitionDelay).toBe("0ms");
  });

  it("★ 出现时从锚点那侧滑进来（起点偏一点、终点归零）", () => {
    // 直接原地浮现的话，看起来像"两个零件在交替"；滑一下才像同一块材料在长。
    const showing = contentFadeStyle(true, CONTENT_DELAY_MS, LEFT);
    const hiding = contentFadeStyle(false, CONTENT_DELAY_MS, LEFT);
    expect(showing.transform).toBe("none");
    expect(hiding.transform).toBe(`translateX(${LEFT}px)`);
  });

  it("★ 滑出方向跟着贴哪一边走", () => {
    expect(contentFadeStyle(false, 0, CONTENT_SLIDE_PX).transform).toBe(
      `translateX(${CONTENT_SLIDE_PX}px)`,
    );
  });

  it("两个属性必须一起过渡 —— 只写 opacity 的话位移会瞬移", () => {
    const style = contentFadeStyle(true, CONTENT_DELAY_MS, LEFT);
    expect(style.transitionProperty).toContain("opacity");
    expect(style.transitionProperty).toContain("transform");
  });
});

describe("islandRank / isStretching —— 这一步是在拉长还是在缩回来", () => {
  it("次序：小点 ＜ 球 ＜ 岛 ＜ 横幅", () => {
    expect(islandRank("dot")).toBeLessThan(islandRank("ball"));
    expect(islandRank("ball")).toBeLessThan(islandRank("island"));
    expect(islandRank("island")).toBeLessThan(islandRank("banner"));
  });

  it("★ 球 → 岛 就是「被拉长」（收细与银光都只在这时候演）", () => {
    expect(isStretching("ball", "island")).toBe(true);
    expect(isStretching("ball", "banner")).toBe(true);
    expect(isStretching("dot", "ball")).toBe(true);
    expect(isStretching("island", "ball")).toBe(false);
    expect(isStretching("banner", "island")).toBe(false);
    expect(isStretching("ball", "ball")).toBe(false);
  });
});

describe("拉长手感的那几个数", () => {
  it("中段收细是「看得见但不像打哆嗦」的一点点", () => {
    expect(SQUASH_SCALE).toBeLessThan(1);
    expect(SQUASH_SCALE).toBeGreaterThanOrEqual(0.94);
  });

  it("收细的总时长比形变（240ms）略长 —— 得等形变差不多到位才收回来", () => {
    // 240 是 --duration-slow（globals.css）。写成字面量是故意的：
    // 这里要断言的是"比它长"，而不是再抄一遍那个变量。
    expect(SQUASH_MS).toBeGreaterThan(240);
    expect(SQUASH_MS).toBeLessThan(500);
  });

  it("★ 银光比形变长、比收细长，但不能拖到让人等它", () => {
    expect(SHEEN_MS).toBeGreaterThan(240);
    expect(SHEEN_MS).toBeGreaterThan(SQUASH_MS);
    expect(SHEEN_MS).toBeLessThan(1000);
  });

  it("内容滑出的幅度要小 —— 大了就成「飘进来」", () => {
    expect(CONTENT_SLIDE_PX).toBeGreaterThan(0);
    expect(CONTENT_SLIDE_PX).toBeLessThanOrEqual(16);
  });

  it("Live 的静默期落在 8~20 秒 —— 太短等于没报，太长等于赖着", () => {
    expect(LIVE_HOLD_MS).toBeGreaterThanOrEqual(8000);
    expect(LIVE_HOLD_MS).toBeLessThanOrEqual(20000);
    // 它必须比横幅那 5.6 秒长：横幅是"提个醒"，Live 是"跟着任务走"
    expect(LIVE_HOLD_MS).toBeGreaterThan(BANNER_HOLD_MS);
  });
});

describe("shouldSpeak —— 哪条动态值得登台说一句", () => {
  it("警告 / 危险要说 —— 不说用户会以为坏了", () => {
    expect(shouldSpeak(notice({ id: "1", level: "warning" }))).toBe(true);
    expect(shouldSpeak(notice({ id: "2", level: "danger" }))).toBe(true);
  });

  it("开机播报要说 —— 那是「它活了」的第一印象", () => {
    expect(shouldSpeak(notice({ id: "3", level: "success", key: "boot" }))).toBe(true);
  });

  it("其余安静躺着 —— 宁可少说", () => {
    expect(shouldSpeak(notice({ id: "4", level: "success" }))).toBe(false);
    expect(shouldSpeak(notice({ id: "5", level: "info" }))).toBe(false);
    // 「网络回来了」是 success，按规则不说 —— I1 刻意这么窄
    expect(shouldSpeak(notice({ id: "6", level: "success", key: "net" }))).toBe(false);
  });
});

describe("bannerNotice —— 一次只说一句", () => {
  const warning = notice({ id: "w1", level: "warning", title: "现在没网" });
  const quiet = notice({ id: "q1", level: "info", title: "复制成功" });

  it("最新一条值得说的，就是它要说的那句", () => {
    expect(bannerNotice([warning, quiet], null)).toBe(warning);
  });

  it("最新一条不值得说，就闭嘴 —— 不往回找旧的", () => {
    // 「复制成功」压在最上面时不该把下面那条警告重新翻出来说一遍
    expect(bannerNotice([quiet, warning], null)).toBeNull();
  });

  it("被划走的就不再冒出来", () => {
    expect(bannerNotice([warning], "w1")).toBeNull();
  });

  it("没有动态就不说话", () => {
    expect(bannerNotice([], null)).toBeNull();
  });
});

describe("时间常量", () => {
  it("横幅停留 4~6 秒 —— 说完就走", () => {
    expect(BANNER_HOLD_MS).toBeGreaterThanOrEqual(4000);
    expect(BANNER_HOLD_MS).toBeLessThanOrEqual(6000);
  });
});
