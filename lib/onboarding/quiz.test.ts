import { describe, expect, it } from "vitest";

import type { Sense, Unit, Word, WordPlacement } from "@/lib/db/types";
import bundleJson from "@/lib/db/seed-data.json";
import type { WordSnapshot } from "@/lib/scope/resolveScope";
import {
  OPTIONS_PER_QUESTION,
  QUIZ_SEED,
  QUIZ_SIZE,
  bandFor,
  buildQuiz,
  scoreAnswers,
  scoreQuiz,
  type QuizQuestion,
} from "@/lib/onboarding/quiz";
import { QUIZ_SENSE_FIX, quizSenseFixFor } from "@/lib/onboarding/quizSenseFix";

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

const primaryByWord = new Map<string, Sense>();
for (const s of bundle.senses) if (s.is_primary) primaryByWord.set(s.word_id, s);

// ------------------------------------------------------------------ 构造数据工具

interface UnitSpec {
  id: string;
  unit_no: number;
  unit_code: string;
}
interface WordSpec {
  id: string;
  lemma: string;
  meaning?: string;
  is_primary?: boolean;
  unit: string;
}

function makeSnapshot(unitSpecs: UnitSpec[], wordSpecs: WordSpec[]): WordSnapshot {
  const units: Unit[] = unitSpecs.map((u) => ({
    id: u.id,
    volume_id: "v:test",
    unit_no: u.unit_no,
    unit_code: u.unit_code,
    title_en: u.unit_code,
    title_zh: null,
    theme_tags: [],
    sort_order: u.unit_no,
    is_verified: true,
  }));

  const words: Word[] = wordSpecs.map((w) => ({
    id: w.id,
    lemma: w.lemma,
    lemma_normalized: w.lemma.toLowerCase(),
    phonetic_uk: null,
    phonetic_us: null,
    freq_rank: null,
  }));

  const senses: Sense[] = wordSpecs.map((w) => ({
    id: `s:${w.id}`,
    word_id: w.id,
    pos: "n.",
    cn_meaning: w.meaning ?? `${w.lemma} 的意思`,
    is_primary: w.is_primary ?? true,
  }));

  const placements: WordPlacement[] = wordSpecs.map((w) => ({
    id: `p:${w.id}`,
    word_id: w.id,
    unit_id: w.unit,
    sense_id: null,
    role: "new",
    is_core: null,
    occurrence_no: 1,
    first_volume_id: null,
    source: "test",
    confidence: 0.75,
    is_verified: false,
  }));

  return { units, words, senses, placements };
}

// ------------------------------------------------------------------ 跑在真实样张数据上

