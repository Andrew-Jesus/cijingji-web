/**
 * 小词的形态决策 —— 纯逻辑层
 *
 * 只回答一个问题：**这一刻它该长什么样**。五个答案：
 *
 *   dot     一颗小点（热区 44，看得见的只有 16）—— 值班中，不说话
 *   pill    胶囊（高 44，宽 108 或 164）——        日常常驻，扫一眼看见进度
 *   live    紧凑岛（高 48，宽 240）——             有件正在跑的事，报实时进度（**登台**）
 *   banner  横幅（高 58，近整屏宽）——             它要说话了（**登台**）
 *   card    卡片（宽 320）——                      你点开了，看细节
 *
 * ── 为什么不跟另外两件事合成一个函数 ─────────────────────────
 *   「该不该露面」＝ 页面规则 → `lib/console/dock.ts` 的 `dockPresentation()`（保留不动）
 *   「长什么样」  ＝ 视觉规则 → 这里
 *   「待在角落还是登台」＝ 空间规则 → `lib/island/stage.ts`
 * 三件事的**变更原因完全不同**。混在一起的话，改任一条都要重跑另外两条的单测。
 *
 * ── 形状即状态（这是跟灵动岛借的第一条思路）───────────────────
 * 不靠文字、不靠图标，靠**轮廓**认状态：
 * 小的 = 它在值班，长的 = 它在报进度，宽的 = 它在说话。
 * 所以形状的优先级必须写死在这一个地方，组件不许自己另判断一套。
 *
 * ── 与苹果的第二条对照：常驻的那一枚**不宽**（2026-09-26）──────
 * 苹果的 Live Activity（外卖配送中）是一枚**不宽的小胶囊**：左边图标、右边剩余量。
 * 所以"报实时进度"是 `live`（240），不是把 `banner`（近满屏）拿来天天挂头顶。
 *
 * ── 为什么宽度是固定档位，不是自适应 ──────────────────────────
 * CSS 没法给 `width: auto` 做过渡动画。让内容撑开宽度的话，形变时会"啪"地跳一下 ——
 * 那正是要避免的"弹窗感"。固定档位既能动画、又不会抖。
 *
 * ── 尺寸常量为什么集中在这里 ──────────────────────────────────
 * 理由跟 `lib/console/dock.ts` 的 `BALL_PX` 当初一模一样：
 * 面板会不会越界、热区够不够大，都取决于这几个数。散着写就会改一处漏一处。
 * 组件与单测**共用这一份**。
 */
import type { CSSProperties } from "react";

import type { DockPresentation } from "@/lib/console/dock";
import type { Notice } from "@/lib/console/notices";

export type IslandForm = "dot" | "pill" | "live" | "banner" | "card";

/** 岛本身的形状。`card` 不在这里 —— 卡片是面板（ConsolePanel），不是岛的材料 */
export type IslandShape = Exclude<IslandForm, "card">;

// ── 尺寸 ────────────────────────────────────────────────────────
/** Dot 档：热区。**它是可点范围**，所以不许小于 MIN_HIT_PX */
export const DOT_FRAME_PX = 44;
/** Dot 档：看得见的那颗圆。比热区小得多 —— 小，就是它要说的话 */
export const DOT_PX = 16;
/** Pill 档：高度。圆角恒等于 高 ÷ 2，所以它看起来是个胶囊 */
export const PILL_H_PX = 44;
/** Pill 档：没有进度数字可报时的宽度（只放一个字） */
export const PILL_W_RING_PX = 108;
/** Pill 档：环 + 「今日 12 / 36」时的宽度 */
export const PILL_W_TEXT_PX = 164;
/**
 * Live 档：宽。
 *
 * **它刻意不拉满屏。** 这是跟苹果借的第二条：那边的常驻 Live Activity
 * （外卖配送中、正在录音）也是一枚**不宽的小胶囊** —— 左边图标、右边剩余量。
 * 拉满屏那一档留给"要提醒你"的消息（`banner`）：一个天天挂在头顶的巨幕会让人喘不过气。
 */
