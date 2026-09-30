import { describe, expect, it } from "vitest";

import { BOTTOM_MARGIN_PX, TOP_LIMIT_PX } from "@/lib/console/dock";

import { type IslandFormInput } from "./form";
import {
  CORNER_EDGE_PX,
  PANEL_MAX_VH,
  STAGE_TOP_PX,
  contentSlidePx,
  materialTopExpr,
  panelMaxHeightExpr,
  panelSideForStage,
  stageFor,
  stageTransform,
} from "./stage";

/** 日常待命的输入。各条用例只改自己要验的那一项 */
const IDLE: IslandFormInput = {
  presentation: "full",
  tucked: false,
  open: false,
  speaking: false,
  live: false,
};

describe("stageFor —— 这一刻它在哪个家", () => {
  it("平时待在角落", () => {
    expect(stageFor({ ...IDLE, motionReduced: false })).toBe("corner");
  });

  it("你收起了它 / 引导前半段 → 还在角落", () => {
    expect(stageFor({ ...IDLE, tucked: true, motionReduced: false })).toBe("corner");
    expect(stageFor({ ...IDLE, presentation: "hidden", motionReduced: false })).toBe("corner");
  });

  it("背词时缩成小点 → 还在角落（没有事在跑的时候）", () => {
    expect(stageFor({ ...IDLE, presentation: "mini", motionReduced: false })).toBe("corner");
  });

  it("★ 只有「要提醒你」的横幅才登台（Andy 2026-09-26 深夜定的 C 案）", () => {
    expect(stageFor({ ...IDLE, speaking: true, motionReduced: false })).toBe("stage");
  });

  it("★ 「正在跑的事」留在角落原地抻长 —— 它陪着你，不打断你", () => {
    // C 案的另外半边：进度档**不许**飞到头顶上。
    // 对照苹果：外卖进度是一枚常驻的小胶囊，不会替你占住整条顶部。
    expect(stageFor({ ...IDLE, live: true, motionReduced: false })).toBe("corner");
  });

  it("★ 背词时「正在跑的任务」也留角落 —— 谁在跑，都不改变家在哪儿", () => {
    // 这条同时守着两件事：
    //   ① `islandForm` 里 live 仍压过 mini（那半边由 `form.test.ts` 盯）
    //   ② 它没有被顺手送上台 —— 抻长发生在原地
    expect(stageFor({ ...IDLE, presentation: "mini", live: true, motionReduced: false })).toBe(
      "corner",
    );
  });

  it("★ 背词时横幅仍被压住 —— 所以它也不许登台", () => {
    // mini + speaking → islandForm 给的是 dot（老行为一个字不说），
    // 那就绝不能因为 speaking 为真而把它送上台 —— 一个 16px 的小点飘在顶上很怪。
    expect(stageFor({ ...IDLE, presentation: "mini", speaking: true, motionReduced: false })).toBe(
      "corner",
    );
  });

  it("★ 面板开着不改变它在哪个家 —— 否则每次点开都要先飞一趟角落", () => {
    // 从台上点开横幅：它应该就在台上把抽屉拉开，而不是先飞回角落。
    expect(stageFor({ ...IDLE, speaking: true, open: true, motionReduced: false })).toBe("stage");
    // 角落那两档（默认 / 进度）点开都还在角落
    expect(stageFor({ ...IDLE, open: true, motionReduced: false })).toBe("corner");
    expect(stageFor({ ...IDLE, live: true, open: true, motionReduced: false })).toBe("corner");
  });

  it("★ 降级模式（微信 UA / 减少动效）下**永不登台**，什么情形都一样", () => {
    // 不能因为降级就不让它说话，那叫功能缺失不叫降级 ——
    // 它只是**在角落里原地展开**，功能一个不少。
    const cases: IslandFormInput[] = [
      IDLE,
      { ...IDLE, speaking: true },
      { ...IDLE, live: true },
      { ...IDLE, presentation: "mini", live: true },
      { ...IDLE, open: true },
      { ...IDLE, tucked: true },
    ];
    for (const c of cases) {
      expect(stageFor({ ...c, motionReduced: true })).toBe("corner");
    }
  });
});

