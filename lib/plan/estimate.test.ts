import { describe, expect, it } from "vitest";

import { DEFAULT_SECONDS_PER_ITEM, dailyCapFor, secondsForMode } from "@/lib/plan/estimate";
import { LIMITS } from "@/lib/scope/schema";

describe("secondsForMode", () => {
  it("已知模式返回自己的参数", () => {
    expect(secondsForMode("recognize")).toBe(12);
    expect(secondsForMode("recall_spell")).toBe(25);
  });

  it("未知模式走默认值，不返回 undefined（否则估算会变成 NaN）", () => {
    expect(secondsForMode("something-new")).toBe(DEFAULT_SECONDS_PER_ITEM);
  });
});

describe("dailyCapFor（分钟 → 词数，结果页与首页的唯一来源）", () => {
  it("15 分钟 · 拼写模式（25s/词）→ 36 词", () => {
    expect(dailyCapFor(15, "recall_spell", LIMITS.daily_cap)).toBe(36);
  });

  it("15 分钟 · 认词模式（12s/词）→ 75 词，但被安全阀截到 50", () => {
    expect(dailyCapFor(15, "recognize", LIMITS.daily_cap)).toBe(50);
  });

  it("10 分钟 · 拼写模式 → 24 词", () => {
    expect(dailyCapFor(10, "recall_spell", LIMITS.daily_cap)).toBe(24);
  });

  it("时间越长词越多（单调不减）", () => {
    const caps = [10, 15, 20, 30].map((m) => dailyCapFor(m, "recall_spell", LIMITS.daily_cap));
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
  });

  it("分钟数为 0 / 负数 / NaN → 兜底 1，不返回 0 或 NaN", () => {
    expect(dailyCapFor(0, "recall_spell", 50)).toBe(1);
    expect(dailyCapFor(-5, "recall_spell", 50)).toBe(1);
    expect(dailyCapFor(NaN, "recall_spell", 50)).toBe(1);
  });

  it("永远不超过安全阀", () => {
    expect(dailyCapFor(600, "recall_spell", LIMITS.daily_cap)).toBe(LIMITS.daily_cap);
  });

  it("永远至少 1 个（否则任务单会是空的）", () => {
    expect(dailyCapFor(0.1, "recall_spell", 50)).toBeGreaterThanOrEqual(1);
  });
});
