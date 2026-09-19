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
