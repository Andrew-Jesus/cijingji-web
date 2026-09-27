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
  LIVE_HOLD_MS,
  LIVE_H_PX,
  LIVE_W_PX,
  MIN_HIT_PX,
  PILL_H_PX,
  PILL_W_RING_PX,
  PILL_W_TEXT_PX,
  SQUASH_MS,
  SQUASH_SCALE,
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
  pillWidth,
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

describe("islandForm —— 该长什么样", () => {
  it("日常常驻是胶囊", () => {
    expect(islandForm({ ...BASE })).toBe("pill");
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

  it("背词进行中 → 小点，并且**压过**「它要说话」", () => {
    // 这条是刻意保留的老行为（"背词时缩成小点"）。
    // 横幅仍然一个字都不说 —— 背词期该不该就地小声提示属于 I2 的场景表。
    expect(islandForm({ ...BASE, presentation: "mini" })).toBe("dot");
    expect(islandForm({ ...BASE, presentation: "mini", speaking: true })).toBe("dot");
  });

  it("★ 背词进行中 + 有件正在跑的事 → 紧凑岛（Live 压过 mini）", () => {
    // 2026-09-26 Andy 点头定的。理由：`mini` 当初是为了"别被**横幅**打断"，
    // 而 Live 不是打断 —— 它是一条不吵的进度条，正好呼应"你正在背、还剩多少"。
    // ⚠️ 若不这么做，Live 档永远看不到：进度跳一格只发生在背词时。
    expect(islandForm({ ...BASE, presentation: "mini", live: true })).toBe("live");
  });

  it("有件正在跑的事 → 紧凑岛", () => {
    expect(islandForm({ ...BASE, live: true })).toBe("live");
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
    // 背词 + 进度 → 岛（而不是小点）
    expect(
      islandForm({ presentation: "mini", tucked: false, open: false, speaking: false, live: true }),
    ).toBe("live");
    // 背词 + 提醒（没进度）→ 仍缩成小点，一个字不说
    expect(
      islandForm({ presentation: "mini", tucked: false, open: false, speaking: true, live: false }),
    ).toBe("dot");
    // 不在专注页：提醒赢
    expect(
      islandForm({ presentation: "full", tucked: false, open: false, speaking: true, live: true }),
    ).toBe("banner");
  });
});

describe("islandShape —— 卡片不是岛的材料", () => {
  it("面板开着时，岛本身还是胶囊（它是面板的把手，不跟着变形）", () => {
    expect(islandShape("card")).toBe("pill");
  });

  it("其余各档原样透传", () => {
    expect(islandShape("dot")).toBe("dot");
    expect(islandShape("pill")).toBe("pill");
    expect(islandShape("live")).toBe("live");
    expect(islandShape("banner")).toBe("banner");
  });
});

describe("pillWidth / radiusFor", () => {
  it("有进度数字宽一档，没有就只放一个字", () => {
    expect(pillWidth(true)).toBe(PILL_W_TEXT_PX);
    expect(pillWidth(false)).toBe(PILL_W_RING_PX);
    expect(PILL_W_TEXT_PX).toBeGreaterThan(PILL_W_RING_PX);
  });

  it("圆角永远等于高的一半 —— 胶囊感就是这么来的", () => {
    expect(radiusFor(PILL_H_PX)).toBe(PILL_H_PX / 2);
    expect(radiusFor(DOT_PX)).toBe(DOT_PX / 2);
    expect(radiusFor(LIVE_H_PX)).toBe(LIVE_H_PX / 2);
    expect(radiusFor(BANNER_H_PX)).toBe(BANNER_H_PX / 2);
    // 16 的圆：半径 8 —— 它就是个正圆，不是"小方块"
    expect(radiusFor(DOT_PX) * 2).toBe(DOT_PX);
  });
});

/** 从 `44px` 这种 CSS 长度里取数值。Banner 档是 `min(...)`，取不到，另用 bannerWidth() 验 */
function px(value: string): number {
  return Number.parseFloat(value);
}

describe("islandBox —— 每一档的完整几何", () => {
  const VIEWPORTS = [320, 360, 390, 414, 768, 1280];

  it("Dot 档：看得见 16，点得到 44，所以热区每边外扩 14", () => {
    const box = islandBox("dot", { hasProgressText: true });
    expect(box.matW).toBe(`${DOT_PX}px`);
    expect(box.matH).toBe(`${DOT_PX}px`);
    expect(box.hitW).toBe(`${DOT_FRAME_PX}px`);
    expect(box.hitH).toBe(`${DOT_FRAME_PX}px`);
    expect(box.radius).toBe(`${radiusFor(DOT_PX)}px`);
    expect(box.hitInset).toBe((DOT_FRAME_PX - DOT_PX) / 2);
  });

  it("Pill 档：热区与材料一样大（这一档没有「隐形扩边」）", () => {
    for (const hasProgressText of [true, false]) {
      const box = islandBox("pill", { hasProgressText });
      expect(box.hitW).toBe(box.matW);
      expect(box.hitH).toBe(box.matH);
      expect(box.hitH).toBe(`${PILL_H_PX}px`);
      expect(box.radius).toBe(`${radiusFor(PILL_H_PX)}px`);
      expect(box.hitInset).toBe(0);
      expect(px(box.hitW)).toBe(pillWidth(hasProgressText));
    }
  });

  it("Live 档：固定 240 宽的一枚紧凑岛 —— **不拉满屏**", () => {
    const box = islandBox("live", { hasProgressText: true });
    expect(box.hitW).toBe(`${LIVE_W_PX}px`);
    expect(box.matW).toBe(`${LIVE_W_PX}px`);
    expect(box.hitH).toBe(`${LIVE_H_PX}px`);
    expect(box.matH).toBe(`${LIVE_H_PX}px`);
    expect(box.radius).toBe(`${radiusFor(LIVE_H_PX)}px`);
    expect(box.hitInset).toBe(0);
  });

  it("★ 紧凑岛必须比满屏横幅窄 —— 这就是它「不压迫」的物理保证", () => {
    // 苹果那边常驻的 Live Activity 也是这样：一枚小胶囊，不是一块巨幕。
    // 谁哪天把 LIVE_W_PX 调到跟横幅一样宽，这里会立刻红。
    expect(LIVE_W_PX).toBeLessThan(BANNER_MAX_W_PX);
    expect(LIVE_W_PX).toBeLessThanOrEqual(320);
  });

  it("Banner 档：宽度交给浏览器算 min()，不缩进", () => {
    const box = islandBox("banner", { hasProgressText: true });
    expect(box.hitW).toBe(BANNER_WIDTH_CSS);
    expect(box.matW).toBe(BANNER_WIDTH_CSS);
    expect(box.hitH).toBe(`${BANNER_H_PX}px`);
    expect(box.radius).toBe(`${radiusFor(BANNER_H_PX)}px`);
    expect(box.hitInset).toBe(0);
  });

  it("★ 可点范围从不小于 44 —— Dot 也不例外", () => {
    for (const shape of ["dot", "pill", "live"] as const) {
      const box = islandBox(shape, { hasProgressText: true });
      // 材料 + 两侧外扩 = 真实可点范围
      expect(px(box.matW) + box.hitInset * 2).toBeGreaterThanOrEqual(MIN_HIT_PX);
      expect(px(box.matH) + box.hitInset * 2).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }
    for (const viewportW of VIEWPORTS) {
      expect(bannerWidth(viewportW)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }
  });

  it("★ 在任何真实屏幕上都不比屏幕宽，也不顶到边（否则横向溢出）", () => {
    const pillW = px(islandBox("pill", { hasProgressText: true }).hitW);
    const liveW = px(islandBox("live", { hasProgressText: true }).hitW);
    for (const viewportW of VIEWPORTS) {
      expect(bannerWidth(viewportW)).toBeLessThanOrEqual(viewportW);
      // 胶囊 / 紧凑岛贴在左右任一边：宽度 + 两侧留白，必须装得下
      expect(pillW + CARD_EDGE_PX * 2).toBeLessThanOrEqual(viewportW);
      expect(liveW + CARD_EDGE_PX * 2).toBeLessThanOrEqual(viewportW);
    }
  });

  it("islandHeight：位置算式按材料自己的高换算，每档都要有数", () => {
    expect(islandHeight("dot")).toBe(DOT_PX);
    expect(islandHeight("pill")).toBe(PILL_H_PX);
    expect(islandHeight("live")).toBe(LIVE_H_PX);
    expect(islandHeight("banner")).toBe(BANNER_H_PX);
    // 高度必须能跟几何盒子对上 —— 两处各写一遍就会飘
    expect(`${islandHeight("pill")}px`).toBe(islandBox("pill", { hasProgressText: true }).matH);
    expect(`${islandHeight("live")}px`).toBe(islandBox("live", { hasProgressText: true }).matH);
    expect(`${islandHeight("banner")}px`).toBe(
      islandBox("banner", { hasProgressText: true }).matH,
    );
  });

  it("胶囊高度沿用改造前那个球的高度 —— 球的样子变了，手感不该变", () => {
    // 这条是**防漂移**用的：谁哪天动了 dock.ts 的 BALL_PX，这里会立刻红。
    // （不改名、不搬走 BALL_PX，是因为面板封顶高度那套算式还在用它。）
    expect(PILL_H_PX).toBe(BALL_PX);
    expect(DOT_FRAME_PX).toBe(BALL_PX);
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

  it("降级：材料块整个不演，内容也不等，中段收细也不演", () => {
    expect(motionMode(true)).toEqual({ material: "none", contentDelayMs: 0, squash: false });
  });

  it("正常：中段收细是要演的", () => {
    expect(motionMode(false).squash).toBe(true);
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

describe("islandRank / isStretching —— 这一步是在拉长还是在收回来", () => {
  it("次序：小点 ＜ 胶囊 ＜ 紧凑岛 ＜ 横幅", () => {
    expect(islandRank("dot")).toBeLessThan(islandRank("pill"));
    expect(islandRank("pill")).toBeLessThan(islandRank("live"));
    expect(islandRank("live")).toBeLessThan(islandRank("banner"));
  });

  it("变宽才算拉长（中段收细只在这时候演）", () => {
    expect(isStretching("pill", "live")).toBe(true);
    expect(isStretching("pill", "banner")).toBe(true);
    expect(isStretching("live", "pill")).toBe(false);
    expect(isStretching("banner", "live")).toBe(false);
    expect(isStretching("pill", "pill")).toBe(false);
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
