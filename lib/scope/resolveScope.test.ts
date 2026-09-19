import { describe, expect, it } from "vitest";

import type { Sense, Unit, Word, WordPlacement } from "@/lib/db/types";
import bundleJson from "@/lib/db/seed-data.json";
import { defaultScope, type ScopeJson } from "@/lib/scope/schema";
import { resolveScope, type WordSnapshot } from "@/lib/scope/resolveScope";

const bundle = bundleJson as unknown as {
  units: Unit[];
  words: Word[];
  senses: Sense[];
  word_placements: WordPlacement[];
};

const snapshot: WordSnapshot = {
  units: bundle.units,
  words: bundle.words,
  senses: bundle.senses,
  placements: bundle.word_placements,
};

const U1 = "renjiao_2024:8A:U1";
const U2 = "renjiao_2024:8A:U2";
const U3 = "renjiao_2024:8A:U3";

const scopeOf = (units: string[], extra: Partial<ScopeJson> = {}): ScopeJson => ({
  v: 1,
  include: [
    {
      type: "curriculum_unit",
      curriculum: "renjiao_2024",
      volume: "renjiao_2024:8A",
      units,
    },
  ],
  ...extra,
});

describe("resolveScope（跑在真实样张数据上）", () => {
  it("Unit 1 解析出 53 个词（与种子报告一致）", () => {
    const result = resolveScope(scopeOf([U1]), snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.words).toHaveLength(53);
      expect(result.words.every((w) => w.unit_code === "Unit 1")).toBe(true);
    }
  });

  it("每个词都带义项与释义（不能只有词头）", () => {
    const result = resolveScope(scopeOf([U1]), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words.every((w) => w.sense_id !== null)).toBe(true);
    expect(result.words.every((w) => (w.meaning_zh ?? "").length > 0)).toBe(true);
  });

  it("确定性排序：同输入两次结果完全一致", () => {
    const a = resolveScope(scopeOf([U1, U2]), snapshot);
    const b = resolveScope(scopeOf([U1, U2]), snapshot);
    if (!a.ok || !b.ok) throw new Error("范围应可解析");
    expect(a.words.map((w) => w.word_id)).toEqual(b.words.map((w) => w.word_id));
  });

  it("多单元并集去重：U2+U3 共 103 词（mm 在两边都出现，只算一次）", () => {
    const result = resolveScope(scopeOf([U2, U3]), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words).toHaveLength(49 + 55 - 1);
    const mm = result.words.filter((w) => w.lemma === "mm");
    expect(mm).toHaveLength(1);
  });

  it("confidence 原样透出（0.75，界面据此标注「可能不准」）", () => {
    const result = resolveScope(scopeOf([U1]), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.confidence).toBeCloseTo(0.75, 5);
    expect(result.words.every((w) => w.confidence === 0.75)).toBe(true);
  });

  it("limit 截断生效", () => {
    const result = resolveScope(scopeOf([U1], { limit: 10 }), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words).toHaveLength(10);
  });
});

describe("resolveScope 的失败分支（不接受静默失败）", () => {
  it("单元不存在 → SCOPE_TARGET_NOT_FOUND，并列出是哪个", () => {
    const result = resolveScope(scopeOf(["renjiao_2024:8A:U99"]), snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SCOPE_TARGET_NOT_FOUND");
      expect(result.details).toContain("renjiao_2024:8A:U99");
    }
  });

  it("core_only → 明确拒绝，而不是装作能筛", () => {
    const result = resolveScope(scopeOf([U1], { include: [{ type: "curriculum_unit", units: [U1], core_only: true }] }), snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_FILTER");
  });

  it("尚未实现的 include 类型 → UNSUPPORTED_SCOPE_TYPE", () => {
    const result = resolveScope(
      { v: 1, include: [{ type: "exam_syllabus", exam: "zhongkao" }] },
      snapshot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_SCOPE_TYPE");
  });

  it("范围内没有词 → EMPTY_RESULT（与「范围不存在」可区分）", () => {
    const result = resolveScope(
      scopeOf([U1], { include: [{ type: "curriculum_unit", units: [U1], roles: ["review"] }] }),
      snapshot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EMPTY_RESULT");
  });

  it("默认范围能解析出词（冷启动的入口不能是坏的）", () => {
    const result = resolveScope(defaultScope(), snapshot);
    expect(result.ok).toBe(true);
  });
});
