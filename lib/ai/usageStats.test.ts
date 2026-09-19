import { describe, expect, it } from "vitest";

import {
  EMPTY_USAGE_STATS,
  filterToday,
  formatCacheHitRate,
  summarizeUsage,
  type UsageLike,
} from "./usageStats";

/**
 * 时间全部用**本地时间**构造（`new Date(2026, 8, 19, h)`），
 * 这样无论 CI 跑在哪个时区，"今天"的判断都一致 ——
 * 用 `new Date("...Z")` 写的话，在 UTC-x 的机器上会被算到前一天，测试就飘了。
 */
const now = new Date(2026, 8, 19, 12, 0, 0); // 2026-09-19 12:00 本地时间

function at(day: number, hour: number): string {
  return new Date(2026, 8, day, hour, 0, 0).toISOString();
}

function row(partial: Partial<UsageLike> & { created_at: string }): UsageLike {
  return {
    task: "example_personalized",
    model: "deepseek-flash",
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cost_cny: 0,
    ok: true,
    priced: true,
    ...partial,
  };
}

describe("filterToday", () => {
  it("只留今天的（按本地时区，不是 UTC）", () => {
    const rows = [row({ created_at: at(19, 1) }), row({ created_at: at(18, 23) })];
    expect(filterToday(rows, now)).toHaveLength(1);
  });

  it("坏掉的时间戳直接丢掉，不参与统计", () => {
    const rows = [row({ created_at: "not-a-date" }), row({ created_at: at(19, 5) })];
    expect(filterToday(rows, now)).toHaveLength(1);
  });
});

describe("summarizeUsage", () => {
  it("没有记录 → has_data 为 false（「没调过」和「调了但没命中缓存」必须能区分）", () => {
    expect(summarizeUsage([], now)).toEqual(EMPTY_USAGE_STATS);
  });

  it("只有昨天的记录 → 也算「今天没调过」", () => {
    expect(summarizeUsage([row({ created_at: at(18, 10) })], now).has_data).toBe(false);
  });

  it("累加 tokens 与花费，并按 ok 分开数", () => {
    const s = summarizeUsage(
      [
        row({
          created_at: at(19, 9),
          input_tokens: 600,
          cached_tokens: 500,
          output_tokens: 60,
          cost_cny: 0.0003,
        }),
        row({ created_at: at(19, 10), input_tokens: 400, cached_tokens: 0, output_tokens: 40, ok: false }),
      ],
      now,
    );
    expect(s.calls).toBe(2);
    expect(s.ok_count).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.input_tokens).toBe(1000);
    expect(s.cached_tokens).toBe(500);
    expect(s.output_tokens).toBe(100);
  });

  it("花费累加后收掉浮点噪声（0.00030000000000000003 这种）", () => {
    const s = summarizeUsage(
      [row({ created_at: at(19, 9), cost_cny: 0.0001 }), row({ created_at: at(19, 10), cost_cny: 0.0002 })],
      now,
    );
    expect(s.cost_cny).toBe(0.0003);
  });

  it("缓存命中率 = 命中 / 输入 —— 这是「提示词前缀有没有被缓存住」的唯一证据", () => {
    const s = summarizeUsage(
      [row({ created_at: at(19, 9), input_tokens: 1000, cached_tokens: 900 })],
      now,
    );
    expect(s.cache_hit_rate).toBeCloseTo(0.9, 6);
  });

  it("输入为 0 时命中率是 0 而不是 NaN", () => {
    const s = summarizeUsage([row({ created_at: at(19, 9), output_tokens: 50 })], now);
    expect(s.cache_hit_rate).toBe(0);
    expect(Number.isNaN(s.cache_hit_rate)).toBe(false);
  });

  it("计价表里查不到的调用单独数出来（那几笔没计价，不是免费）", () => {
    const s = summarizeUsage(
      [
        row({ created_at: at(19, 9), model: "mystery", priced: false }),
        row({ created_at: at(19, 10) }),
      ],
      now,
    );
    expect(s.unpriced_model_calls).toBe(1);
  });

  it("旧记录没有 priced 字段时按「有价」处理（不知道就别乱报）", () => {
    const legacy: UsageLike = {
      task: "t",
      model: "deepseek-flash",
      input_tokens: 10,
      output_tokens: 10,
      cached_tokens: 0,
      cost_cny: 0.0001,
      ok: true,
      created_at: at(19, 9),
    };
    expect(summarizeUsage([legacy], now).unpriced_model_calls).toBe(0);
  });

  it("按模型分组、调用多的排前面", () => {
    const s = summarizeUsage(
      [
        row({ created_at: at(19, 9), model: "glm-4.7-flash" }),
        row({ created_at: at(19, 10), model: "deepseek-flash" }),
        row({ created_at: at(19, 11), model: "deepseek-flash" }),
      ],
      now,
    );
    expect(s.by_model[0]).toMatchObject({ model: "deepseek-flash", calls: 2 });
    expect(s.by_model[1]).toMatchObject({ model: "glm-4.7-flash", calls: 1 });
  });
});

describe("formatCacheHitRate", () => {
  it("整数百分比，不装精确", () => {
    expect(formatCacheHitRate(0)).toBe("0%");
    expect(formatCacheHitRate(0.876)).toBe("88%");
    expect(formatCacheHitRate(1)).toBe("100%");
  });
});
