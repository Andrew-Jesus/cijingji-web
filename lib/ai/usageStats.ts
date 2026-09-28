/**
 * AI 记账的汇总 —— 纯函数，可单测
 *
 * 这份汇总的唯一消费者是**开发者模式**。
 * 为什么它值得存在：硬约束要求"每次调用必须记账"，但记完不看等于没记。
 * 这套提示词设计的省钱效果（固定前缀吃缓存）**只能通过缓存命中率验证**，
 * 而命中率只有在把 tokens 分开记之后才算得出来。
 *
 * 所以这里刻意把 `cache_hit_rate` 放在最显眼的位置 —— 它是"省钱设计有没有生效"
 * 的唯一仪表盘。命中率掉到 0 通常意味着有人往稳定前缀里塞了变化的东西
 * （日期、随机数、用户昵称），那是要立刻修的问题。
 */
import { localDayKey } from "@/lib/plan/todayProgress";

/** `db.ai_usage` 行的最小子集 —— 只要用得上的字段，测试不必造一整行 */
export interface UsageLike {
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_cny: number;
  ok: boolean;
  created_at: string;
  /**
   * 这笔账有没有价。
   * 旧行没有这个字段时按"有价"处理 —— 因为**无法判断**，
   * 而把"不知道"报成"很多次没计价"会造成另一种误导。
   */
  priced?: boolean;
}

export interface ModelUsage {
  model: string;
  calls: number;
  cost_cny: number;
}

export interface UsageStats {
  calls: number;
  ok_count: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_cny: number;
  /** 0~1。**没有输入 tokens 时返回 0**（不是 NaN）—— 一次都没调过和"调了但没命中"是两件事，
   *  界面上要能区分，所以再给一个 `has_data`。 */
  cache_hit_rate: number;
  /** 价格表里没有的模型的调用次数。**这些账没计价，不是免费** */
  unpriced_model_calls: number;
  by_model: ModelUsage[];
  has_data: boolean;
}

export const EMPTY_USAGE_STATS: UsageStats = {
  calls: 0,
  ok_count: 0,
  failed: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cost_cny: 0,
  cache_hit_rate: 0,
  unpriced_model_calls: 0,
  by_model: [],
  has_data: false,
};

/**
 * 只保留本地时区的今天（与今日进度同一个口径）。
 * 复用 `localDayKey` 而不是自己 `toISOString().slice(0,10)` ——
 * 后者是 UTC，东八区晚上 8 点之后会被算成"明天"，两处口径就不一致了。
 */
export function filterToday<T extends { created_at: string }>(rows: readonly T[], now: Date): T[] {
  const today = localDayKey(now);
  return rows.filter((r) => {
    const at = new Date(r.created_at);
    if (Number.isNaN(at.getTime())) return false;
    return localDayKey(at) === today;
  });
}

/**
 * 本地时区的"今天 0 点"。
 *
 * 给**云端查询**当边界用（B3）：浏览器那边不能问"给我今天的"，
 * 只能给一个时刻让数据库去比大小。这个时刻必须是**本机时区的 0 点**，
 * 否则东八区的用户从早上 8 点前调用的那几笔账查不回来
 * —— 和 `filterToday` 用 `localDayKey` 是同一个道理，两处口径必须一致。
 *
 * `new Date(now)` 是先拷一份再改：直接用 `now.setHours()` 会**改掉调用方那个对象**，
 * 这种"函数偷偷改了你的东西"的副作用，在真正出问题之前完全看不出来。
 */
export function startOfLocalDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 云端 `ai_usage` 行（PostgREST 返回的原始对象）。
 *
 * 这里刻意用 `unknown` 而不是 `any`：这两边是**跨进程的边界**，
 * 列名拼错、某列缺失、类型不对都是可能发生的，
 * 用 `any` 就等于把"收敛数据"这件事交给运气。
 */
export type CloudUsageRowLike = Record<string, unknown>;

/** 云端返回的数字收敛：`numeric` 列经 JSON 回来可能是 number 也可能是字符串 */
function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * 云端行 → 汇总用的行。
 *
 * **云端与本地这两份是同构的**（建表 SQL 就是照本地表建的），所以这里几乎是直搬。
 * 但要写出真正的意义：它是"两边条数一致"这个核对项成立的前提 ——
 * 口径不同（一边逐次、一边汇总，或字段缺失被算成 0）时，
 * 你根本分不清"账没记上"和"记上了但没显示"，而这两件事的处理方式完全不同。
 *
 * `priced` 特殊处理：云端列是 `not null default false`，理论上一定有值；
 * 万一这个字段缺失（旧数据、select 少列），返回 `undefined` 让它按
 * "不知道"走（`summarizeUsage` 里 `undefined` 不计入未计价次数），
 * 而不是把"不知道"硬说成"没计价"。
 */
