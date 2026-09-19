/**
 * 会话推进 —— 纯函数，可单测
 *
 * 这里管三件事，都是"状态机"性质的东西，所以必须是纯函数（可测、可复现）：
 *   ① **队列怎么建** —— 今天要练的卡，去掉已经"结清"的词
 *   ② **答完之后怎么走** —— Again 的卡放回队列，其余往前走
 *   ③ **结束时说清发生了什么** —— 一次就对几个、卡住过哪几个、花了多久
 *
 * ── 什么叫"结清"（settled）──────────────────────────────────
 * 一个词今天**最后一次**作答是**对的**，就算结清，下次进来不再出现。
 * 反过来：最后那次是错的（或者压根没做过），它就还在队列里。
 *
 * 为什么用"最后一次"而不是"任何一次对就行"：
 * 第一次蒙对、后来又错了，说明这个词根本没稳住。
 * 用"最后一次"能让"没稳住的词"自动留在明天的队列里 ——
 * 这正是阶段 0 **唯一**能做的事（真正的间隔调度归阶段 2 的 FSRS）。
 *
 * ── 为什么给"同一个词最多练几遍"设上限 ─────────────────────────
 * 用户连点 Again 时，卡片会一直回到队列里。这本身是对的（没记住就该再练），
 * 但**没有上限的话，一个词能把人困死在这一次学习里** —— 他永远到不了终态。
 * 上限 3 遍（原始 1 遍 + 回插 2 遍）是取舍：练到第 3 遍还记不住，
 * 说明今天不是它的日子，明天再说。这时它会因为"最后一次作答是错的"留在队列里。
 */
import { shouldRequeue } from "./rating";
import type { Rating, StudyCard, StudySummary } from "./types";

// 「今天哪些词已经结清」「哪些词还没稳住」这两件事在 history.ts 里 ——
// 它们和这里的队列机制是两回事，混在一起会让两边都难测。
// 这里再导出一遍，是为了让调用方（学习页）只需要认识一个模块。
export { settledWordIds, weakWordIds } from "./history";
export type { OutcomeLog } from "./history";

/** Again 的卡回插到"往后数第几张"。3 的取法：中间隔 2 张，既不是马上重复（烦人），也不会远到忘掉刚学的 */
export const AGAIN_GAP = 3;

/** 同一个词在一次学习里最多出现几遍。上限存在的理由见文件头 */
export const MAX_ATTEMPTS_PER_WORD = 3;

export interface QueueEntry {
  card: StudyCard;
  /** 第几遍（从 0 开始）。0 = 第一次见 */
  round: number;
}

/** 今日队列 = 今天的卡，去掉已结清的词。保持任务单给的顺序（它已经是确定性排序） */
export function buildQueue(
  cards: readonly StudyCard[],
  settled: ReadonlySet<string>,
): QueueEntry[] {
  return cards
    .filter((c) => !settled.has(c.word_id))
    .map((card) => ({ card, round: 0 }));
}

export interface AdvanceResult {
  queue: QueueEntry[];
  nextPos: number;
  finished: boolean;
}

/**
 * 作答并给出反馈之后，队列往前推一步。
 * **不改传入的队列**（返回新数组）—— 组件里直接 setState 就行，不用自己 copy。
 */
export function advance(
  queue: readonly QueueEntry[],
  pos: number,
  rating: Rating,
): AdvanceResult {
  const current = queue[pos];
  const next = [...queue];

  if (current && shouldRequeue(rating) && current.round + 1 < MAX_ATTEMPTS_PER_WORD) {
    // 插在"当前位置往后 AGAIN_GAP 张"的位置：走一步之后再数，它正好隔开 AGAIN_GAP-1 张
    const at = Math.min(pos + 1 + AGAIN_GAP, next.length);
    next.splice(at, 0, { card: current.card, round: current.round + 1 });
  }

  const nextPos = pos + 1;
  return { queue: next, nextPos, finished: nextPos >= next.length };
}

