import { describe, expect, it } from "vitest";

import { ERROR_TYPE_LABEL, errorTypeLabel, gradeAnswer, gradeRecallSpell, gradeRecognize, normalizeTyped } from "./grade";
import type { StudyCard } from "./types";

const spellCard: StudyCard = {
  word_id: "w:ancient",
  mode: "recall_spell",
  lemma: "ancient",
  phonetic_uk: "/ˈeɪnʃənt/",
  pos: "adj.",
  meaning_zh: "古代的",
  unit_code: "Unit 1",
  confidence: 0.75,
  answers: ["ancient", "ancient"],
};

const knownLemmas = new Set(["ancient", "basket", "wellknown", "camera"]);

describe("normalizeTyped / 只做「明显不该算错」的归一", () => {
  it("去首尾空白", () => {
    expect(normalizeTyped("  ancient  ")).toBe("ancient");
  });

  it("大小写不敏感（Apple 与 apple 都对）", () => {
    expect(normalizeTyped("AnCiEnT")).toBe("ancient");
  });

  it("全角空格 / 不换行空格 → 普通空格", () => {
    expect(normalizeTyped("a\u3000b")).toBe("a b");
    expect(normalizeTyped("a\u00a0b")).toBe("a b");
  });

  it("掉首尾标点与引号（手机上很容易带出句号）", () => {
    expect(normalizeTyped("ancient.")).toBe("ancient");
    expect(normalizeTyped("「ancient」")).toBe("ancient");
    expect(normalizeTyped("'ancient'")).toBe("ancient");
  });

  it("去连字符（与建库时的归一化口径一致）", () => {
    expect(normalizeTyped("well-known")).toBe("wellknown");
  });

  it("中间多余空格收成一个", () => {
    expect(normalizeTyped("make   up")).toBe("make up");
  });

  it("**不做**模糊匹配：差一个字母就是差一个字母", () => {
    expect(normalizeTyped("ancientt")).toBe("ancientt");
    expect(normalizeTyped("ancien")).toBe("ancien");
  });
});

describe("gradeRecognize", () => {
  it("选对 → 对，且没有错因", () => {
    expect(gradeRecognize(2, 2)).toEqual({ is_correct: true, error_type: null });
  });

  it("选错 → 错因是 meaning（选择题只会是释义记混）", () => {
    expect(gradeRecognize(0, 2)).toEqual({ is_correct: false, error_type: "meaning" });
  });

  it("没有正确答案下标（脏数据）→ 判错，但不抛异常", () => {
    expect(gradeRecognize(0, -1).is_correct).toBe(false);
  });
});

describe("gradeRecallSpell", () => {
  it("拼对 → 对", () => {
    expect(gradeRecallSpell({ typed: "ancient", card: spellCard, knownLemmas })).toEqual({
      is_correct: true,
      error_type: null,
    });
  });

  it("大小写/首尾标点不同也算对", () => {
    expect(gradeRecallSpell({ typed: " Ancient. ", card: spellCard, knownLemmas }).is_correct).toBe(true);
  });

  it("拼错 → error_type 是 spelling", () => {
    expect(gradeRecallSpell({ typed: "ancientt", card: spellCard, knownLemmas })).toEqual({
      is_correct: false,
      error_type: "spelling",
    });
  });

  it("拼成了词库里另一个真实的词 → confusion（这比拼错严重，补救方式也不同）", () => {
    expect(gradeRecallSpell({ typed: "basket", card: spellCard, knownLemmas })).toEqual({
      is_correct: false,
      error_type: "confusion",
    });
  });

  it("空输入 → spelling，且不抛异常（界面会拦，但脏数据不该让整页挂掉）", () => {
    expect(gradeRecallSpell({ typed: "   ", card: spellCard, knownLemmas })).toEqual({
      is_correct: false,
      error_type: "spelling",
    });
  });

  it("答案列表缺失时回落到 lemma 本身", () => {
    const noAnswers: StudyCard = { ...spellCard, answers: undefined };
    expect(gradeRecallSpell({ typed: "ancient", card: noAnswers, knownLemmas }).is_correct).toBe(true);
  });
});

describe("gradeAnswer / 统一入口", () => {
  it("index 类型走选择题判分", () => {
    const card: StudyCard = {
      word_id: "w:a",
      mode: "recognize",
      lemma: "ancient",
      phonetic_uk: null,
      pos: null,
      meaning_zh: "古代的",
      unit_code: "Unit 1",
      confidence: 1,
      options: ["古代的", "篮子"],
      answer_index: 0,
    };
    expect(gradeAnswer(card, { kind: "index", value: 0 }, knownLemmas).is_correct).toBe(true);
    expect(gradeAnswer(card, { kind: "index", value: 1 }, knownLemmas).error_type).toBe("meaning");
  });

  it("text 类型走拼写判分", () => {
    const r = gradeAnswer(spellCard, { kind: "text", value: "camera" }, knownLemmas);
    expect(r).toEqual({ is_correct: false, error_type: "confusion" });
  });
});

describe("错因文案", () => {
  it("三种错因各有中文说法", () => {
    expect(ERROR_TYPE_LABEL.meaning).toBe("释义记混了");
    expect(ERROR_TYPE_LABEL.spelling).toBe("拼写错了");
    expect(ERROR_TYPE_LABEL.confusion).toBe("和另一个词混了");
  });

  it("没有错因时说「没有错」，而不是空字符串（界面上会变成一个空标签）", () => {
    expect(errorTypeLabel(null)).toBe("没有错");
  });
});
