import { describe, expect, it } from "vitest";

import {
  BALL_PX,
  BOTTOM_MARGIN_PX,
  DRAG_THRESHOLD_PX,
  MINI_PX,
  PANEL_EDGE_PAD_PX,
  PANEL_FLIP_RATIO,
  PANEL_GAP_PX,
  TOP_LIMIT_PX,
  clampSpotRatio,
  classifyGesture,
  dockPresentation,
  nearestSide,
  panelSideFor,
} from "./dock";

describe("classifyGesture", () => {
  it("原地没动就是点击", () => {
    expect(classifyGesture(0, 0)).toBe("tap");
  });

  it("阈值以内的小抖动仍算点击 —— 手指不可能绝对不动", () => {
    expect(classifyGesture(DRAG_THRESHOLD_PX, 0)).toBe("tap");
    expect(classifyGesture(4, -4)).toBe("tap");
  });

  it("超过阈值就是拖拽，方向无所谓", () => {
    expect(classifyGesture(DRAG_THRESHOLD_PX + 1, 0)).toBe("drag");
    expect(classifyGesture(0, -40)).toBe("drag");
    expect(classifyGesture(-30, 20)).toBe("drag");
  });

  it("位移是斜着算的：xy 各 5px = 7.07px，已经算拖", () => {
    expect(classifyGesture(5, 5)).toBe("drag");
  });

  it("阈值可以覆盖", () => {
    expect(classifyGesture(10, 0, 20)).toBe("tap");
    expect(classifyGesture(21, 0, 20)).toBe("drag");
  });
});

describe("dockPresentation", () => {
  it("首页与其它常规页：正常出现", () => {
    expect(dockPresentation("/")).toBe("full");
    expect(dockPresentation("/wrongbook")).toBe("full");
  });

  it("引导前半段躲起来 —— 新用户别被浮球分心", () => {
    expect(dockPresentation("/onboarding")).toBe("hidden");
    expect(dockPresentation("/onboarding/test")).toBe("hidden");
  });

  it("引导结果页要出现 —— 那是它第一次登场", () => {
    expect(dockPresentation("/onboarding/result")).toBe("full");
  });

  it("背词进行中缩成小点", () => {
    expect(dockPresentation("/learn")).toBe("mini");
    expect(dockPresentation("/learn/session")).toBe("mini");
  });
});

describe("nearestSide", () => {
  it("偏左吸左边，偏右吸右边", () => {
    expect(nearestSide(40, 390)).toBe("left");
    expect(nearestSide(350, 390)).toBe("right");
  });

  it("正好压在中线时归右边", () => {
    expect(nearestSide(195, 390)).toBe("right");
  });
});

describe("clampSpotRatio", () => {
  it("越界的拉回来", () => {
    expect(clampSpotRatio(-1)).toBe(0);
    expect(clampSpotRatio(2)).toBe(1);
  });

  it("非法数字退回默认，绝不把 NaN 传进样式", () => {
    expect(clampSpotRatio(Number.NaN)).toBe(1);
    expect(clampSpotRatio(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampSpotRatio(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("范围内的原样返回", () => {
    expect(clampSpotRatio(0.42)).toBeCloseTo(0.42);
    expect(clampSpotRatio(0)).toBe(0);
  });
});

describe("panelSideFor —— 面板往哪边长", () => {
  it("球在下半屏（默认落点）→ 面板往上长，与改造前行为一致", () => {
    expect(panelSideFor(1)).toBe("above");
    expect(panelSideFor(0.8)).toBe("above");
  });

  it("球在上半屏 → 面板改往下长，否则整块会从屏幕顶上冒出去", () => {
    expect(panelSideFor(0)).toBe("below");
    expect(panelSideFor(0.3)).toBe("below");
    expect(panelSideFor(0.49)).toBe("below");
  });

  it("正好压在中线时归「上」—— 边界只有一个归属，不留空档", () => {
    expect(panelSideFor(PANEL_FLIP_RATIO)).toBe("above");
  });

  it("脏值先夹回 0~1 再判断，NaN 不会漏进样式", () => {
    expect(panelSideFor(Number.NaN)).toBe("above"); // clamp 后退回默认值 1
    expect(panelSideFor(9)).toBe("above");
    expect(panelSideFor(-9)).toBe("below");
  });
});

describe("换边阈值 0.5 确实是算出来的（不是魔法数字）", () => {
  /**
   * 精确分界：令"上方余量 = 下方余量"，解出 ratio。
   * 这里刻意重算一遍，是为了**证明** dock.ts 里的 0.5 够准 ——
   * 它同时用着同一份尺寸常量，谁改了尺寸，这里会跟着重新验算。
   */
  function exactFlipRatio(viewportH: number, ballSize: number): number {
    const travel = viewportH - TOP_LIMIT_PX - ballSize - BOTTOM_MARGIN_PX;
    return (viewportH / 2 - ballSize / 2 - TOP_LIMIT_PX) / travel;
  }

  it("现实中的视口高度（300~1400px）× 两种球尺寸，精确分界都落在 0.500~0.510", () => {
    for (const vh of [300, 390, 568, 667, 844, 1024, 1400]) {
      for (const size of [BALL_PX, MINI_PX]) {
        const exact = exactFlipRatio(vh, size);
        expect(exact).toBeGreaterThanOrEqual(PANEL_FLIP_RATIO);
        expect(exact).toBeLessThanOrEqual(0.51);
      }
    }
  });

  it("用 0.5 近似，两边余量的差最多几像素 —— 判偏了也不会把面板挤出屏幕", () => {
    for (const vh of [300, 568, 844, 1400]) {
      for (const size of [BALL_PX, MINI_PX]) {
        const travel = vh - TOP_LIMIT_PX - size - BOTTOM_MARGIN_PX;
        const ballTop = TOP_LIMIT_PX + PANEL_FLIP_RATIO * travel;
        const above = ballTop - PANEL_GAP_PX - PANEL_EDGE_PAD_PX;
        const below = vh - (ballTop + size) - PANEL_GAP_PX - PANEL_EDGE_PAD_PX;
        expect(Math.abs(above - below)).toBeLessThanOrEqual(6);
      }
    }
  });
});