export function toUsageLike(raw: CloudUsageRowLike): UsageLike {
  return {
    task: toStr(raw.task),
    model: toStr(raw.model),
    input_tokens: toNum(raw.input_tokens),
    output_tokens: toNum(raw.output_tokens),
    cached_tokens: toNum(raw.cached_tokens),
    cost_cny: toNum(raw.cost_cny),
    ok: raw.ok === true,
    created_at: toStr(raw.created_at),
    priced: typeof raw.priced === "boolean" ? raw.priced : undefined,
  };
}

/**
 * 这份账是从哪来的。
 *
 * `cloud` = 云端权威账；`local` = 本机那份离线副本（断网 / 没配 secret key 时的回落）。
 * 类型定义在这里而不是 `usageSource.ts`，是因为**下面那句提示语要用它**，
 * 而提示语是纯函数、要能单测 —— 不想为此把 supabase 客户端拖进测试里。
 */
export type UsageOrigin = "cloud" | "local";

export interface UsageOriginFacts {
  origin: UsageOrigin;
  /** 云端成功时的条数；没取到为 `null` */
  cloudCount: number | null;
  localCount: number;
  cloudError: string | null;
}

/**
 * 要不要在面板上说一句"这份账有点不对劲"。
 *
 * 三种情况逐条给理由：
 *   · **回落本机** —— 要说，而且要说清是为什么。否则看到"今天 3 次"的人
 *     根本不知道这数字是云端的还是本机的，遑论判断它可不可信。
 *   · **云端与本机条数不一致** —— 这是 B3 唯一真正要盯的信号：
 *     同一次调用，客户端写了、服务端没写（或反过来）。它意味着双写有一条链断了，
 *     而"账不准"这件事只会越攒越难查，必须当场看见。
 *   · **一致 / 两边都空** —— 不说话。两边都空是正常的（今天还没调过），
 *     一致更是正常。**开发者模式也不该刷废话**，否则真信号会被淹没。
 */
export function usageOriginNote(f: UsageOriginFacts): string | null {
  if (f.origin === "local") {
    if (!f.cloudError) return null;
    // `cloudError` 是一句**原因短语**（"这台设备上没登录" / "云端查询失败：…"），
    // 不是完整的句子 —— 这句话负责把它套进上下文，调用方只管道出原因
    return `这份账来自本机（${f.cloudError}）`;
  }
  if (f.cloudCount !== f.localCount) {
    return `云端 ${f.cloudCount} 条 · 本机 ${f.localCount} 条，两边没对上`;
  }
  return null;
}

/** 价格表里查不到的模型：`cost_cny` 记 0，但 `priced:false` 把"不知道"标出来 */
export function summarizeUsage(rows: readonly UsageLike[], now: Date): UsageStats {
  const today = filterToday(rows, now);
  if (today.length === 0) return EMPTY_USAGE_STATS;

  let okCount = 0;
  let failed = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let cost = 0;
  let unpriced = 0;

  const byModel = new Map<string, ModelUsage>();

  for (const row of today) {
    if (row.ok) okCount += 1;
    else failed += 1;

    input += row.input_tokens;
    output += row.output_tokens;
    cached += row.cached_tokens;
    cost += row.cost_cny;

    // 「价格表里没有这个模型」= 这笔账会显示成 ¥0，但它**不是免费的**。
    // 单独数出来，免得汇总出来的钱看起来比实际低。
    if (row.priced === false) unpriced += 1;

    const entry = byModel.get(row.model) ?? { model: row.model, calls: 0, cost_cny: 0 };
    entry.calls += 1;
    entry.cost_cny += row.cost_cny;
    byModel.set(row.model, entry);
  }

  return {
    calls: today.length,
    ok_count: okCount,
    failed,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    // 价格累加会出现 0.00030000000000000003 这种浮点噪声，落库/展示前统一收一下
    cost_cny: Math.round(cost * 1e6) / 1e6,
    cache_hit_rate: input > 0 ? cached / input : 0,
    unpriced_model_calls: unpriced,
    by_model: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    has_data: true,
  };
}

/** 百分比展示。命中率是"省钱指标"，所以小数位给到整数就够，别显得像精确测量 */
export function formatCacheHitRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
