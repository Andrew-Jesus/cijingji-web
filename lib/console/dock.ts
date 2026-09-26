/**
 * 小词（左下角悬浮球）的行为规则 —— 纯逻辑层
 *
 * 这里只回答两个问题，两个都必须能单测：
 *   ① 当前这个页面，它该不该露脸？（露脸时是全尺寸，还是缩成小点）
 *   ② 用户刚才那一下，是「点」还是「拖」？
 *
 * 组件（ConsoleDock）只负责读结论、执行动作，不许自己另写一套判断 ——
 * 否则"什么页面显示"这种规则会散落在组件里，改一处漏一处。
 *
 * ── 为什么「点 / 拖」看位移，而不是看按住多久 ──────────────────
 * 手指落在球上时，用户可能是想点开、也可能是想把它挪开。
 * 用"按住多久"来区分，用户得先学会"要按住"这个隐藏知识；
 * 用"有没有移动"来区分则符合直觉：动了就是拖，没动就是点。
 * 代价是手会抖，所以留了 6px 的宽容度。
 */

export type DockPresentation = "hidden" | "full" | "mini";

/** 位移超过这个像素数就当拖拽。6px 在"手指轻微抖动"之上、"有意拖动"之下 */
export const DRAG_THRESHOLD_PX = 6;

// ── 几何尺寸 ────────────────────────────────────────────────────
// 组件与单测**共用这一份**：面板会不会跑出屏幕，取决于下面这几个数，
// 所以它们必须能被单测断言，而不是散在组件里各写一遍。
/** 球的全尺寸 */
export const BALL_PX = 44;
/** 背词进行中缩成的小点直径 */
export const MINI_PX = 20;
/** 球在竖直方向上能贴到的最上沿 */
export const TOP_LIMIT_PX = 16;
/** 球离屏幕底边的默认留白 */
export const BOTTOM_MARGIN_PX = 20;
/** 面板与球之间的缝（对应容器上的 gap） */
export const PANEL_GAP_PX = 10;
/** 面板离屏幕上下边至少留的空白 */
export const PANEL_EDGE_PAD_PX = 12;

/** 面板长在球的哪一边 */
export type PanelSide = "above" | "below";

/**
 * 面板换边的分界（`ratio` 的阈值）。
 *
 * ── 0.5 不是拍脑袋，是算出来的 ────────────────────────────────
 * 换边的准确判据是"上下哪边空得多"：
 *     上方余量 = 球上沿 − 缝 − 留白
 *     下方余量 = 视口高 − 球下沿 − 缝 − 留白
 * 令两者相等，把球上沿按 `TOP_LIMIT + ratio × 行程` 展开，解得
 *     ratio = (视口高/2 − 球/2 − TOP_LIMIT) / 行程
 * 代入 300~1400px 的视口、44px 与 20px 两种球，结果落在 **0.500~0.509**。
 * 于是直接用 0.5 —— 准到"差几个像素"，而且**不需要在 JS 里存一份视口高度**
 * （存了就要自己处理 resize、还会多一个水合陷阱，见 ConsoleDock 顶部注释）。
 *
 * 就算判偏了也不会出 bug：面板的 max-height 是按"那一侧真实剩余空间"算的
 * （在 CSS 里算），顶多面板矮几像素，绝不会伸出屏幕。单测把这条近似钉死了。
 */
export const PANEL_FLIP_RATIO = 0.5;

/**
 * 面板该长在球的哪一边。
 *
 * 球在**中线以下** → 面板往上长（默认落点就是这种，行为与改造前一致）；
 * 球在**中线以上** → 面板改往下长，否则整块会从屏幕顶上冒出去。
 *
 * 这是"面板会不会跑出屏幕"的唯一开关，所以必须是纯函数、必须有单测。
 */
export function panelSideFor(ratio: number): PanelSide {
  return clampSpotRatio(ratio) >= PANEL_FLIP_RATIO ? "above" : "below";
}

/**
 * 页面 → 该不该出现。
 *
 * 三条规则：
 *   · 引导流程**前半段不出现** —— 新用户还没建立认知，浮球只会分心；
 *   · 引导**结果页出现** —— 那是它第一次登场，也是"方案已保存"的收尾；
 *   · 背词进行中缩成**小点** —— 专注场景，少抢注意力、也少误触。
 *
 * 注意顺序：结果页那条必须排在通用前缀判断**之前**，否则会被吃掉。
 */
export function dockPresentation(pathname: string): DockPresentation {
  if (pathname === "/onboarding/result") return "full";
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) return "hidden";
  // ⚠️ 这里原本写的是 `/learn` —— 那是学习页改名前的老路径。
  //    现在真实路径是 `/study/<日期>`（见 app/(app)/study/[sessionId]/page.tsx）。
  //    名字改了、这里没跟着改，后果是"背词时缩成小点"这条规则
  //    **永远不触发，而且不报错** —— 单测当时也是照着老路径写的，所以照样绿。
  //    教训：改路由名时，除了搜代码，还要搜一遍**单测里的路径**。
  if (pathname === "/study" || pathname.startsWith("/study/")) return "mini";
  return "full";
}

/** 那一下到底算点还是算拖 */
export function classifyGesture(
  dx: number,
  dy: number,
  threshold: number = DRAG_THRESHOLD_PX,
): "tap" | "drag" {
  // 斜着拖也要算出来：x、y 各 5px 合起来是 7.07px，已经越过阈值
  return Math.hypot(dx, dy) > threshold ? "drag" : "tap";
}

/** 球停在哪：靠哪一边 + 竖直位置 */
export interface DockSpot {
  side: "left" | "right";
  /** 0 = 能到的最上，1 = 能到的最下。用比例而不是像素，换屏幕尺寸才不用重算 */
  ratio: number;
}

/** 默认停在左下角最下面 —— 与改造前完全一致，老用户不会觉得"球跑了" */
export const DEFAULT_SPOT: DockSpot = { side: "left", ratio: 1 };

/** 把竖直位置夹回 0~1。NaN / Infinity 一律退回默认值（别让脏值进到样式里） */
export function clampSpotRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPOT.ratio;
  return Math.min(Math.max(ratio, 0), 1);
}

/** 松手后往最近的一边吸附。正好压在中线上时归右边 —— 右上角更少被拇指挡住 */
export function nearestSide(centerX: number, viewportWidth: number): "left" | "right" {
  return centerX < viewportWidth / 2 ? "left" : "right";
}