describe("buildQuiz（跑在真实样张数据上）", () => {
  const questions = buildQuiz({ snapshot });

  it(`出 ${QUIZ_SIZE} 道题`, () => {
    expect(questions).toHaveLength(QUIZ_SIZE);
  });

  it("跨单元轮转：所有单元都被覆盖，且题量分布均匀（最多差 1 题）", () => {
    const byUnit = new Map<string, number>();
    for (const q of questions) byUnit.set(q.unit_id, (byUnit.get(q.unit_id) ?? 0) + 1);

    // 单元数 × 每单元题数 ≈ 总题数 —— 断言写成"相对"的，是因为
    // 单元数（现在 18 = 3 册 × 6）与题量（20）都会变。
    // ⚠️ 分组**必须用 unit_id**：unit_code 是课本自己的标号（"Unit 1"），
    // 三册重号 —— 按它分组会把 18 个单元悄悄并成 6 格，而且不报错、不崩。
    expect(byUnit.size).toBe(bundle.units.length); // 一个单元都不落
    const counts = [...byUnit.values()];
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(QUIZ_SIZE);
  });

  it(`每题恰好 ${OPTIONS_PER_QUESTION} 个选项，且没有重复释义`, () => {
    for (const q of questions) {
      expect(q.options).toHaveLength(OPTIONS_PER_QUESTION);
      expect(new Set(q.options).size).toBe(OPTIONS_PER_QUESTION);
    }
  });

  it("正确答案必在选项里；登记过窄义的词用通用义，其余用 primary 释义", () => {
    for (const q of questions) {
      const sense = primaryByWord.get(q.word_id);
      expect(sense).toBeDefined();

      // 修正表优先（理由见 quizSenseFix.ts）：课本义太窄时，自测改用通用义。
      // 这里刻意写成"查表 → 回退 primary"，与 buildQuiz 的口径一致 ——
      // 若哪天两处口径不一致，这条会立刻红。
      const expected = quizSenseFixFor(q.word_id) ?? sense!.cn_meaning;

      expect(q.options[q.answer_index]).toBe(expected);
      expect(q.options).toContain(expected);
    }
  });

  it("修正表里的每个词都还在词库里（换册次后不许悄悄失效）", () => {
    expect(QUIZ_SENSE_FIX.length).toBeGreaterThan(0);
    for (const fix of QUIZ_SENSE_FIX) {
      expect(primaryByWord.has(fix.word_id), `词库里找不到 ${fix.word_id}`).toBe(true);
      // 通用义不能和课本义一模一样 —— 那说明这条登记是多余的
      expect(fix.meaning).not.toBe(fix.textbook);
      // 必须写明出处，禁止"凭印象编"
      expect(fix.source.length).toBeGreaterThan(0);
    }
  });

  it("题目不重复考同一个词", () => {
    const ids = questions.map((q) => q.word_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("同种子两次抽题完全一致（可复现，这是能单测的前提）", () => {
    const a = buildQuiz({ snapshot, seed: QUIZ_SEED });
    const b = buildQuiz({ snapshot, seed: QUIZ_SEED });
    expect(a.map((q) => q.word_id)).toEqual(b.map((q) => q.word_id));
    expect(a.map((q) => q.options)).toEqual(b.map((q) => q.options));
  });

  it("换种子会换卷子（否则重测就是背答案）", () => {
    const a = buildQuiz({ snapshot, seed: 1 });
    const b = buildQuiz({ snapshot, seed: 2 });
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("限定单元时只出这些单元的题", () => {
    const only = ["wys_2024:8A:U1", "wys_2024:8A:U2"];
    const qs = buildQuiz({ snapshot, units: only, size: 6 });
    expect(qs).toHaveLength(6);
    expect(qs.every((q) => q.unit_code === "Unit 1" || q.unit_code === "Unit 2")).toBe(true);
  });

  it("size 大于可用词数时取尽为止，不报错", () => {
    const qs = buildQuiz({ snapshot, units: ["wys_2024:8A:U1"], size: 9999 });
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(53);
    expect(new Set(qs.map((q) => q.word_id)).size).toBe(qs.length);
  });
});

describe("buildQuiz 的兜底与边界（构造数据）", () => {
  it("同单元释义不足 3 个时，从全局池补齐到 4 个选项", () => {
    const snap = makeSnapshot(
      [
        { id: "u1", unit_no: 1, unit_code: "Unit 1" },
        { id: "u2", unit_no: 2, unit_code: "Unit 2" },
      ],
      [
        { id: "w:a", lemma: "alpha", meaning: "甲", unit: "u1" },
        { id: "w:b", lemma: "beta", meaning: "乙", unit: "u1" },
        { id: "w:c", lemma: "gamma", meaning: "丙", unit: "u2" },
        { id: "w:d", lemma: "delta", meaning: "丁", unit: "u2" },
        { id: "w:e", lemma: "epsilon", meaning: "戊", unit: "u2" },
      ],
    );

    const qs = buildQuiz({ snapshot: snap, units: ["u1"], size: 2 });
    expect(qs).toHaveLength(2);
    for (const q of qs) {
      expect(q.options).toHaveLength(4); // 靠 u2 的词补足
      expect(new Set(q.options).size).toBe(4);
    }
  });

  it("释义文本相同的词不会同时出现（避免两个正确答案）", () => {
    const snap = makeSnapshot(
      [{ id: "u1", unit_no: 1, unit_code: "Unit 1" }],
      [
        { id: "w:a", lemma: "alpha", meaning: "相同释义", unit: "u1" },
        { id: "w:b", lemma: "beta", meaning: "相同释义", unit: "u1" },
        { id: "w:c", lemma: "gamma", meaning: "丙", unit: "u1" },
        { id: "w:d", lemma: "delta", meaning: "丁", unit: "u1" },
        { id: "w:e", lemma: "epsilon", meaning: "戊", unit: "u1" },
      ],
    );

    const qs = buildQuiz({ snapshot: snap, size: 5 });
    for (const q of qs) {
      if (q.options[q.answer_index] !== "相同释义") continue;
      expect(q.options.filter((o) => o === "相同释义")).toHaveLength(1);
    }
  });

  it("没有 primary 义项的词不出题", () => {
    const snap = makeSnapshot(
      [{ id: "u1", unit_no: 1, unit_code: "Unit 1" }],
      [
        { id: "w:a", lemma: "alpha", meaning: "甲", unit: "u1" },
        { id: "w:b", lemma: "beta", meaning: "乙", unit: "u1" },
        { id: "w:c", lemma: "gamma", meaning: "丙", unit: "u1" },
        { id: "w:x", lemma: "nonsense", meaning: "无义项", unit: "u1", is_primary: false },
      ],
    );

    const qs = buildQuiz({ snapshot: snap, size: 10 });
    expect(qs.some((q) => q.word_id === "w:x")).toBe(false);
  });

  it("释义为空的词不出题", () => {
    const snap = makeSnapshot(
      [{ id: "u1", unit_no: 1, unit_code: "Unit 1" }],
      [
        { id: "w:a", lemma: "alpha", meaning: "甲", unit: "u1" },
        { id: "w:b", lemma: "beta", meaning: "乙", unit: "u1" },
        { id: "w:c", lemma: "gamma", meaning: "丙", unit: "u1" },
        { id: "w:z", lemma: "blank", meaning: "   ", unit: "u1" },
      ],
    );

    const qs = buildQuiz({ snapshot: snap, size: 10 });
    expect(qs.some((q) => q.word_id === "w:z")).toBe(false);
  });

  it("数据小到凑不出干扰项时，宁可不考，也不出没法判的题", () => {
    const snap = makeSnapshot(
      [{ id: "u1", unit_no: 1, unit_code: "Unit 1" }],
      [{ id: "w:only", lemma: "lonely", meaning: "唯一", unit: "u1" }],
    );
    expect(buildQuiz({ snapshot: snap, size: 5 })).toEqual([]);
  });

  it("单元不存在时不崩（照常返回空卷）", () => {
    const snap = makeSnapshot(
      [{ id: "u1", unit_no: 1, unit_code: "Unit 1" }],
      [{ id: "w:a", lemma: "alpha", meaning: "甲", unit: "u1" }],
    );
    expect(buildQuiz({ snapshot: snap, units: ["u:nonexistent"], size: 5 })).toEqual([]);
  });
});

// ------------------------------------------------------------------ 判分

describe("scoreAnswers", () => {
  const qs: QuizQuestion[] = [
    { word_id: "a", lemma: "a", phonetic_uk: null, pos: null, unit_id: "v:test:U1", unit_code: "Unit 1", options: ["x", "y"], answer_index: 0 },
    { word_id: "b", lemma: "b", phonetic_uk: null, pos: null, unit_id: "v:test:U1", unit_code: "Unit 1", options: ["x", "y"], answer_index: 1 },
  ];

  it("答对数正确统计", () => {
    expect(scoreAnswers(qs, [0, 1])).toEqual({ correct: 2, total: 2 });
    expect(scoreAnswers(qs, [1, 0])).toEqual({ correct: 0, total: 2 });
  });

  it("没作答（null）不算对，也不算错乱", () => {
    expect(scoreAnswers(qs, [null, null])).toEqual({ correct: 0, total: 2 });
    expect(scoreAnswers(qs, [0, null])).toEqual({ correct: 1, total: 2 });
  });

  it("漏答（数组比题短）不崩，按未作答处理", () => {
    expect(scoreAnswers(qs, [0])).toEqual({ correct: 1, total: 2 });
  });
});

describe("bandFor 分档边界（阈值对齐「四选一乱猜 25%」的期望值）", () => {
  it("0 / 20 → 第 1 档", () => {
    expect(bandFor(0, 20).level).toBe(1);
  });

  it("8 / 20（40%，边界含）→ 第 1 档", () => {
    expect(bandFor(8, 20).level).toBe(1);
  });

  it("9 / 20（45%）→ 第 2 档", () => {
    expect(bandFor(9, 20).level).toBe(2);
  });

  it("14 / 20（70%，边界含）→ 第 2 档", () => {
    expect(bandFor(14, 20).level).toBe(2);
  });

  it("15 / 20（75%）→ 第 3 档", () => {
    expect(bandFor(15, 20).level).toBe(3);
  });

  it("满分 → 第 3 档", () => {
    expect(bandFor(20, 20).level).toBe(3);
  });

  it("换题量也成立（阈值按比例，不是写死的题数）", () => {
    expect(bandFor(4, 10).level).toBe(1);
    expect(bandFor(6, 10).level).toBe(2);
    expect(bandFor(9, 10).level).toBe(3);
  });

  it("0 题不崩（ratio 记 0，落第 1 档）", () => {
    const r = bandFor(0, 0);
    expect(r.ratio).toBe(0);
    expect(r.level).toBe(1);
  });

  it("每档都带给人看的 label 与 note（界面直接显示，不留空）", () => {
    for (const c of [0, 10, 20]) {
      const r = bandFor(c, 20);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.note.length).toBeGreaterThan(0);
    }
  });
});

describe("scoreQuiz", () => {
  const questions = buildQuiz({ snapshot });

  it("by_unit 覆盖全部出题单元，且对题数之和等于总对题数", () => {
    const answers = questions.map((q) => q.answer_index); // 全对
    const r = scoreQuiz(questions, answers);

    expect(r.by_unit.reduce((s, u) => s + u.correct, 0)).toBe(r.correct);
    expect(r.by_unit.reduce((s, u) => s + u.total, 0)).toBe(r.total);
    expect(r.by_unit.length).toBe(bundle.units.length);
    expect(r.level).toBe(3);
  });

  it("全部跳过 → 不判「入门」，按中等兜底（样本不足）", () => {
    // 口径变更（2026-10-17）：全跳过的若判「入门」，会给他一套最慢的计划，
    // 而真相是"我们不知道" —— 不知道就该取中间，而不是往低处猜。
    const r = scoreQuiz(questions, questions.map(() => null));
    expect(r.correct).toBe(0);
    expect(r.answered).toBe(0);
    expect(r.skipped).toBe(questions.length);
    expect(r.level).toBe(2);
    expect(r.note).toContain("跳过");
    expect(r.by_unit.every((u) => u.correct === 0)).toBe(true);
  });

  it("每题都答错 → 第 1 档（选项少于 2 个时不会出现这种题）", () => {
    const wrong = questions.map((q) => (q.answer_index + 1) % q.options.length);
    const r = scoreQuiz(questions, wrong);
    expect(r.correct).toBe(0);
    expect(r.level).toBe(1);
  });
});

describe("跳过（点了「不确定」）", () => {
  const questions = buildQuiz({ snapshot });

  it("少量跳过：分母是实际作答数，跳过不算错", () => {
    const answers: (number | null)[] = questions.map((q) => q.answer_index);
    answers[0] = null; // 跳过第一题（这一题本来会答对）
    const r = scoreQuiz(questions, answers);

    expect(r.answered).toBe(questions.length - 1);
    expect(r.skipped).toBe(1);
    expect(r.correct).toBe(questions.length - 1);
    expect(r.ratio).toBe(1); // 满了 —— 而不是 19/20 被拉低
    expect(r.total).toBe(questions.length); // 对外要的仍是"卷子几题"
    expect(r.level).toBe(3);
  });

  it("跳过太多（不足一半）→ 哪怕全对也只按中等，并说明原因", () => {
    const half = Math.ceil(questions.length / 2);
    const answers: (number | null)[] = questions.map((q, i) =>
      i < half - 1 ? q.answer_index : null,
    );
    const r = scoreQuiz(questions, answers);

    expect(r.answered).toBe(half - 1);
    expect(r.level).toBe(2);
    expect(r.note).toContain("跳过");
  });

  it("刚好答满一半 → 正常分档（边界含）", () => {
    const half = Math.ceil(questions.length / 2);
    const answers: (number | null)[] = questions.map((q, i) =>
      i < half ? q.answer_index : null,
    );
    const r = scoreQuiz(questions, answers);

    expect(r.answered).toBe(half);
    expect(r.level).toBe(3);
  });

  it("跳过不改变 by_unit 的题量（每个单元仍是出过几题算几题）", () => {
    const r = scoreQuiz(questions, questions.map(() => null));
    expect(r.by_unit.reduce((s, u) => s + u.total, 0)).toBe(questions.length);
    expect(r.by_unit.reduce((s, u) => s + u.correct, 0)).toBe(0);
  });
});
