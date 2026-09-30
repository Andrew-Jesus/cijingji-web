/**
 * 小词的「家」—— 空间规则（纯逻辑层）
 *
 * 只回答一件事：**这一刻它待在角落，还是登台到屏幕顶上**。顺便把两套坐标、
 * 以及面板封顶高度的算式一起算出来（那三件事共用同一组几何，拆开写就会各飘各的）。
 *
 * ── 什么是「两个家」（2026-09-26 与 Andy 对齐）──────────────────
 *   · **角落**：左下角（或用户拖到的任一边），可拖、位置有记忆。
 *     形态是 dot / ball / island —— 球日常待命，**岛就在这儿原地抻长**。
 *   · **台上**：屏幕顶部中央。**只有 banner 来** —— 「要提醒你」才值得跑到头顶上。
 * 「登台」= 从角落滑到台上再向两侧拉长；「归位」= 反向。
 *
 * ⚠️ 2026-09-26 深夜 Andy 定的 **C 案**：**进度留原地、提醒才上去**。
 * 依据是这两件事的性质不同 —— 进度是"我陪着你"（待在角落不抢眼睛），
 * 提醒是"你得知道"（才配跑到头顶）。所以 island 从台上撤回了角落；
 * 但它**该抻长的三层手感一点没少** —— `isStretching` 只看形态排名，不看家在哪儿。
 *
 * ⚠️ 2026-09-30 补一条：**"登台"不是唯一的动作，甚至不是主要动作。**
 * Andy 要的是"球和岛平等、按场景自动切换" —— 日常绝大多数时间它待在角落，
 * 只是**一颗 44px 的正圆球**；拉长成岛是它在角落里自己完成的（球 → 长球），
 * 只有"要提醒你"那一种才配挪到头顶。所以这套位置规则必须能容忍
 * "形状变了、家没变"这种组合 —— `stageFor` 只认 `banner`，正是为此。
 *
 * ── 为什么不换 CSS 锚点，改用一个 translate 层 ────────────────
 * 角落那套是 `bottom` 锚、台上那套天然是 `top` 锚，而 CSS 里 `auto → 长度` **不能过渡**，
 * 硬切会有一帧"啪"地跳过去（施工单 §4 早写过这条）。
 * 所以位置**全部**由 `transform: translate(X, Y)` 表达：外层容器固定在视口左上角，
 * 换家就是 transform 的变化 —— 可平滑过渡，而且正好落在
 * "只动 translate / scale / opacity"这条产品硬约束里。
 *
 * ── 为什么表达式里带着 `var(--island-w)` / `var(--island-h)` ────
 * 因为四档的宽高不一样，而**位置**取决于它自己多大（贴右边、贴底边都要减掉自己的宽高）。
 * 把当前档的宽高作为两个自定义属性挂在容器上，表达式就能自己跟着形变走，
 * 不需要在 JS 里读 `window.innerWidth`（那会多出一个"服务端不知道屏幕多宽"的水合陷阱）
 * 也不需要监听 resize —— 转屏、手机地址栏收放全自动跟上。
 */
import {
  BOTTOM_MARGIN_PX,
  PANEL_EDGE_PAD_PX,
  PANEL_GAP_PX,
  TOP_LIMIT_PX,
  clampSpotRatio,
  panelSideFor,
  type PanelSide,
} from "@/lib/console/dock";

import { CONTENT_SLIDE_PX, islandForm, type IslandFormInput } from "./form";

/** 它现在在哪个家 */
export type IslandStage = "corner" | "stage";

/**
 * 材料贴屏幕左右边时留的空白（角落档）。
 * 值必须与改造前 `ConsoleDock` 里那个 `EDGE_PX` 一致 —— 老用户不该觉得"球挪了"。
 */
export const CORNER_EDGE_PX = 20;

/** 登台后材料离屏幕顶边的距离 */
export const STAGE_TOP_PX = 16;

/**
 * 面板封顶高度的上限（免得在大屏上摊成一张巨幕）。
 * 沿用改造前那个值，不动。
 */
export const PANEL_MAX_VH = 70;

/**
 * 这一刻它该待在哪个家。
 *
 * **只有横幅（`banner`）登台**（Andy 2026-09-26 定的 C 案）。
 * 进度档 `live` 虽然也是"变长"，但它在角落里**原地抻长** ——
 * 不飞到头顶，因为它是"陪着你"而不是"打断你"。
 *
 * ⚠️ 它内部把 `open` 抹掉再问一次「没有面板时它会变成哪一档」，理由是：
 * **面板开不开，不该改变它在哪个家。** 从台上点开横幅，就该在台上拉开抽屉；
 * 若按 `form === "card"` 判断，每次点开它都得先飞一趟角落 —— 那是个假动作，
 * 而且面板会在飞行途中从"往下长"翻成"往上长"，会跳一下。
 */