/**
 * 当前进度（给顶部进度条用）。
 *
 * ── 分母是什么，这里改过一次口径（2026-09-19，Andy 拍板）──────────
 * 现在是**今天任务单的词数**（distinct 词），不再用队列长度。
 *
 * 旧写法拿队列长度当分母，有个副作用：答错时 Again 会回插一张，
 * 队列变长，顶部于是会走到 37 / 38 —— 而首页明明写着「36 个词」。
 * 两个数字各自都没错（首页 36 = 今天该练的词；旧分母 = 今天要点几下），
 * 但并排放着就让人犯嘀咕，而用户看到的只有一个界面。
 *
 * 新口径与首页对齐：**用"今天该练的词"做分母，"已经不用再练的词"做分子**。
 * 判据是"这个词还会不会出现在当前位置往后"——
 *   - 一次答对 → 它往后不再出现 → 记 +1
 *   - 答错回插 → 它还会再出现一次 → 不记
 * 于是：走完时进度条正好停满（36 / 36），中途答错也不会把分母撑大，
 * 同一个词练过两遍也仍然只算一个词。
 *
 * `totalWords` 由调用方给（学习页传的就是任务单的卡片数）——
 * 这里的 `queue` 在装载时已经滤掉了"今天已结清"的词，
 * 所以两者相减得到的"已完成"天然与首页的今日进度是同一个数。
 */
export function progressAt(
  queue: readonly QueueEntry[],
  pos: number,
  totalWords: number,
): { done: number; total: number } {
  const total = Math.max(totalWords, 0);
  const pending = new Set<string>();
  for (let i = Math.max(pos, 0); i < queue.length; i += 1) {
    const entry = queue[i];
    if (entry) pending.add(entry.card.word_id);
  }
  return { done: Math.max(total - pending.size, 0), total };
}

/**
 * `summarize` 只要能看出"哪个词、对没对"的记录即可。
 * 刻意收窄成最小形状（而不是要求整个 `ReviewRecord`）：
 * 学习页手上的记录有两种来源 —— 本次会话里刚做的、以及**当天早先做过、从
 * `review_logs` 读回来的**（退出再进来时要用它还原"今天干了什么"）。
 * 后者是数据库行，字段比 `ReviewRecord` 宽（`mode` 是 string、`rating` 可空），
 * 强行转换要写一堆类型体操，而这里根本不关心那些字段。
 */
export interface SummarizableRecord {
  word_id: string;
  is_correct: boolean;
}

/**
 * 终态汇总。三件事必须说清楚，因为它们是用户唯一能拿到的"我今天干了什么"：
 *   ① 一次就对几个（`correct`）—— 这是**真正的成绩**，不是"最后对了几个"
 *   ② 卡住的是哪几个（`stuck`）—— 这是**下一步的抓手**，比总数有用
 *   ③ 花了多久（`elapsed_ms`）—— 让"每天 15 分钟"这个承诺变得可核对
 *
 * `attempts` 与 `total` 刻意分开：点了 27 下、练了 20 个词，是两个不同的数。
 * 只给一个数，用户会觉得"怎么多出来几个"。
 */
export function summarize(
  records: readonly SummarizableRecord[],
  cards: readonly StudyCard[],
  elapsedMs: number,
): StudySummary {
  const lemmaOf = new Map(cards.map((c) => [c.word_id, c.lemma]));

  const firstTry = new Map<string, boolean>();
  const wrongCount = new Map<string, number>();

  for (const r of records) {
    if (!firstTry.has(r.word_id)) firstTry.set(r.word_id, r.is_correct);
    if (!r.is_correct) wrongCount.set(r.word_id, (wrongCount.get(r.word_id) ?? 0) + 1);
  }

  const total = firstTry.size;
  let correct = 0;
  for (const ok of firstTry.values()) if (ok) correct += 1;

  const stuck = [...wrongCount.entries()]
    .map(([word_id, times]) => ({ word_id, lemma: lemmaOf.get(word_id) ?? word_id, times }))
    // 错得多的排前面；次数相同按字母序，保证同样的记录永远排出同样的列表
    .sort((a, b) => b.times - a.times || a.lemma.localeCompare(b.lemma));

  return {
    total,
    correct,
    incorrect: total - correct,
    stuck,
    elapsed_ms: Math.max(elapsedMs, 0),
    attempts: records.length,
  };
}

/**
 * 「用时」的人话。超过一分钟才说分钟 —— 说"0 分钟"比不说更糟。
 * 小于 1 分钟时给秒，让用户看到"其实只花了 40 秒"，这对坚持是正向的。
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(Math.max(ms, 0) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}
