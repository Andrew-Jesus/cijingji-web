/**
 * 记账上云：两层各测一半。
 *
 * · **拼行**（`buildUsageRows`，纯函数）：字段名与建表 SQL 对不对得上、
 *   失败的那几次有没有也记上、一次调用是不是只记一行。又快又稳。
 * · **分支**（`persistAiUsage`，把两个依赖打桩掉）：哪些情况该写、哪些该跳过。
 *   2026-09-28 补 —— 洞八（"没登录就不记账"）恰恰藏在分支里：
 *   纯函数那半段全绿，钱却在悄悄漏记，而且**不报任何错**。
 *   这一条教训值得记住：分支逻辑不测，闸门就整类地漏。
 *
 * 至于"网络真的发出去了吗"：那需要真 Supabase，交给 B3 的端到端验收
 * （云端条数与本机条数一致），比任何 mock 都接近事实。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiUsageDraft } from "./contract";
import type { AiUsageRow } from "./usageCloud";

/**
 * 两个依赖都要打桩。
 *
 * `vi.hoisted` 不能省：`vi.mock` 的工厂函数会被提升到所有 `import` 之前执行，
 * 那时普通 `const` 还没初始化 —— 直接引用会 `ReferenceError`。
 */
const { insertSpy, readUserIdSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn<(rows: unknown[]) => Promise<{ error: { message: string } | null }>>(),
  readUserIdSpy: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert: insertSpy }) }),
}));

vi.mock("@/lib/supabase/server", () => ({
  readServerUserId: readUserIdSpy,
}));

import { buildUsageRows, persistAiUsage } from "./usageCloud";

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

  it("身份读不出来 → user_id 写 null，**不是不写**（洞八）", () => {
    const [row] = buildUsageRows({ usages: [draft()], userId: null, at: AT, newId: seqIds() });
    expect(row.user_id).toBeNull();
  });
});

describe("persistAiUsage —— 哪些该写、哪些该跳过", () => {
  beforeEach(() => {
    insertSpy.mockReset();
    insertSpy.mockResolvedValue({ error: null });
    readUserIdSpy.mockReset();
    readUserIdSpy.mockResolvedValue("u-1");
  });

  it("**没登录也必须写**（§8.3 硬约束：没有用户也要记）", async () => {
    readUserIdSpy.mockResolvedValue(null);

    const r = await persistAiUsage([draft()], [], AT);

    // 这一条红了 = 又退回了"没登录就不记账"，成本会从账面上悄悄消失
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(r.skipped).toBeNull();
    expect(r.written).toBe(1);
    expect(r.ownerless).toBe(1);

    const rows = insertSpy.mock.calls[0][0] as AiUsageRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].cost_cny).toBe(0.00042); // 钱数照记，一个字都不能少
  });

  it("有身份时落在本人名下，且不算无主", async () => {
    const r = await persistAiUsage([draft()], [], AT);

    const rows = insertSpy.mock.calls[0][0] as AiUsageRow[];
    expect(rows[0].user_id).toBe("u-1");
    expect(r.ownerless).toBe(0);
    expect(r.skipped).toBeNull();
  });

  it("失败的那几次也要写进去（不能只记成功的）", async () => {
    const r = await persistAiUsage([draft(), draft({ ok: false, cost_cny: 0 })], [], AT);

    const rows = insertSpy.mock.calls[0][0] as AiUsageRow[];
    expect(rows).toHaveLength(2);
    expect(rows[1].ok).toBe(false);
    expect(r.written).toBe(2);
  });

  it("一次调用都没发生 → 不写（这是**允许**跳过的情况之一，另不许再加）", async () => {
    const r = await persistAiUsage([], [], AT);

    expect(insertSpy).not.toHaveBeenCalled();
    expect(r.skipped).toBe("no_call_happened");
  });

  it("写库报错 → 吞掉，只留一句说明（用户不该看见记账失败）", async () => {
    insertSpy.mockResolvedValue({ error: { message: "boom" } });

    const r = await persistAiUsage([draft()], [], AT);

    expect(r.written).toBe(0);
    expect(r.ownerless).toBe(0);
    expect(r.skipped).toContain("insert_failed");
  });
});
