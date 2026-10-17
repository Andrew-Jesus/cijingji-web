/**
 * 错因归因 —— 纯函数，可单测
 *
 * ── 这个文件只做一件事 ───────────────────────────────────────
 * 把 `review_logs` 里已经存好的原始事实（对错 / 错因 / 耗时 / 犹豫次数）
 * **汇总成人能看懂的一句话**。不查库、不调 AI、不碰界面。
 *
 * 为什么单独成文件：`grade.ts` 负责"这一题错在哪"，这里负责"这几道题错在哪"。
 * 前者是判定，后者是归因。混在一起的话，改展示口径会连带改判分逻辑。
 *
 * ── 三条诚实的纪律（不是风格问题，是数据问题）────────────────
 *   ① **样本不足就不给结论**：作答 < `MIN_SAMPLES` 时 `confidence` 为
 *      `too_few_samples`，界面该说「这次练得少，还看不出规律」，
 *      而不是把 2 道题里的 1 个错说成"你的主要问题是拼写"。
 *   ② **不猜错因**：`error_type` 是未知值时计入 `unclassified`，
 *      绝不默认当成 `meaning` —— 那会把"我们没记清"伪装成"你记混了"。
 *   ③ **脏记录单列**：时间戳**给了但解析不出来**的行不计入 `total`，但记在 `ignored` 里。
 *      静默丢掉会让人以为"练了很多"，其实那些记录根本没被看见。
 *      注意「没给时间」是另一回事 —— 那是有效记录，只是不知道几点（页内刚产生的记录就这样）。
 *
 * ── 为什么不用"正确率""掌握度"这类分数 ──────────────────────
 * 任何单一分数都要先发明阈值（80% 算好？连对 3 次算会？），
 * 而这些阈值在现阶段都是拍的。归因只报**可复核的计数**：
 * 错了几条、其中几条是拼写、这是从多少条里数出来的。
 * 用户看到的每个数字都能在心里对上号。
 */
import type { ErrorType } from "./types";

/** 低于这个作答量就不下结论。与方案 §4.2 一致 */
export const MIN_SAMPLES = 5;

/** 每类榜单默认列几个 —— 多了就是给用户添负担 */
const DEFAULT_LIMIT = 5;

/**
 * 「平均耗时」至少要看几次作答。
 * 一次作答的均值没有意义（手滑点慢一点就能进榜），所以默认要求 2 次。
 * 这不是科学阈值，只是**去噪**；调用方可以改。
 */
const DEFAULT_MIN_SLOW_SAMPLES = 2;

/** 归因只看这几个字段 —— 与 `ReviewLog` 的前缀兼容，测试里不必造整行 */
export interface AttributionLog {
  word_id: string;
  is_correct: boolean;
  /** 数据库里是 `string | null`，这里刻意收宽：脏值要能被识别出来，而不是靠类型断言 */
  error_type: string | null;
  latency_ms: number;
  hesitation_count: number;
  /**
   * 作答时刻（ISO 串）。**可以不传**：
   * 学习页那一屏拿到的是本轮的 `ReviewRecord`，它们是几分钟内刚产生的，
   * 记录里还没来得及带落库时间。缺时间 = 「有效，只是不知道几点」，
   * 不是脏数据；只有**给了但解析不出来**才算脏。
   */
  created_at?: string | null;
}

export type AttributionConfidence = "ok" | "too_few_samples";

export interface ErrorTypeBucket {
  count: number;
  /**
   * 占**错题**的比例（0~1）。
   * 分母是 `wrong` 而不是 `total` —— "10 题错 2 题、其中 1 题拼写"
   * 说成"10% 是拼写"毫无意义，说"2 个错里 1 个是拼写"才对得上号。
   * `wrong === 0` 时这里是 0，**不会产生 NaN**。
   */
  share: number;
}

export interface StubbornWord {
  word_id: string;
  /** 这个词一共错了几次 */
  wrong: number;
  /** 这个词一共作答几次（分母） */
  attempts: number;
  /** 错过的种类，按固定顺序排（`meaning` → `spelling` → `confusion`） */
  kinds: ErrorType[];
  /**
   * 最近一次错的时刻（毫秒）。
   * 记录里没带时间时为 `null` —— 宁可说"不知道"，也不要编一个 0 出来。
   */
  last_wrong_at: number | null;
}

export interface SlowWord {
  word_id: string;
  avg_latency_ms: number;
  /** 均值背后有几条记录 —— 展示时必须带上，不然「平均 8 秒」看不出可信度 */
  samples: number;
}

export interface HesitantWord {
  word_id: string;
  /** 犹豫次数**求和**（不是平均）：犹豫 3 次这件事本身就是事实，不该被次数摊薄 */
  hesitation: number;
  samples: number;
}

