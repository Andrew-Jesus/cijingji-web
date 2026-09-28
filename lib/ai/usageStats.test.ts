import { describe, expect, it } from "vitest";

import {
  EMPTY_USAGE_STATS,
  filterToday,
  formatCacheHitRate,
  startOfLocalDay,
  summarizeUsage,
  toUsageLike,
  usageOriginNote,
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

describe("startOfLocalDay", () => {
  it("给的是本机时区的 0 点，不是 UTC 的", () => {
    const start = startOfLocalDay(now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(19);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("**不改调用方传进来的那个对象**", () => {
    // 这类"函数偷偷改了你的东西"的副作用，不写成断言就永远不会被发现
    const input = new Date(2026, 8, 19, 15, 30, 0);
    const before = input.getTime();
    startOfLocalDay(input);
    expect(input.getTime()).toBe(before);
  });

  it("凌晨 1 点与晚上 11 点落到同一个 0 点（跨日的边界在 0 点，不在 UTC 0 点）", () => {
    expect(startOfLocalDay(new Date(2026, 8, 19, 1, 5, 0)).getTime()).toBe(
      startOfLocalDay(new Date(2026, 8, 19, 23, 55, 0)).getTime(),
    );
  });
});

describe("toUsageLike：云端行 → 汇总行", () => {
  it("字段逐个对上，数字收敛成 number", () => {
    const row = toUsageLike({
      task: "example_personalized",
      model: "deepseek-flash",
      input_tokens: 1200,
      output_tokens: 80,
      cached_tokens: 1100,
      cost_cny: 0.0003,
      priced: true,
      ok: true,
      created_at: at(19, 10),
    });
    expect(row).toEqual({
      task: "example_personalized",
      model: "deepseek-flash",
      input_tokens: 1200,
      output_tokens: 80,
      cached_tokens: 1100,
      cost_cny: 0.0003,
      priced: true,
      ok: true,
      created_at: at(19, 10),
    });
  });

  it("`numeric` 列回来是字符串也能算（不只是 number）", () => {
    // PostgREST 把 numeric 序列化成什么，取决于版本与精度；两种都得认，
    // 否则某天升一次 Supabase 就会让所有金额静默归零
    const row = toUsageLike({ cost_cny: "0.000300", input_tokens: "1500", ok: true });
    expect(row.cost_cny).toBe(0.0003);
    expect(row.input_tokens).toBe(1500);
  });

  it("缺字段与脏数据都收敛成 0 / 空串，不产生 NaN", () => {
    const row = toUsageLike({ ok: "true" });
    expect(row.input_tokens).toBe(0);
    expect(row.cost_cny).toBe(0);
    expect(row.created_at).toBe("");
    // ok 用严格 `=== true`：字符串 "true" 不算成功 —— 云端列是 boolean，
    // 收到字符串说明这一列对不上，宁可算成失败也别把失败记成成功
    expect(row.ok).toBe(false);
  });

  it("`priced` 字段缺失时留 undefined（「不知道」不等于「没计价」）", () => {
    expect(toUsageLike({ ok: true }).priced).toBeUndefined();
    expect(toUsageLike({ ok: true, priced: false }).priced).toBe(false);
  });

  it("收敛出来的行能直接喂给 summarizeUsage", () => {
    const s = summarizeUsage(
      [toUsageLike({ task: "t", model: "deepseek-flash", input_tokens: 100, cached_tokens: 50, cost_cny: 0.001, priced: true, ok: true, created_at: at(19, 10) })],
      now,
    );
    expect(s.calls).toBe(1);
    expect(s.cache_hit_rate).toBeCloseTo(0.5, 6);
    expect(s.cost_cny).toBe(0.001);
  });
});

describe("usageOriginNote：什么时候该说一句", () => {
  it("云端的账且两边条数一致 → 不说话（别刷废话）", () => {
    expect(usageOriginNote({ origin: "cloud", cloudCount: 3, localCount: 3, cloudError: null })).toBe(
      null,
    );
  });

  it("两边都空 → 也不说话（今天没调过是正常状态，不是异常）", () => {
    expect(usageOriginNote({ origin: "cloud", cloudCount: 0, localCount: 0, cloudError: null })).toBe(
      null,
    );
  });

  it("云端与本地条数不一致 → 必须说出来（双写有一条链断了）", () => {
    const note = usageOriginNote({ origin: "cloud", cloudCount: 3, localCount: 2, cloudError: null });
    expect(note).toContain("3");
    expect(note).toContain("2");
    expect(note).toContain("没对上");
  });

  it("回落本机且有原因 → 说清这份账不是云端的、以及为什么", () => {
    const note = usageOriginNote({
      origin: "local",
      cloudCount: null,
      localCount: 2,
      cloudError: "操作超过 4000 毫秒还没结果",
    });
    expect(note).toContain("本机");
    expect(note).toContain("4000");
  });

  it("回落本机但没有原因 → 不说（没话可说的时候别硬凑一句）", () => {
    expect(usageOriginNote({ origin: "local", cloudCount: null, localCount: 2, cloudError: null })).toBe(
      null,
    );
  });

  it("未登录导致的回落 → 说「没登录」，**绝不能说成「两边没对上」**", () => {
    // 未登录时云端按规矩返回空数组（RLS 只放行自己的行），
    // 若照条数比就会把"正常状态"报成"双写断了一条链" ——
    // 那个警告一共只有三种真实成因，掺进一个恒假的就等于把它废掉
    const note = usageOriginNote({
      origin: "local",
      cloudCount: null,
      localCount: 3,
      cloudError: "这台设备上没登录",
    });
    expect(note).toContain("没登录");
    expect(note).not.toContain("没对上");
  });
});