describe("几何常量", () => {
  it("角落留白沿用改造前那个数 —— 老用户不该觉得球挪了", () => {
    expect(CORNER_EDGE_PX).toBe(20);
  });

  it("台上离顶边一小段，且不会顶到刘海", () => {
    expect(STAGE_TOP_PX).toBeGreaterThan(0);
    expect(STAGE_TOP_PX).toBeLessThanOrEqual(32);
  });

  it("面板封顶高度还是跟 70vh 取小值（沿用改造前，别顺手改）", () => {
    expect(PANEL_MAX_VH).toBe(70);
  });
});

describe("materialTopExpr —— 材料上沿", () => {
  it("台上：固定贴顶，并让开安全区", () => {
    const expr = materialTopExpr("stage", 1);
    expect(expr).toContain(`${STAGE_TOP_PX}px`);
    expect(expr).toContain("env(safe-area-inset-top)");
  });

  it("角落：从顶部留白起，按比例在行程里滑", () => {
    expect(materialTopExpr("corner", 1)).toContain(`${TOP_LIMIT_PX}px`);
    expect(materialTopExpr("corner", 1)).toContain("1.0000 *");
    expect(materialTopExpr("corner", 0)).toContain("0.0000 *");
    expect(materialTopExpr("corner", 0.5)).toContain("0.5000 *");
  });

  it("角落：下边要让开安全区（有 home 指示条的机器）", () => {
    expect(materialTopExpr("corner", 1)).toContain("env(safe-area-inset-bottom)");
  });

  it("★ 行程里减掉的是 `--island-h`，不是某个写死的数", () => {
    // 各档高不同（现在只有两种：dot 16 / 其余一律 44 —— 见 form.ts 的「厚度恒定」），
    // 位置得跟着它自己多大走。写成字面量的话，换一档就"贴不了顶"或"贴不了底"。
    const expr = materialTopExpr("corner", 1);
    expect(expr).toContain("var(--island-h)");
    expect(expr).toContain(`${TOP_LIMIT_PX + BOTTOM_MARGIN_PX}px`);
  });

  it("脏比例值退化成默认值，不许进到样式里", () => {
    // clampSpotRatio 的兜底：NaN / Infinity / 越界一律夹回 0~1
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 5, -3]) {
      const expr = materialTopExpr("corner", bad);
      expect(expr).not.toContain("NaN");
      expect(expr).not.toContain("Infinity");
      expect(expr).toContain(" * ");
    }
  });

  it("角落的表达式是竖直的 —— 里面不该出现 100vw", () => {
    expect(materialTopExpr("corner", 1)).not.toContain("100vw");
  });
});

describe("stageTransform —— 定位层的 transform", () => {
  it("台上：水平居中，宽度自己算（近满屏那档也能算出来）", () => {
    const t = stageTransform({ stage: "stage", side: "left", ratio: 1 });
    expect(t).toContain("50vw");
    expect(t).toContain("var(--island-w)");
    expect(t).toContain("translate(");
  });

  it("台上：贴左贴右都一样 —— 居中跟用户在角落摆在哪边无关", () => {
    expect(stageTransform({ stage: "stage", side: "left", ratio: 1 })).toBe(
      stageTransform({ stage: "stage", side: "right", ratio: 0 }),
    );
  });

  it("角落·左：紧贴左边留白", () => {
    expect(stageTransform({ stage: "corner", side: "left", ratio: 1 })).toContain(
      `translate(${CORNER_EDGE_PX}px,`,
    );
  });

  it("角落·右：从右边倒着算，所以必须减掉自己的宽", () => {
    const t = stageTransform({ stage: "corner", side: "right", ratio: 1 });
    expect(t).toContain("100vw");
    expect(t).toContain(`- ${CORNER_EDGE_PX}px - var(--island-w)`);
  });

  it("★ 两种家都用同一套 translate 写法 —— 换家才能平滑过渡", () => {
    // 若哪一天有人改回 left / bottom 直接写值，`auto → 长度` 是没法过渡的，
    // 换家就会"啪"地跳一帧。这条守着那个约定。
    for (const stage of ["corner", "stage"] as const) {
      const t = stageTransform({ stage, side: "left", ratio: 1 });
      expect(t.startsWith("translate(")).toBe(true);
      expect(t).not.toContain("auto");
    }
  });
});

