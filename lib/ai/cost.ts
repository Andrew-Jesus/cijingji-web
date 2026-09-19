/**
 * AI 记账 —— 把 tokens 换算成钱
 *
 * 硬约束：**每次 AI 调用必须记账**，而且要**分开记** `input_tokens` /
 * `output_tokens` / `cached_tokens`。原因很实在：
 *   ① 只记一个总数，就看不出"缓存到底有没有生效"；
 *   ② 缓存命中率是这套提示词设计（固定前缀在前）的**唯一验收指标**，
 *      看不见命中率，就等于没法验证省钱设计是否成立；
 *   ③ 缓存命中的输入价与未命中差 30~60 倍，混在一起算出来的钱没有意义。
 *
 * ── 价格表怎么维护 ────────────────────────────────────────────
 * 价格是**外部事实**，会变。所以：
 *   · 全项目只有这一个文件放价格；
 *   · 表里存的是**空闲时段（off-peak）单价**，高峰时段用 `PEAK_MULTIPLIER` 翻倍
 *     （官方定价规则：高峰 = 空闲 × 2）；
 *   · 查不到价格的模型**记 0 但返回 `priced: false`** —— 如实说"这次没计价"，
 *     而不是报一个看起来精确的假数字（假设价格表的默认值是 0 才是真的在骗人）。
 *
 * 数据来源（2026-09-19 现查）：
 *   · DeepSeek 官方 API 文档「Models & Pricing」+ 8 月调价的国内媒体公告
 *   · 智谱 BigModel 价格页（GLM-4.7-Flash / 4.5-Flash 输入输出缓存全免费）
 *
 * ⚠️ 一处**已知的源头冲突**（如实记下来，不装作没看见）：
 *   官方英文文档写高峰时段是「周一至周五」的 UTC 01:00–04:00 与 06:00–10:00；
 *   国内公告的措辞是「每日」。二者对周末的判定不同。
 *   这里按官方英文文档（周一至周五）实现 —— **判据只有 `isPeakHour` 一个函数**，
 *   源头澄清后改这一处即可。
 */

/** 空闲时段单价，单位：元 / 百万 tokens */
export interface PriceSpec {
  /** 输入 · 缓存未命中 */
  in_miss: number;
  /** 输入 · 缓存命中（便宜到几乎为零，这正是"固定前缀在前"的动力） */
  in_hit: number;
  /** 输出 */
  out: number;
}

export interface PriceEntry {
  /** 用**子串**匹配模型名：模型名会带版本后缀，精确相等太脆 */
  match: string;
  price: PriceSpec;
  note: string;
}

/** 高峰时段系数。官方规则：高峰价格为空闲的 2 倍 */
export const PEAK_MULTIPLIER = 2;

/**
 * 高峰时段（UTC 小时，左闭右开）。
 * 对应北京时间 09:00–12:00 与 14:00–18:00 —— 正好是学生写作业的时间段，
 * 所以这个系数对本产品**不是理论问题**，是要认真记账的。
 */
export const PEAK_HOURS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

/** 高峰只在工作日生效（周末全天按空闲价） */
export const PEAK_WEEKDAYS_ONLY = true;

export const PRICE_TABLE: PriceEntry[] = [
  {
    match: "deepseek-v4-flash",
    price: { in_miss: 1.5, in_hit: 0.05, out: 4.5 },
    note: "DeepSeek Flash（旧名，仍被接受并由 V4.1 Flash 承接）",
  },
  {
    match: "deepseek-flash",
    price: { in_miss: 1.5, in_hit: 0.05, out: 4.5 },
    note: "DeepSeek Flash（现行规范名）",
  },
  {
    match: "deepseek-v4-pro",
    price: { in_miss: 4.5, in_hit: 0.15, out: 13.5 },
    note: "DeepSeek Pro。2026-09-14 起请求被路由到 V4.1 Flash 并按 Flash 价计费，此价仅备查",
  },
  {
    match: "glm-4.7-flash",
    price: { in_miss: 0, in_hit: 0, out: 0 },
    note: "智谱免费兜底档（输入/输出/缓存全免费）",
  },
  {
    match: "glm-4.5-flash",
    price: { in_miss: 0, in_hit: 0, out: 0 },
    note: "智谱免费兜底档",
  },
];

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface CostResult {
  cost_cny: number;
  /** false = 价格表里查不到这个模型，上面那个 0 **不代表免费** */
  priced: boolean;
  /** 计价当时是不是高峰时段，便于复核"为什么这次贵" */
  peak: boolean;
}

/** 现在是高峰时段吗？`PEAK_WEEKDAYS_ONLY` 为真时周末全天不算 */
export function isPeakHour(at: Date): boolean {
  if (PEAK_WEEKDAYS_ONLY) {
    const day = at.getUTCDay(); // 0=周日, 6=周六
    if (day === 0 || day === 6) return false;
  }
  const h = at.getUTCHours();
  return PEAK_HOURS_UTC.some(([from, to]) => h >= from && h < to);
}

/** 按模型名找单价。查不到返回 null —— 调用方必须处理"没价"这个情况，不许静默当 0 */
export function priceFor(model: string): PriceSpec | null {
  const lower = model.toLowerCase();
  return PRICE_TABLE.find((e) => lower.includes(e.match))?.price ?? null;
}

/**
 * 精确到小数点后 6 位。
 * 一次调用通常是 0.0003 元左右 —— 保留两位小数会全部变成 0.00，等于没记。
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function estimateCost(model: string, usage: TokenUsage, at: Date): CostResult {
  const price = priceFor(model);
  const peak = isPeakHour(at);

  if (!price) return { cost_cny: 0, priced: false, peak };

  // 缓存命中的部分**要从"未命中"里扣掉**：它是同一批输入 tokens 的两个部分，
  // 直接相加会把输入算两遍，账就虚高了。
  const missTokens = Math.max(usage.input_tokens - usage.cached_tokens, 0);
  const hitTokens = Math.max(usage.cached_tokens, 0);

  const mul = peak ? PEAK_MULTIPLIER : 1;
  const perMillion = 1e6;

  const cost =
    (missTokens * price.in_miss * mul + hitTokens * price.in_hit * mul + usage.output_tokens * price.out * mul) /
    perMillion;

  return { cost_cny: round6(cost), priced: true, peak };
}
