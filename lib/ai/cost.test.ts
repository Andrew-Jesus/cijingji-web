import { describe, expect, it } from "vitest";

import {
  PEAK_MULTIPLIER,
  estimateCost,
  isPeakHour,
  priceFor,
  type TokenUsage,
} from "./cost";

/**
 * 时间点都要显式构造，不能用 `new Date()` —— 否则测试的结果取决于
 * "跑测试的时刻"，白天跑绿、半夜跑红，那种测试比没有更糟。
 *
 * 2026-09-19 是周六，09-21 是周一。
 */
const mondayOffPeak = new Date("2026-09-21T05:00:00Z"); // UTC 05:00，不在高峰窗口
const mondayPeak = new Date("2026-09-21T02:00:00Z"); // UTC 02:00，落在 [1,4)
const saturdayPeakHours = new Date("2026-09-19T02:00:00Z"); // 周末的高峰窗口内

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cached_tokens: 0, ...partial };
}

describe("isPeakHour / 高峰时段判定", () => {
  it("工作日的高峰窗口内 → true", () => {
    expect(isPeakHour(mondayPeak)).toBe(true);
  });

  it("工作日的窗口外 → false", () => {
    expect(isPeakHour(mondayOffPeak)).toBe(false);
  });

  it("窗口边界：左闭右开（04:00 已经不算高峰）", () => {
    expect(isPeakHour(new Date("2026-09-21T03:59:00Z"))).toBe(true);
    expect(isPeakHour(new Date("2026-09-21T04:00:00Z"))).toBe(false);
  });

  it("周末即使落在窗口内也不算高峰（按官方英文文档的口径）", () => {
    expect(isPeakHour(saturdayPeakHours)).toBe(false);
  });
});

describe("priceFor / 按模型名找单价", () => {
  it("带版本后缀的模型名也能匹配（用子串，不用精确相等）", () => {
    expect(priceFor("deepseek-flash-2026-09")).not.toBeNull();
    expect(priceFor("DeepSeek-V4-Flash")).not.toBeNull();
  });

  it("大小写不敏感", () => {
    expect(priceFor("GLM-4.7-Flash")).not.toBeNull();
  });

  it("免费兜底档的单价是 0（是真的 0，不是查不到）", () => {
    expect(priceFor("glm-4.7-flash")).toEqual({ in_miss: 0, in_hit: 0, out: 0 });
  });

  it("查不到 → null（调用方必须处理「没价」，不许当 0）", () => {
    expect(priceFor("some-unknown-model")).toBeNull();
  });
});

describe("estimateCost / 计价", () => {
  it("空闲时段：按未命中单价算输入", () => {
    const r = estimateCost("deepseek-flash", usage({ input_tokens: 1_000_000 }), mondayOffPeak);
    expect(r.priced).toBe(true);
    expect(r.peak).toBe(false);
    expect(r.cost_cny).toBeCloseTo(1.5, 6);
  });

  it("高峰时段是同量的 PEAK_MULTIPLIER 倍", () => {
    const off = estimateCost("deepseek-flash", usage({ input_tokens: 1_000_000 }), mondayOffPeak);
    const peak = estimateCost("deepseek-flash", usage({ input_tokens: 1_000_000 }), mondayPeak);
    expect(peak.cost_cny).toBeCloseTo(off.cost_cny * PEAK_MULTIPLIER, 6);
  });

  it("缓存命中的部分**从「未命中」里扣掉**，不重复计费", () => {
    const allMiss = estimateCost("deepseek-flash", usage({ input_tokens: 1_000_000 }), mondayOffPeak);
    const halfHit = estimateCost(
      "deepseek-flash",
      usage({ input_tokens: 1_000_000, cached_tokens: 500_000 }),
      mondayOffPeak,
    );
    // 一半命中 → 必须比"全未命中"便宜，且不是简单地打对折（命中价远比未命中低）
    expect(halfHit.cost_cny).toBeLessThan(allMiss.cost_cny);
    expect(halfHit.cost_cny).toBeGreaterThan(allMiss.cost_cny / 2);
  });

  it("缓存命中数超过输入数时不出现负数（脏数据不该算出负账）", () => {
    const r = estimateCost(
      "deepseek-flash",
      usage({ input_tokens: 100, cached_tokens: 999 }),
      mondayOffPeak,
    );
    expect(r.cost_cny).toBeGreaterThanOrEqual(0);
  });

  it("输出单独按输出价算", () => {
    const r = estimateCost("deepseek-flash", usage({ output_tokens: 1_000_000 }), mondayOffPeak);
    expect(r.cost_cny).toBeCloseTo(4.5, 6);
  });

  it("免费档算出来是 0，但 priced 是 true ——「0 元」和「没价」是两件事", () => {
    const r = estimateCost("glm-4.7-flash", usage({ input_tokens: 10_000 }), mondayOffPeak);
    expect(r.cost_cny).toBe(0);
    expect(r.priced).toBe(true);
  });

  it("查不到价格 → priced:false（那 0 元代表「不知道」，不是免费）", () => {
    const r = estimateCost("mystery-model", usage({ input_tokens: 10_000 }), mondayOffPeak);
    expect(r.priced).toBe(false);
    expect(r.cost_cny).toBe(0);
  });

  it("一次例句调用的量级：约 0.0003 元（6 位小数保得住，2 位就会变成 0.00）", () => {
    // 提示词约 600 输入 tokens（其中大部分命中缓存）+ 60 输出 tokens
    const r = estimateCost(
      "deepseek-flash",
      usage({ input_tokens: 600, cached_tokens: 520, output_tokens: 60 }),
      mondayOffPeak,
    );
    expect(r.cost_cny).toBeGreaterThan(0);
    expect(r.cost_cny).toBeLessThan(0.001);
  });
});