export const LIVE_W_PX = 240;
/** Live 档：高。比胶囊高一档，给底部那根细进度条留出位置 */
export const LIVE_H_PX = 48;
/** Banner 档：高度。比胶囊高一档 —— "它开口了"要看得出来 */
export const BANNER_H_PX = 58;
/** Banner 档：宽度上限。窄屏用 `100vw − 2×BANNER_EDGE_PX`，电脑上别摊成一条巨幕 */
export const BANNER_MAX_W_PX = 420;
/** Banner 档：左右各留的边距 */
export const BANNER_EDGE_PX = 16;
/** Card 档：面板宽度（沿用改造前的 `min(20rem, calc(100vw − 2.5rem))`） */
export const CARD_W_PX = 320;
/** Card 档：左右各留的边距（2.5rem ÷ 2 = 20px） */
export const CARD_EDGE_PX = 20;

/**
 * 触摸热区下限。
 * iOS 人机指南是 44pt。Dot 档看着只有 16px，但**可点范围一样不许小于这个数** ——
 * 否则手指点不中，用户就"找不回小词"了（2026-09-19 为收起态小点立过同一条规矩）。
 */
export const MIN_HIT_PX = 44;

/** Banner 说完就走（毫秒）。赖着不走的话，它就从"活了"变成"烦人" */
export const BANNER_HOLD_MS = 5600;
/**
 * Live 归位的静默期（毫秒）—— "事多久待多久"就是这么实现的。
 *
 * 今日任务进度**每跳一格**，这个窗口就往后重推一次：你还在背，它就一直在；
 * 你不背了（进度不动了），12 秒后它自己回角落。
 * 这跟苹果的 Live Activity 是同一条规矩 —— "配送中"一直在，"送完了"就消失。
 * 顺带它也让"会不会永远赖在顶上"这个问题不成立。
 */
export const LIVE_HOLD_MS = 12000;
/**
 * 中段收细的总时长（毫秒）。比形变（240ms）略长 ——
 * 它是"甩出去再回弹"，得等形变差不多到位才收回来。
 */
export const SQUASH_MS = 330;
/**
 * 中段收细最深收到多少（比例）。
 *
 * 横向拉长时中段细一点 —— 这是"被拉长"的物理直觉（像软糖被扯开）。
 * ⚠️ 它是 `scaleY`，属于"只动 translate / scale / opacity"的允许范围，
 * **不是 bounce**：bounce 是"位置来回弹"，这个只是"形变本身"。
 * 4.5% 是照着观感定的：看得见，但不至于让人觉得它在打哆嗦。
 */
export const SQUASH_SCALE = 0.955;
/**
 * 内容从锚点那侧滑进来的距离（像素）。
 * 不滑动、直接原地浮现的话，看起来像"两个零件在交替"；滑一下才像同一块材料在长。
 */
export const CONTENT_SLIDE_PX = 12;
/**
 * 内容（环 / 文字）在形变**后半段**才淡入。
 * 前半段保持干净 —— 否则会看见文字被拉伸变形时的一堆糊字。
 */
export const CONTENT_DELAY_MS = 140;

/** 圆角恒等于高的一半 —— "同一块材料在拉伸"这件事就靠它 */
export function radiusFor(height: number): number {
  return height / 2;
}

/** Banner 在给定视口宽度下的实际宽度（与下面的 CSS 表达式共用同一组常量，不会各写一份） */
export function bannerWidth(viewportW: number): number {
  return Math.min(viewportW - BANNER_EDGE_PX * 2, BANNER_MAX_W_PX);
}

/** Card 在给定视口宽度下的实际宽度 */
export function cardWidth(viewportW: number): number {
  return Math.min(CARD_W_PX, viewportW - CARD_EDGE_PX * 2);
}

export const BANNER_WIDTH_CSS = `min(100vw - ${BANNER_EDGE_PX * 2}px, ${BANNER_MAX_W_PX}px)`;
export const CARD_WIDTH_CSS = `min(${CARD_W_PX}px, 100vw - ${CARD_EDGE_PX * 2}px)`;

