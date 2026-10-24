/**
 * 从作答流水**重放出**每个词的记忆状态 —— 纯函数，可单测
 *
 * ── 为什么需要"重放"这件事 ──────────────────────────────────
 * 记忆状态不上云（理由见 `lib/db/types.ts` 里 `WordMemory` 的注释），
 * 所以新设备 / 新浏览器 / 清过缓存的用户，手上只有同步下来的 `review_logs`。
 * 把流水按时间顺序重放一遍，就能得到和原来一模一样的状态 ——
 * 因为算法是确定的：同样的输入必然得到同样的输出，没有随机、没有当前时间参与。
 *
 * 这也是"状态表可以随时丢弃"这个设计的兑现方式：**真相只有流水一份。**
 *
 * ── 为什么调度算法是"传进来的"（依赖注入）而不是 import 进来 ─────
 * ① 这个文件因此不依赖 `ts-fsrs`，**它的测试不需要真的算法库**也能跑，
 *    可以专心验"排序、脏数据、累加"这些真正容易错的地方；
 * ② 将来换算法（FSRS-5 → FSRS-6，或者干脆换一家）只改 `fsrs.ts` 一个文件，
 *    重放逻辑一行不动。
 * 代价是调用方必须显式传一个 scheduler —— 这是**好事**：
 * 它让"这段代码用了哪个算法"在调用处就看得见，不会藏在 import 里。
 */
import { memoryIdFor } from "@/lib/db/ids";
import type { MemoryState, WordMemory } from "@/lib/db/types";

/** FSRS 的四档评分：1 Again / 2 Hard / 3 Good / 4 Easy */
export type MemoryGrade = 1 | 2 | 3 | 4;

/**
 * 算法无关的记忆状态切片。
 *
 * 字段与 `WordMemory` 一一对应（只少了 `id` / `user_id` / `word_id` /
 * `updated_at` 这些"行信息"）—— 算法只该看见"这个卡现在是什么样"，
 * 不该看见"它是谁的"，否则算法层就有了越权的机会。
 */
export interface MemorySlice {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: MemoryState;
  last_review: string | null;
  learning_steps: number;
}

/** 调度器接口。`fsrs.ts` 是它唯一的真实实现；测试里可以喂一个假的 */
export interface MemoryScheduler {
  /** 一个从没学过的新卡 */
  initial(at: Date): MemorySlice;
  /** 复习一次之后的新状态。`at` 是这次作答的时间 —— **必须由调用方给**，算法内部不许取当前时间 */
  next(prev: MemorySlice, grade: MemoryGrade, at: Date): MemorySlice;
}

/** 重放要用到的作答记录形状。刻意收窄 —— 这里不关心 session / latency / error_type */
export interface ReplayLog {
  id: string;
  word_id: string;
  is_correct: boolean;
  rating: number | null;
  created_at: string;
}

/**
 * 「用户的自我感觉」+「客观对错」→ FSRS 的评分。
 *
 * ── 为什么不能直接把 `rating` 交给算法 ─────────────────────────
 * `rating` 是**用户说自己有没有想起来**（1 没想起来 / 2 费劲 / 3 很顺），
 * 而 FSRS 的 grade 决定的是"下次隔多久再问"。
 * 两者绝大多数时候一致，但有三种情况会不一致，而每一种**误判的代价都不对称**：
 *
 * | 情形 | `is_correct` | `rating` | 给算法的档 |
 * |---|---|---|---|
 * | 蒙对了 | 对 | 1（没想起来） | Again —— 用户自己都说没想起来，不能拉长间隔 |
 * | 手滑写错 | 错 | 3（很顺） | Hard —— 他确实会，但这次确实没提取成功 |
 * | 别的都错 | 错 | 1 或 2 | Again |
 *
 * **一条硬规矩：答错了永远拿不到 Good 及以上。**
 * 拉长间隔等于拿他的记忆做实验，而"多练一遍"永远不亏。
 * 这条规矩反过来就是"宁可保守"——产品是给中考学生用的，漏记一个词的代价
 * 远大于多复习一次。
 */
export function gradeFor(log: { is_correct: boolean; rating: number | null }): MemoryGrade {
  const r = log.rating;

  if (!log.is_correct) {
    // 用户说"其实会，是手滑"（rating 3）才给 Hard；其余一律 Again
    return r !== null && r >= 3 ? 2 : 1;
  }

  // 答对了：以用户的感受为准。缺 rating（老数据 / 用户没点）按 Good ——
  // 这与 `lib/study/rating.ts` 的 `defaultRating` 是同一个默认，两处不能各拍一个
  if (r === 1) return 1;
  if (r === 2) return 2;
  return 3;
}

/**
 * 把流水按时间排好序。
 *
 * 三件必须做的事，少一件结果就会错，而且**都不会报错**：
 *   ① **按时间升序** —— 重放是有状态的，顺序错了得到的是另一个状态；
 *   ② **坏时间戳跳过** —— 一条脏数据不该把整个词的历史打断
 *      （用 `Date.parse` 判，`NaN` 就跳过）；
 *   ③ **同一时刻按 `id` 兜底** —— 毫秒级并列时如果依赖数组原顺序，
 *      同一批数据的两次重放可能得到不同结果（`toArray()` 的顺序不保证）。
 *      `id` 里带了毫秒时间戳和随机尾巴，是稳定的。
 *
 * 注意 ① 用的是**字符串比较**而不是 `Date` 比较：`created_at` 存的是定长的
 * UTC ISO 串，字典序等于时间序，比构造几千个 `Date` 对象便宜。
 * （前提是全都用 `toISOString()` 写进去，`local.ts` 与 `studyRepo.ts` 保证了这点。）
 */
function sortLogs(logs: readonly ReplayLog[]): ReplayLog[] {
  return logs
    .filter((log) => !Number.isNaN(Date.parse(log.created_at)))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export interface ReplayInput {
  logs: readonly ReplayLog[];
  scheduler: MemoryScheduler;
  userId: string;
}

/**
 * 重放：返回这个人**每一个有作答记录的词**的记忆状态。
 *
 * 没有记录的词**不返回**（而不是返回一个 `new` 空卡）——
 * 这是刻意的：空卡会让"表里有这行"这件事失去意义，
 * 而 `maturityOf` / `状态表为空就回填` 这些判断都依赖"表里只有真正学过的词"。
 */
export function replayWordMemory(input: ReplayInput): WordMemory[] {
  const { scheduler, userId } = input;
  const sorted = sortLogs(input.logs);

  /** word_id → 当前切片 + 最后一条记录的时间（用来填 updated_at） */
  const acc = new Map<string, { slice: MemorySlice; lastAt: string }>();

  for (const log of sorted) {
    const at = new Date(log.created_at);
    const prev = acc.get(log.word_id);
    const slice = prev
      ? scheduler.next(prev.slice, gradeFor(log), at)
      : scheduler.next(scheduler.initial(at), gradeFor(log), at);

    acc.set(log.word_id, { slice, lastAt: log.created_at });
  }

  return [...acc.entries()].map(([wordId, { slice, lastAt }]) => ({
    // 编号必须与 `lib/db/ids.ts` 的规则一致 —— 两处各写一遍，
    // 改了生成忘了改重放，就会凭空多出一批"同一个词两条状态"的行
    id: memoryIdFor(wordId, userId),
    user_id: userId,
    word_id: wordId,
    ...slice,
    updated_at: lastAt,
  }));
}