describe("panelSideForStage —— 面板往哪边长", () => {
  it("台上只能往下长（往上就是屏幕外了）", () => {
    for (const ratio of [0, 0.2, 0.5, 0.8, 1]) {
      expect(panelSideForStage("stage", ratio)).toBe("below");
    }
  });

  it("角落沿用老规矩：中线以下往上长，中线以上往下长", () => {
    expect(panelSideForStage("corner", 1)).toBe("above");
    expect(panelSideForStage("corner", 0)).toBe("below");
  });
});

describe("panelMaxHeightExpr —— 面板封顶高度", () => {
  it("一定跟 70vh 取小值", () => {
    expect(panelMaxHeightExpr("corner", 1, "above")).toContain(`min(${PANEL_MAX_VH}vh`);
    expect(panelMaxHeightExpr("corner", 1, "below")).toContain(`min(${PANEL_MAX_VH}vh`);
  });

  it("★ 往上长：可用高度 = 材料上沿 − 缝 − 留白（所以永远伸不出屏幕顶）", () => {
    const expr = panelMaxHeightExpr("corner", 1, "above");
    expect(expr).toContain(materialTopExpr("corner", 1));
    // 面板在材料上方，横向的东西跟它无关
    expect(expr).not.toContain("var(--island-w)");
  });

  it("★ 往下长：可用高度 = 视口高 − 材料下沿 − 缝 − 留白", () => {
    const expr = panelMaxHeightExpr("corner", 1, "below");
    expect(expr).toContain("100vh");
    expect(expr).toContain(materialTopExpr("corner", 1));
    // 材料下沿 = 上沿 + 自己高，所以必须再减掉 --island-h
    expect(expr).toContain("var(--island-h)");
  });

  it("台上：也是从台上那个上沿推出来的，不会用角落那套", () => {
    expect(panelMaxHeightExpr("stage", 1, "below")).toContain(materialTopExpr("stage", 1));
    expect(panelMaxHeightExpr("stage", 1, "below")).not.toContain(materialTopExpr("corner", 1));
  });

  it("封顶高度是纯 CSS 表达式 —— 转屏自动重算，不需要 resize 监听", () => {
    const expr = panelMaxHeightExpr("corner", 1, "below");
    expect(expr).toContain("calc(");
    expect(expr).not.toContain("auto");
  });
});

describe("contentSlidePx —— 内容从哪一侧滑出来", () => {
  it("贴左边 → 从左边露；贴右边 → 从右边露", () => {
    expect(contentSlidePx("corner", "left")).toBeLessThan(0);
    expect(contentSlidePx("corner", "right")).toBeGreaterThan(0);
  });

  it("台上是居中展开，两头都说得通 —— 统一取左边那侧", () => {
    expect(contentSlidePx("stage", "left")).toBe(contentSlidePx("stage", "right"));
    expect(contentSlidePx("stage", "left")).toBeLessThan(0);
  });

  it("滑一点点就够 —— 幅度大了会像「飘进来」而不是「长出来」", () => {
    expect(Math.abs(contentSlidePx("corner", "left"))).toBeLessThanOrEqual(16);
    expect(Math.abs(contentSlidePx("corner", "left"))).toBeGreaterThan(0);
  });
});