export function stageFor(input: IslandFormInput & { motionReduced: boolean }): IslandStage {
  // 降级模式（微信 UA / 系统减少动效）下**永不登台**：它就在角落里原地展开。
  // 注意这不是"少给用户一点" —— 功能一个不少，只是不演"走过去"。
  if (input.motionReduced) return "corner";

  const standing = islandForm({ ...input, open: false });
  return standing === "banner" ? "stage" : "corner";
}

/**
 * 材料**上沿**（从视口顶边算起）的 CSS 表达式。
 *
 * 有两个地方要用它，所以必须只有一份：
 *   ① 定位层的 `transform: translate(x, 这个值)`
 *   ② 面板的封顶高度（面板往上长时，可用空间就是"材料上沿减去缝和留白"）
 */
export function materialTopExpr(stage: IslandStage, ratio: number): string {
  if (stage === "stage") {
    // 顶上加安全区：刘海 / 状态栏底下不该压着东西
    return `calc(${STAGE_TOP_PX}px + env(safe-area-inset-top))`;
  }

  const r = clampSpotRatio(ratio);
  // 可用行程 = 视口高 − 上留白 − 下留白 − 材料高。
  // 减掉 `var(--island-h)` 而不是某个写死的数，是为了让四档都能"贴顶就是贴顶、贴底就是贴底"。
  const travel = `(100vh - ${TOP_LIMIT_PX + BOTTOM_MARGIN_PX}px - var(--island-h))`;
  return `calc(${TOP_LIMIT_PX}px + ${r.toFixed(4)} * ${travel} - env(safe-area-inset-bottom))`;
}

/**
 * 定位层的 transform。
 *
 * 角落档贴着用户选的那一边（贴左就左边缘对齐 20px，贴右就右边缘对齐 20px）；
 * 台上档水平居中 —— `calc(50vw - var(--island-w) / 2)` 里除法的除数是数字，
 * 而 `--island-w` 可能是 `min(100vw - 32px, 420px)` 这种表达式，`calc` 允许嵌 `min()`，
 * 所以满屏横幅那一档也能直接算出来。
 */
export function stageTransform(input: {
  stage: IslandStage;
  side: "left" | "right";
  ratio: number;
}): string {
  const x =
    input.stage === "stage"
      ? "calc(50vw - var(--island-w) / 2)"
      : input.side === "left"
        ? `${CORNER_EDGE_PX}px`
        : `calc(100vw - ${CORNER_EDGE_PX}px - var(--island-w))`;

  return `translate(${x}, ${materialTopExpr(input.stage, input.ratio)})`;
}

/** 面板该长在材料的哪一边（台上时只能是下边） */
export function panelSideForStage(stage: IslandStage, ratio: number): PanelSide {
  // 台上在屏幕顶端，面板**只能往下长** —— 往上就是屏幕外了
  if (stage === "stage") return "below";
  return panelSideFor(ratio);
}

/**
 * 面板封顶高度 = **那一侧真实剩下的空间**，再跟 `70vh` 取小值。
 *
 * 这条是 2026-09-19 修"面板跑出屏幕"那次立的，性质不许退：
 * 面板高度永远等于那一侧真实剩余空间，任何位置、任何屏幕都不许越界。
 * 全是 vh / 自定义属性表达式 → 转屏、地址栏收放自动重算，不需要 resize 监听。
 */
export function panelMaxHeightExpr(
  stage: IslandStage,
  ratio: number,
  side: PanelSide,
): string {
  const top = materialTopExpr(stage, ratio);
  const pad = PANEL_GAP_PX + PANEL_EDGE_PAD_PX;

  return side === "above"
    ? `min(${PANEL_MAX_VH}vh, calc(${top} - ${pad}px))`
    : `min(${PANEL_MAX_VH}vh, calc(100vh - (${top}) - var(--island-h) - ${pad}px))`;
}

/**
 * 内容从哪一侧滑出来。
 *
 * 贴着左边缘的，内容从左边露出来；贴着右边缘的，从右边。
 * 台上是居中展开，取左边那侧 —— 反正形变是"从中心向两边"，两头都说得通。
 */
export function contentSlidePx(stage: IslandStage, side: "left" | "right"): number {
  if (stage === "stage") return -CONTENT_SLIDE_PX;
  return side === "left" ? -CONTENT_SLIDE_PX : CONTENT_SLIDE_PX;
}
