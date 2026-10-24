/**
 * 记忆状态怎么读 —— 纯函数，可单测
 *
 * 这一个文件只回答"**现在该不该复习、有多急了、记得牢不牢**"这三件事。
 * 它**不负责计算**下一次什么时候复习（那是 `fsrs.ts` 的活，要算法库）。
 * 分开的理由很实际：读状态是最常跑的一段（每天打开首页都要跑一遍），
 * 而算状态只在作答那一刻跑一次。放一起会让"只读的地方"也背上算法依赖。
 *
 * ── 为什么这些函数都吃 `WordMemory` 而不是 ts-fsrs 的 `Card` ─────
 * 数据层与算法层必须解耦（见 `lib/db/types.ts` 里 `WordMemory` 的说明）。
 * 这里既然只读已存好的字段，就更没有理由碰算法库。
 */
import type { MemoryState, WordMemory } from "@/lib/db/types";

/** 一天的毫秒数。只在本文件用，不导出 —— 免得别处拿去做出第二套日界口径 */
const DAY_MS = 86_400_000;

/**
 * 记忆牢度的四档。名字刻意用"状态"而不是"成就"：
 * 它是一个可以被降级的**事实判断**，不是勋章。
 *
 * 判据只用 `stability` 一个字段 —— 它是 FSRS 算出来的"记忆能保持多久（天）"，
 * 是算法的真实输出，不是我们另外拍的分数。
 * **不掺 lapses / reps**：那些是历史统计，掺进来就会变成"练得多就升级"，
 * 而那正是本产品明令要避免的"可刷的数字"。
 */
export type MemoryMaturity = "new" | "learning" | "familiar" | "solid";

/**
 * 分档阈值（天）。
 *
 * 取值依据：FSRS 默认参数下，一个词第一次答对后 `stability` 落在 1~3 天量级；
 * 能撑到三周（21 天）说明它已经过了反复遗忘期。
 *
 * ⚠️ 这两个数是**判读阈值**，不是算法参数。它们不影响任何一次复习间隔，
 * 只影响界面上怎么叫这个词。真要调，调这里，别去动 `fsrs.ts` 的参数。
 */
export const MATURITY_THRESHOLDS = { familiar: 3, solid: 21 } as const;

/** 到期了没有。**坏掉的 `due` 一律当到期** —— 宁可多复习一次，也不要让一个词永远消失 */
export function isDue(memory: WordMemory, now: Date): boolean {
  const due = Date.parse(memory.due);
  if (Number.isNaN(due)) return true;
  return due <= now.getTime();
}

/**
 * 逾期几天（向下取整，没逾期返回 0）。
 *
 * 它只用来**排序**（逾期越久越先练），不用来做任何判断。
 * 所以坏掉的时间戳返回 0 就够了 —— 排序的兜底由调用方的 tie-break 负责。
 */
export function overdueDays(memory: WordMemory, now: Date): number {
  const due = Date.parse(memory.due);
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((now.getTime() - due) / DAY_MS));
}

/** 记忆牢度分档。从没作答过 = `new`，不看 `stability`（新卡的 stability 是 0） */
export function maturityOf(memory: WordMemory): MemoryMaturity {
  // `reps === 0` 是"生词"的唯一判据。用它而不是 state，
  // 是因为 state 在 FSRS 里会随学习步骤变化（new → learning），
  // 而"做过几次"是更朴素、更不会误判的事实。
  if (memory.reps <= 0) return "new";
  if (memory.stability >= MATURITY_THRESHOLDS.solid) return "solid";
  if (memory.stability >= MATURITY_THRESHOLDS.familiar) return "familiar";
  return "learning";
}

/**
 * 这个词**曾经被忘掉过**（作答时明确判为"没想起来"）。
 *
 * 它和 `maturityOf` 刻意分开：一个是"现在有多牢"，一个是"历史上输过几回"。
 * 合并成一个数字的话，"忘过又练回来"这件事就看不见了 ——
 * 而那正是本产品想让人看见的那件事（"它以前打败过你，现在你赢了"）。
 */
export function hasBeenForgotten(memory: WordMemory): boolean {
  return memory.lapses > 0;
}

/** 状态是否还是"从没学过"（`state === "new"` 且一次都没作答） */
export function isUntouched(memory: WordMemory): boolean {
  return memory.reps <= 0 && memory.state === "new";
}

/**
 * 界面上怎么叫这四档。
 * 刻意不叫"掌握/精通"这类评级词 —— 那是给别人看的，
 * 而这里要说的是**这个词此刻在你脑子里的样子**。
 */
export const MATURITY_LABEL: Record<MemoryMaturity, string> = {
  new: "生词",
  learning: "刚认得",
  familiar: "记住了",
  solid: "很牢",
};

/** 状态的中文说明（开发者面板与回顾页用） */
export const MEMORY_STATE_LABEL: Record<MemoryState, string> = {
  new: "未开始",
  learning: "学习中",
  review: "复习中",
  relearning: "重新学",
};
