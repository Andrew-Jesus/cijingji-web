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

  it("跨单元轮转：8 个单元全部被覆盖，且题量分布均匀（每单元 2~3 题）", () => {
    const byUnit = new Map<string, number>();
    for (const q of questions) byUnit.set(q.unit_code, (byUnit.get(q.unit_code) ?? 0) + 1);

    expect(byUnit.size).toBe(bundle.units.length); // 8 个单元一个不落
    for (const count of byUnit.values()) {
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it(`每题恰好 ${OPTIONS_PER_QUESTION} 个选项，且没有重复释义`, () => {
    for (const q of questions) {
      expect(q.options).toHaveLength(OPTIONS_PER_QUESTION);
      expect(new Set(q.options).size).toBe(OPTIONS_PER_QUESTION);
    }
  });

  it("正确答案必在选项里，且 answer_index 指向该词的 primary 释义", () => {
    for (const q of questions) {
      const sense = primaryByWord.get(q.word_id);
      expect(sense).toBeDefined();
      expect(q.options[q.answer_index]).toBe(sense!.cn_meaning);
      expect(q.options).toContain(sense!.cn_meaning);
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
    const only = ["renjiao_2024:8A:U1", "renjiao_2024:8A:U2"];
    const qs = buildQuiz({ snapshot, units: only, size: 6 });
    expect(qs).toHaveLength(6);
    expect(qs.every((q) => q.unit_code === "Unit 1" || q.unit_code === "Unit 2")).toBe(true);
  });

  it("size 大于可用词数时取尽为止，不报错", () => {
    const qs = buildQuiz({ snapshot, units: ["renjiao_2024:8A:U1"], size: 9999 });
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
    { word_id: "a", lemma: "a", phonetic_uk: null, pos: null, unit_code: "Unit 1", options: ["x", "y"], answer_index: 0 },
    { word_id: "b", lemma: "b", phonetic_uk: null, pos: null, unit_code: "Unit 1", options: ["x", "y"], answer_index: 1 },
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

  it("全部不答 → 第 1 档，且 by_unit 全 0", () => {
    const r = scoreQuiz(questions, questions.map(() => null));
    expect(r.correct).toBe(0);
    expect(r.level).toBe(1);
    expect(r.by_unit.every((u) => u.correct === 0)).toBe(true);
  });

  it("每题都答错 → 第 1 档（选项少于 2 个时不会出现这种题）", () => {
    const wrong = questions.map((q) => (q.answer_index + 1) % q.options.length);
    const r = scoreQuiz(questions, wrong);
    expect(r.correct).toBe(0);
    expect(r.level).toBe(1);
  });
});
