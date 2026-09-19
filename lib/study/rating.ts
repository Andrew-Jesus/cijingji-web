/**
 * 三级反馈 —— 纯函数，可单测
 *
 * ── 三级反馈到底在反馈什么（这一步不说清，功能就白做了）──────────
 * 客观对错（`is_correct`）和执行三级反馈（`rating`）是**两件事**，都要记：
 *   · `is_correct` 是**系统判定的事实** —— 你选的那一项对不对、你敲的字对不对。
 *   · `rating` 是**用户自己的感觉** —— "我是想起来了，还是蒙的？"
 * 只记前者，就丢掉了"对了但其实是蒙的"这个关键信息；
 * 只记后者，则没有任何客观锚点。所以两张都记。
 *
 * 这也是为什么界面上**不要求用户重复劳动**：
 * 系统先按客观对错替他预选一档（对 → Good，错 → Again），
 * 他绝大多数时候直接确认就行，只有"我其实会，是手滑"这种情况才需要动手改。
 *
 * ── 数值口径 ────────────────────────────────────────────────
 * 用的是复习调度领域通行的 1/2/3/4（Again / Hard / Good / Easy），
 * 阶段 0 **只开放 1/2/3**，刻意不给"太简单"：
 * 起步阶段多一个"这词太简单"的选项，只会让人随手点它，把信号搞脏。
 * 4 留给阶段 2 接 FSRS 时再开放（那时它才有确定的算法含义）。
 *
 * ── 它与"复习间隔"的关系（边界，别越界）────────────────────────
 * `rating` 现在**只决定"今天这张卡要不要再出现一遍"**（Again → 回插队列）。
 * 它**不决定任何复习间隔** —— 间隔归阶段 2 的 FSRS 独占。
 * 所以这里没有、也不许有 `interval` / `ease` / `due` 这类字段。
 */
import type { Rating } from "./types";

export type RatingKey = "again" | "hard" | "good";

export interface RatingOption {
  key: RatingKey;
  rating: Rating;
  label: string;
  /** 答对时给的解释（同一个按钮，答对答错时用户想的不一样，所以两句都要有） */
  hint_correct: string;
  hint_wrong: string;
}

export const RATING_OPTIONS: RatingOption[] = [
  {
    key: "again",
    rating: 1,
    label: "没想起来",
    hint_correct: "刚才其实是蒙的",
    hint_wrong: "确实没想起来，等会儿再来一遍",
  },
  {
    key: "hard",
    rating: 2,
    label: "想起来了，但费劲",
    hint_correct: "想了几秒才确定",
    hint_wrong: "其实想起来了，只是选错了 / 写错了",
  },
  {
    key: "good",
    rating: 3,
    label: "很顺",
    hint_correct: "一眼就认出来了",
    hint_wrong: "明明会，是手滑",
  },
];

/** 按客观对错给一个**预选档**。用户不点就是它，点了就以他点的为准。 */
export function defaultRating(isCorrect: boolean): Rating {
  return isCorrect ? 3 : 1;
}

export function ratingOption(key: RatingKey): RatingOption {
  const found = RATING_OPTIONS.find((o) => o.key === key);
  // 常量表就在上面，找不到只可能是代码写错了；返回第一档比抛异常更安全
  // （抛异常会让学习页整页挂掉，而这里只是一个文案查表）
  return found ?? RATING_OPTIONS[0];
}

export function ratingForKey(rating: Rating): RatingOption {
  return RATING_OPTIONS.find((o) => o.rating === rating) ?? RATING_OPTIONS[0];
}

export function ratingHint(option: RatingOption, isCorrect: boolean): string {
  return isCorrect ? option.hint_correct : option.hint_wrong;
}

/**
 * 要不要把这张卡放回队列再练一遍。
 * **只有 Again 会** —— Hard 也放回去的话，一个"有点难"的词会在同一次学习里
 * 反复出现，用户会觉得"怎么又是它"，体验很差；而 Again 是真的没记住，当下再练一遍最有效。
 */
export function shouldRequeue(rating: Rating): boolean {
  return rating === 1;
}

/**
 * 界面上那句如实说明。
 * 特意写明"它现在只影响今天" —— 否则用户会以为自己在给系统调复习计划，
 * 而实际上科学复习调度还没接（阶段 2）。这种"说清楚边界"的话，比多一个动效重要。
 */
export const RATING_FOOTNOTE =
  "这个感觉会记进复习记录。现在科学复习调度还没接（排在阶段 2），所以它眼下只影响“今天这张要不要再来一遍”。";