/**
 * 形变只动 **width / height / border-radius**，240ms，柔和收尾、**无回弹**。
 *
 * 为什么用内联 `style` 而不是 Tailwind 类：
 * 项目在案记录过"**Tailwind 类名写错不报错、只静默失效**"，
 * 内联写错在页面上当场看得出来。（跟 `ConsoleDock` 里 `SLIDE` 是同一套写法。）
 */
export const MORPH_TRANSITION = [
  "width var(--duration-slow) var(--ease-soft)",
  "height var(--duration-slow) var(--ease-soft)",
  "border-radius var(--duration-slow) var(--ease-soft)",
].join(", ");

export interface IslandFormInput {
  /** 页面规则：这一刻该不该露面。直接把 `dockPresentation()` 的结论传进来 */
  presentation: DockPresentation;
  /** 用户主动把小词收起来了 */
  tucked: boolean;
  /** 面板展开着 */
  open: boolean;
  /** 此刻有要说的（I1 只由现有的两条动态触发，见 `shouldSpeak`） */
  speaking: boolean;
  /** 有件正在跑的事刚有动静（今日任务进度刚跳一格，且在 `LIVE_HOLD_MS` 窗口内） */
  live: boolean;
}

/**
 * 这一刻用哪一档。
 *
 * ── 优先级（2026-09-26 重排，为了 Live 档能露脸）────────────────
 *   **你要看细节（open）＞ 你收起了它（tucked）＞ 页面不让露面（hidden）**
 *   ，之后分成两条路：
 *
 *     · **背词专注中（mini）**：横幅照旧一个字不说（老行为，不动），
 *       但「正在跑的任务」允许露出一枚安静的小岛 —— 见下；
 *     · **不在专注页**：提醒压过进度 —— 正在跑任务时网络断了，先报断网。
 *
 * ── 为什么 Live 能压过 mini，而 Banner 不能 ─────────────────────
 * 这条是 Andy 2026-09-26 点头定的。`mini` 当初的目的是"背词时别被**横幅**打断"，
 * 而 Live 档**不是打断** —— 它是一条不吵的进度条，正好呼应"你正在背、还剩多少"。
 * 苹果的外卖岛在你干别的时也一直挂着。
 *
 * ⚠️ 若不这么做，Live 档就**永远看不到**：因为"今日任务进度跳一格"恰恰只发生在背词时。
 *
 * 其余几条的理由：
 *  · `tucked` 排在最前两位 —— 你收起了它，它就不该再长成别的样子；
 *  · `hidden`（引导前半段）返回 `dot`，只是为了**让函数有确定的答案**：
 *    真实渲染里组件会直接不渲染（见 ConsoleDock 的提前 return）。
 *    纯函数不该有"看情况"这种返回。
 */
export function islandForm(input: IslandFormInput): IslandForm {
  if (input.open) return "card";
  if (input.tucked) return "dot";
  if (input.presentation === "hidden") return "dot";
  if (input.presentation === "mini") return input.live ? "live" : "dot";
  if (input.speaking) return "banner";
  if (input.live) return "live";
  return "pill";
}

/**
 * 卡片不是岛的材料 —— 它是面板（ConsolePanel）。
 * 面板开着时，岛本身仍然是一个胶囊：它是这块面板的"把手"，不该跟着变形。
 * （"胶囊胀大成卡片"是更大的改动，不在 I1 范围内。）
 */
export function islandShape(form: IslandForm): IslandShape {
  return form === "card" ? "pill" : form;
}

/** Pill 该多宽：有进度数字就宽一档，没有就只放一个字 */
export function pillWidth(hasProgressText: boolean): number {
  return hasProgressText ? PILL_W_TEXT_PX : PILL_W_RING_PX;
}

/**
 * 某一档的完整几何。
 *
 * `hit`（可点范围）与 `mat`（看得见的那块）分开，是因为
 * **Dot 档看得见的只有 16px，可点范围却必须有 44px** —— 两个数都得能被单测断言。
 *
 * ⚠️ 尺寸是 **CSS 长度字符串，不是像素数字**，这是故意的：
 * 渲染时读 `window.innerWidth` 会多出"服务端不知道屏幕多宽"的水合陷阱，
 * 还得自己监听 resize。Banner 档直接写 `min(100vw − 32px, 420px)` 交给浏览器算 ——
 * 转屏、手机地址栏收放全都自动跟上（跟面板那条 max-height 算式同一个思路）。
 */
