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

const U1 = "wys_2024:8A:U1";
const U2 = "wys_2024:8A:U2";
const U3 = "wys_2024:8A:U3";

const scopeOf = (units: string[], extra: Partial<ScopeJson> = {}): ScopeJson => ({
  v: 1,
  include: [
    {
      type: "curriculum_unit",
      curriculum: "wys_2024",
      volume: "wys_2024:8A",
      units,
    },
  ],
  ...extra,
});

/**
 * 某几个单元在种子数据里一共放了几个词 —— **按 word_id 去重**，与 resolveScope 的口径一致。
 *
 * 为什么不写死数字：单元词数会随「加册」「词表收不收短语」变化，
 * 写死意味着每加一次数据就要改一遍测试 —— 而"改测试去迁就数据"
 * 正是把真问题放过去的那条路。断言改成"解析结果 == 种子事实"就永远有效。
 */
function placedWordCount(unitIds: string[]): number {
  const want = new Set(unitIds);
  return new Set(
    bundle.word_placements.filter((p) => want.has(p.unit_id)).map((p) => p.word_id),
  ).size;
}

describe("resolveScope（跑在真实数据上 —— 外研社八上）", () => {
  it("Unit 1 解析出的词数 = 种子数据里该单元的去重词数", () => {
    const result = resolveScope(scopeOf([U1]), snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.words).toHaveLength(placedWordCount([U1]));
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

  it("多单元并集：词数 = 两个单元去重后的并集（数字从种子算）", () => {
    const result = resolveScope(scopeOf([U2, U3]), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words).toHaveLength(placedWordCount([U2, U3]));
    // 并集里不能有重复词 —— 去重坏了 = 同一个词今天要背两遍
    expect(new Set(result.words.map((w) => w.word_id)).size).toBe(result.words.length);
  });

  it("同一词出现在两个单元 → 只算一次（构造快照；真数据里没有这种词，所以要自己造）", () => {
    // 这条路径必须留着测：**去重逻辑一旦坏了，症状是"同一个词今天要背两遍"**，
    // 而且只在"某词跨单元出现"时才发作 —— 等真碰上就晚了。
    const shared = snapshot.words[0];
    const p2 = snapshot.placements.find((p) => p.unit_id === U2);
    const p3 = snapshot.placements.find((p) => p.unit_id === U3);
    if (!p2 || !p3) throw new Error("测试前提：U2/U3 都应有归属记录");

    const synthetic: WordSnapshot = {
      units: snapshot.units,
      words: snapshot.words,
      senses: snapshot.senses,
      placements: [
        { ...p2, id: "synthetic-u2", word_id: shared.id },
        { ...p3, id: "synthetic-u3", word_id: shared.id },
      ],
    };

    const result = resolveScope(scopeOf([U2, U3]), synthetic);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words).toHaveLength(1);
    expect(result.words[0].word_id).toBe(shared.id);
  });

  it("confidence 原样透出（0.95 = 已按口径 v2 逐字段核验）", () => {
    const result = resolveScope(scopeOf([U1]), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.confidence).toBeCloseTo(0.95, 5);
    expect(result.words.every((w) => w.confidence === 0.95)).toBe(true);
  });

  it("limit 截断生效", () => {
    const result = resolveScope(scopeOf([U1], { limit: 10 }), snapshot);
    if (!result.ok) throw new Error("范围应可解析");
    expect(result.words).toHaveLength(10);
  });
});

describe("resolveScope 的失败分支（不接受静默失败）", () => {
  it("单元不存在 → SCOPE_TARGET_NOT_FOUND，并列出是哪个", () => {
    const result = resolveScope(scopeOf(["wys_2024:8A:U99"]), snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SCOPE_TARGET_NOT_FOUND");
      expect(result.details).toContain("wys_2024:8A:U99");
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