export interface ErrorAttribution {
  /** 参与统计的有效作答条数（对 + 错）。坏时间戳的记录不算在内 */
  total: number;
  /** 其中答错的条数 —— `byType` 与 `share` 的分母 */
  wrong: number;
  byType: Record<ErrorType, ErrorTypeBucket>;
  /** 答错但错因未知 / 缺失的条数。**不并入上面三种** */
  unclassified: number;
  /** 同一个词错 ≥2 次。按错次降序、最近错的优先 */
  stubborn: StubbornWord[];
  /** 平均耗时最长的词。只统计作答次数达标的词 */
  slowest: SlowWord[];
  /** 犹豫次数最多的词 */
  hesitant: HesitantWord[];
  confidence: AttributionConfidence;
  /**
   * 因**时间戳给了但解析不出来**而被跳过的记录数。
   * 记录压根没带时间不算脏数据（见 `AttributionLog.created_at`），也不会进这个数。
   * 单独列出来是为了让"我练了 10 条怎么只显示 7 条"这件事有答案。
   */
  ignored: number;
}

export interface AggregateOptions {
  /** 每个榜单最多返回几条，默认 5 */
  limit?: number;
  /** 进「最慢」榜单至少要作答几次，默认 2 */
  minSlowSamples?: number;
}

const ERROR_TYPES: readonly ErrorType[] = ["meaning", "spelling", "confusion"];

function isErrorType(value: unknown): value is ErrorType {
  return value === "meaning" || value === "spelling" || value === "confusion";
}

/** 把可能是 `NaN` / 负数的耗时归到可计算的范围；不可用的返回 `null` */
function usableLatency(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  // 写入侧已经 `Math.max(0)` 过，这里再挡一次：归因读的是历史数据，
  // 不保证都是这一版代码写进去的。
  return Math.max(value, 0);
}

interface WordAccumulator {
  attempts: number;
  wrong: number;
  lastWrongAt: number;
  kinds: Set<ErrorType>;
  latencySum: number;
  latencySamples: number;
  hesitation: number;
}

function emptyAccumulator(): WordAccumulator {
  return {
    attempts: 0,
    wrong: 0,
    lastWrongAt: -Infinity,
    kinds: new Set<ErrorType>(),
    latencySum: 0,
    latencySamples: 0,
    hesitation: 0,
  };
}

/**
 * 归因主入口。
 *
 * 纯函数：同样的日志一定得到同样的结果，**顺序也是确定的**
 * （所有榜单都有明确的次级排序键，不依赖 Map 的插入顺序）。
 */