export interface IslandShapeBox {
  /** 可点范围（按钮自己的盒子）。永远 ≥ MIN_HIT_PX */
  hitW: string;
  hitH: string;
  /** 看得见的那块材料 */
  matW: string;
  matH: string;
  /** 材料的圆角 */
  radius: string;
  /**
   * 热区比材料**每边**多出来的那一圈（px），Dot 档是 14，其余各档都是 0。
   *
   * 为什么要这么一圈：材料本身只有 16px，但可点范围必须 44px。
   * 做法是让按钮**就是那块材料**（尺寸一致、位置就不用做任何补偿 ——
   * 各档的左边缘都老老实实落在 EDGE_PX 上），再在它里面放一个四面各外扩
   * `hitInset` 的透明圈专门吃点击。2026-09-19 为收起态小点立过同一条规矩。
   */
  hitInset: number;
}

export function islandBox(shape: IslandShape, opts: { hasProgressText: boolean }): IslandShapeBox {
  if (shape === "dot") {
    return {
      hitW: `${DOT_FRAME_PX}px`,
      hitH: `${DOT_FRAME_PX}px`,
      matW: `${DOT_PX}px`,
      matH: `${DOT_PX}px`,
      radius: `${radiusFor(DOT_PX)}px`,
      hitInset: (DOT_FRAME_PX - DOT_PX) / 2,
    };
  }
  if (shape === "live") {
    return {
      hitW: `${LIVE_W_PX}px`,
      hitH: `${LIVE_H_PX}px`,
      matW: `${LIVE_W_PX}px`,
      matH: `${LIVE_H_PX}px`,
      radius: `${radiusFor(LIVE_H_PX)}px`,
      hitInset: 0,
    };
  }
  if (shape === "banner") {
    return {
      hitW: BANNER_WIDTH_CSS,
      hitH: `${BANNER_H_PX}px`,
      matW: BANNER_WIDTH_CSS,
      matH: `${BANNER_H_PX}px`,
      radius: `${radiusFor(BANNER_H_PX)}px`,
      hitInset: 0,
    };
  }
  const w = `${pillWidth(opts.hasProgressText)}px`;
  return {
    hitW: w,
    hitH: `${PILL_H_PX}px`,
    matW: w,
    matH: `${PILL_H_PX}px`,
    radius: `${radiusFor(PILL_H_PX)}px`,
    hitInset: 0,
  };
}

/**
 * 某一档材料的高度（像素数字）。
 *
 * 只有高度能这么用 —— 宽度里可能出现 `min()`，取不出数值。
 * 位置算式要用它：`ratio` 是**按材料自己的高**换算的，
 * 这样无论哪一档，"0 就是贴顶、1 就是贴底"这件事都成立（实测对齐到 ±0）。
 */
export function islandHeight(shape: IslandShape): number {
  if (shape === "dot") return DOT_PX;
  if (shape === "live") return LIVE_H_PX;
  if (shape === "banner") return BANNER_H_PX;
  return PILL_H_PX;
}

/**
 * 各档的"宽窄次序"。只用来回答一个问题：**这一步是在拉长，还是在收回来**。
 *
 * 为什么不用真实宽度：Banner 档的宽度是 `min(100vw − 32px, 420px)`，
 * 是个表达式、取不出确定的数。而"比大小"这件事只需要次序，不需要精确到像素。
 */
const RANK: Record<IslandShape, number> = { dot: 0, pill: 1, live: 2, banner: 3 };

export function islandRank(shape: IslandShape): number {
  return RANK[shape];
}

/**
 * 这一步是不是"被拉长"。
 *
 * 中段收细只在这时候演 —— 往回缩的时候再收细就变成"瘪"了，
 * 那是另一回事（"内容先让开、形状再收"已经是那条过渡在管）。
 */
