import { describe, expect, it } from "vitest";

import type { Pace } from "@/lib/db/types";
import { buildDailyPlan, chooseMode, WEIGHT_FRESH, WEIGHT_WEAK } from "@/lib/plan/buildDailyPlan";
import type { WordRef } from "@/lib/scope/resolveScope";

const paceOf = (over: Partial<Pace> = {}): Pace => ({
  new_ratio: 0.6,
  session_size: 20,
  spelling_required: true,
  speed_drill: false,
  review_priority: "weak_first",
  ...over,
});

/** 造 30 个词，避免依赖真实数据的具体条数 */
const makeWords = (n: number): WordRef[] =>
  Array.from({ length: n }, (_, i) => ({
    word_id: `w:${i}`,
    lemma: `word${String(i).padStart(2, "0")}`,
    phonetic_uk: null,
    sense_id: `s:${i}`,
    sense_pos: "n.",
    meaning_zh: `释义${i}`,
    unit_id: "u1",
    unit_code: "Unit 1",
    role: "new" as const,
    confidence: 0.75,
  }));

describe("buildDailyPlan", () => {
  it("按 daily_cap 截断，不多给", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items).toHaveLength(20);
  });

  it("幂等：同输入两次结果完全一致（不掺时间、不掺随机）", () => {
    const input = { words: makeWords(30), daily_cap: 20, pace: paceOf() };
    const a = buildDailyPlan(input);
    const b = buildDailyPlan(input);
    expect(a.items.map((i) => i.word_id)).toEqual(b.items.map((i) => i.word_id));
    expect(a.estimated_minutes).toBe(b.estimated_minutes);
  });

  it("错词排在最前面，且权重更高", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      weak_word_ids: ["w:25", "w:26"],
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items[0].word_id).toBe("w:25");
    expect(out.items[0].priority_score).toBe(WEIGHT_WEAK);
    expect(out.items.filter((i) => i.priority_score === WEIGHT_FRESH).length).toBeGreaterThan(0);
  });

  it("某一类不够时用另一类补足（不会只给 3 个词）", () => {
    const out = buildDailyPlan({
      words: makeWords(10),
      weak_word_ids: [],
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items).toHaveLength(10); // 词不够就给全部，但不报错
  });

  it("用时估算随模式变化：考拼写比只认词更慢", () => {
    const spelling = buildDailyPlan({ words: makeWords(20), daily_cap: 20, pace: paceOf({ spelling_required: true }) });
    const recognize = buildDailyPlan({ words: makeWords(20), daily_cap: 20, pace: paceOf({ spelling_required: false }) });
    expect(spelling.estimated_minutes).toBeGreaterThan(recognize.estimated_minutes);
  });

  it("pace 里不出现任何复习间隔参数 —— 模式只由 spelling_required 决定", () => {
    expect(chooseMode(paceOf({ spelling_required: true }))).toBe("recall_spell");
    expect(chooseMode(paceOf({ spelling_required: false }))).toBe("recognize");
  });

  it("词量为 0 时不崩", () => {
    const out = buildDailyPlan({ words: [], daily_cap: 20, pace: paceOf() });
    expect(out.items).toHaveLength(0);
    expect(out.estimated_minutes).toBeGreaterThanOrEqual(1);
  });
});