export function aggregateErrors(
  logs: readonly AttributionLog[],
  options: AggregateOptions = {},
): ErrorAttribution {
  const limit = Math.max(options.limit ?? DEFAULT_LIMIT, 0);
  const minSlowSamples = Math.max(options.minSlowSamples ?? DEFAULT_MIN_SLOW_SAMPLES, 1);

  const counts: Record<ErrorType, number> = { meaning: 0, spelling: 0, confusion: 0 };
  const perWord = new Map<string, WordAccumulator>();

  let total = 0;
  let wrong = 0;
  let unclassified = 0;
  let ignored = 0;

  for (const log of logs) {
    // 缺字段 = 有效但不知时间（见 `AttributionLog.created_at` 的说明）；
    // 给了却解析不出来 = 脏数据，整条跳过。
    let at: number | null = null;
    if (log.created_at !== undefined && log.created_at !== null) {
      const parsed = new Date(log.created_at).getTime();
      // 时间戳坏了就跳过整条：算它"对"会虚高正确率，算它"错"会冤枉用户。
      // 两个都不对，所以单列进 `ignored`。
      if (Number.isNaN(parsed)) {
        ignored += 1;
        continue;
      }
      at = parsed;
    }

    total += 1;

    let acc = perWord.get(log.word_id);
    if (!acc) {
      acc = emptyAccumulator();
      perWord.set(log.word_id, acc);
    }
    acc.attempts += 1;

    const latency = usableLatency(log.latency_ms);
    if (latency !== null) {
      acc.latencySum += latency;
      acc.latencySamples += 1;
    }

    if (Number.isFinite(log.hesitation_count) && log.hesitation_count > 0) {
      acc.hesitation += log.hesitation_count;
    }

    // 只有答错才谈错因。答对却带着错因的记录是脏数据，
    // 既不算进三种错因，也不算进 `unclassified`（它压根不是错题）。
    if (log.is_correct) continue;

    wrong += 1;
    acc.wrong += 1;
    if (at !== null && at > acc.lastWrongAt) acc.lastWrongAt = at;

    if (isErrorType(log.error_type)) {
      counts[log.error_type] += 1;
      acc.kinds.add(log.error_type);
    } else {
      unclassified += 1;
    }
  }

  const share = (count: number): number => (wrong > 0 ? count / wrong : 0);

  const byType: Record<ErrorType, ErrorTypeBucket> = {
    meaning: { count: counts.meaning, share: share(counts.meaning) },
    spelling: { count: counts.spelling, share: share(counts.spelling) },
    confusion: { count: counts.confusion, share: share(counts.confusion) },
  };

  const stubborn: StubbornWord[] = [];
  const slowest: SlowWord[] = [];
  const hesitant: HesitantWord[] = [];

  for (const [wordId, acc] of perWord) {
    if (acc.wrong >= 2) {
      stubborn.push({
        word_id: wordId,
        wrong: acc.wrong,
        attempts: acc.attempts,
        // 按固定顺序过滤，保证同一个词两次调用得到同一个数组
        kinds: ERROR_TYPES.filter((t) => acc.kinds.has(t)),
        last_wrong_at: Number.isFinite(acc.lastWrongAt) ? acc.lastWrongAt : null,
      });
    }

    if (acc.latencySamples >= minSlowSamples) {
      slowest.push({
        word_id: wordId,
        avg_latency_ms: Math.round(acc.latencySum / acc.latencySamples),
        samples: acc.latencySamples,
      });
    }

    if (acc.hesitation > 0) {
      hesitant.push({ word_id: wordId, hesitation: acc.hesitation, samples: acc.attempts });
    }
  }

  /**
   * 排序规则：错次多的先看；错次相同则最近错的先看；
   * 连时间都没有的排在有时间的后面（"知道它最近错过"比"不知道"更该先看）；
   * 最后用 `word_id` 兜底，保证同一份输入两次调用顺序一致。
   */
  const recency = (w: StubbornWord): number =>
    w.last_wrong_at === null ? Number.NEGATIVE_INFINITY : w.last_wrong_at;

  stubborn.sort((a, b) => {
    if (a.wrong !== b.wrong) return b.wrong - a.wrong;
    const ra = recency(a);
    const rb = recency(b);
    // 两个都是 -Infinity 时相等，落到 word_id 兜底，不会算出 NaN
    if (ra !== rb) return rb - ra;
    return a.word_id.localeCompare(b.word_id);
  });
  slowest.sort((a, b) => b.avg_latency_ms - a.avg_latency_ms || a.word_id.localeCompare(b.word_id));
  hesitant.sort(
    (a, b) => b.hesitation - a.hesitation || a.word_id.localeCompare(b.word_id),
  );

  return {
    total,
    wrong,
    byType,
    unclassified,
    stubborn: stubborn.slice(0, limit),
    slowest: slowest.slice(0, limit),
    hesitant: hesitant.slice(0, limit),
    // ⚠️ 这里判的是**作答总量**，不是错题量。
    // 5 道全对 → `ok` 且 byType 全 0，这是"确实没错"，
    // 与"样本不够、不知道"是两件事，不能混。
    confidence: total >= MIN_SAMPLES ? "ok" : "too_few_samples",
    ignored,
  };
}

/**
 * 针对每种错因给一个**具体动作**。
 *
 * 为什么要有这张表：只说「你拼写错了」等于没帮忙。
 * 三种错因对应三种完全不同的补救方式（见 `grade.ts` 开头），
 * 这张表是那个判断的出口，改口径只改这里。
 *
 * 不含任何人格评价，也不含"多练练"这种空话。
 */
export const REMEDY: Record<ErrorType, string> = {
  meaning: "把意思相近的几个词摆在一起对照一遍，看差别在哪",
  spelling: "按读音分段默写一遍，写的时候出声念",
  confusion: "把混的两个词记成一对，连着它们的例句一起看",
};

export function remedyFor(type: ErrorType): string {
  return REMEDY[type];
}

/**
 * 从归因结果里挑出**最该先补的一类**。
 *
 * 规则：错得最多的那类；并列时不猜，返回 `null` 让界面说"两类一样多"。
 * 返回 `null` 的另一个场合是样本不足 —— 少样本下挑"第一名"没有意义。
 */
export function topErrorType(result: ErrorAttribution): ErrorType | null {
  if (result.confidence === "too_few_samples") return null;
  if (result.wrong === 0) return null;

  let best: ErrorType | null = null;
  let bestCount = 0;
  let tie = false;

  for (const type of ERROR_TYPES) {
    const count = result.byType[type].count;
    if (count > bestCount) {
      best = type;
      bestCount = count;
      tie = false;
    } else if (count === bestCount && count > 0) {
      tie = true;
    }
  }

  return tie ? null : best;
}
