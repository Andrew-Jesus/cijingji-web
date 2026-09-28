/**
 * 记账上云：**只测"行是怎么拼出来的"**，不测写库。
 *
 * 为什么不测 `persistAiUsage` 的网络那半段：
 * 那需要真 Supabase（或者一个假服务器），而它真正容易出错的地方不是"发没发出去"，
 * 是**拼行**——字段名与建表 SQL 对不对得上、失败的那几次有没有也记上、
 * 一次调用是不是只记一行。这些全是纯函数，测起来又快又稳。
 *
 * 网络那半段交给"真实浏览器 + 真项目"那轮验收（B3 闸门之一：
 * 云端条数与本机条数一致），那比任何 mock 都接近事实。
 */
import { describe, expect, it } from "vitest";

import type { AiUsageDraft } from "./contract";
import { buildUsageRows } from "./usageCloud";

const AT = new Date(2026, 8, 28, 10, 30, 0);

function draft(partial: Partial<AiUsageDraft> = {}): AiUsageDraft {
  return {
    task: "example_personalized",
    model: "deepseek-flash",
    input_tokens: 1200,
    output_tokens: 80,
    cached_tokens: 1150,
    cost_cny: 0.00042,
    priced: true,
    peak: false,
    latency_ms: 860,
    ok: true,
    ...partial,
  };
}

/** 可预测的 id 生成器 —— 断言 id 时才不会每次都不一样 */
function seqIds(): () => string {
  let n = 0;
  return () => `ai:test-${++n}`;
}

describe("buildUsageRows", () => {
  it("**每条草稿一行**，失败的那几次也算（记账不能只记成功的）", () => {
    const rows = buildUsageRows({
      usages: [
        draft(),
        draft({ model: "deepseek-flash", ok: false, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_cny: 0 }),
        draft({ model: "glm-4.7-flash", cost_cny: 0 }),
      ],
      userId: "u-1",
      at: AT,
      newId: seqIds(),
    });

    expect(rows).toHaveLength(3);
    expect(rows[1].ok).toBe(false);
    expect(rows.map((r) => r.id)).toEqual(["ai:test-1", "ai:test-2", "ai:test-3"]);
  });

  it("字段与建表 SQL 逐列对得上（列名写错在云端是静默丢数据）", () => {
    const [row] = buildUsageRows({ usages: [draft()], userId: "u-1", at: AT, newId: seqIds() });
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "user_id",
        "task",
        "model",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "cost_cny",
        "priced",
        "peak",
        "latency_ms",
        "ok",
        "created_at",
      ].sort(),
    );
    expect(row).toMatchObject({
      user_id: "u-1",
      task: "example_personalized",
      model: "deepseek-flash",
      input_tokens: 1200,
      cached_tokens: 1150,
      ok: true,
    });
  });

  it("同一批共用一个时间戳（便于按批核对，也免得同一秒里的几行互相对不齐）", () => {
    const rows = buildUsageRows({
      usages: [draft(), draft({ ok: false })],
      userId: "u-1",
      at: AT,
      newId: seqIds(),
    });
    expect(rows[0].created_at).toBe(AT.toISOString());
    expect(rows[1].created_at).toBe(AT.toISOString());
  });

  it("空账 → 空数组（一次调用都没发生时，不该凭空写一行）", () => {
    expect(buildUsageRows({ usages: [], userId: "u-1", at: AT })).toEqual([]);
  });

  it("默认 id 生成器带 `ai:` 前缀且互不相同", () => {
    const rows = buildUsageRows({ usages: [draft(), draft(), draft()], userId: "u-1", at: AT });
    for (const r of rows) expect(r.id.startsWith("ai:")).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });
});