export function isStretching(from: IslandShape, to: IslandShape): boolean {
  return islandRank(to) > islandRank(from);
}

export interface MotionMode {
  /**
   * 材料块自己的过渡：各档形变 + 淡出/淡入 + 悬停放大，**全在这一条里**。
   * 降级时是 `none` —— 不是"慢一点"，是**不演**。
   */
  material: string;
  /** 内容淡入要等多久（毫秒）。降级时不等，因为没什么可等 */
  contentDelayMs: number;
  /**
   * 中段收细（`scaleY` 那下"被拉长"的手感）演不演。
   * 降级时**也不演** —— 它是形变的一部分，不是"淡入"那一类。
   */
  squash: boolean;
}

/**
 * 动效降级（微信 UA / 系统"减少动态效果"）。
 *
 * 硬约束是"只动 translate / scale / opacity"。降级时**连形变都不演**，
 * 四档之间直接换装 —— 功能一个不少，只是不好看。这不是"少给用户一点"，
 * 是微信里那台机器真的会卡。
 *
 * 注意：被关掉的只是**材料块**的过渡。内容层那下淡入仍然留着
 * （它只动 opacity，本来就在允许之列）—— 所以降级后不是"啪"地硬切，
 * 而是"形状立刻到位、文字轻轻浮出来"。
 */
export function motionMode(reduced: boolean): MotionMode {
  if (reduced) return { material: "none", contentDelayMs: 0, squash: false };
  return {
    material: [
      MORPH_TRANSITION,
      "opacity var(--duration-base) var(--ease-soft)",
      "transform var(--duration-base) var(--ease-soft)",
    ].join(", "),
    contentDelayMs: CONTENT_DELAY_MS,
    squash: true,
  };
}

/**
 * 内容层的淡入淡出（外加"从锚点那侧滑进来"）。
 *
 * 出现时**等形变过半**（`contentDelayMs`）；消失时立刻走（delay 0）——
 * 两个方向不对称是故意的：内容先让开，形状再收，看起来才像"这块材料在变"，
 * 而不是"旧的淡出、新的淡入"（那就是弹窗了）。
 *
 * `slidePx` 是"从哪一侧滑出来"：贴左边的从左边露，贴右边的从右边露
 * （见 `lib/island/stage.ts` 的 `contentSlidePx`）。不滑动、直接原地浮现的话，
 * 看起来像两个零件在交替；滑一下才像同一块材料在长。
 */
export function contentFadeStyle(
  visible: boolean,
  delayMs: number,
  slidePx: number,
): CSSProperties {
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? "none" : `translateX(${slidePx}px)`,
    transitionProperty: "opacity, transform",
    transitionDuration: "var(--duration-fast)",
    transitionTimingFunction: "var(--ease-soft)",
    transitionDelay: visible ? `${delayMs}ms` : "0ms",
  };
}

/**
 * 哪条动态值得"登台说一句"。
 *
 * I1 只放行两类：
 *   · `warning` / `danger` —— “现在没网”这种，不说用户会以为坏了；
 *   · 开机播报（`key: "boot"`）—— 词库装载完成，是"它活了"的第一印象。
 * 其余（复制成功、网络恢复……）安静躺在面板里就好。
 *
 * ⚠️ I2 会把这里整个换成 §5.1 的场景表 + 静默期 + 降噪限流。
 * 现在这一版**刻意很窄**，宁可少说。
 */
export function shouldSpeak(notice: Notice): boolean {
  if (notice.level === "warning" || notice.level === "danger") return true;
  return notice.key === "boot";
}

/**
 * 最新一条值得说的动态；没有、或已经被划走，就返回 `null`。
 *
 * 用"最新一条"而不是"攒一个队列"，对应硬约束「**一次只说一句**」——
 * 两个横幅同时冒出来是灾难。
 */
export function bannerNotice(
  notices: readonly Notice[],
  dismissedId: string | null,
): Notice | null {
  const newest = notices[0];
  if (!newest) return null;
  if (!shouldSpeak(newest)) return null;
  if (newest.id === dismissedId) return null;
  return newest;
}
