import { describe, expect, it } from "vitest";

import {
  CLOZE_BLANK_COUNT,
  checkCloze,
  checkClozeSafety,
  checkClozeStructure,
  checkClozeVocabulary,
  countWords,
  findPlaceholders,
  gradeCloze,
  normalizeLemma,
  splitPassage,
  type ClozeBlank,
  type ClozeDraft,
} from "./cloze";

/** 16 词、语法上成立的一句，用来凑词数 */
const SENTENCE =
  "Every morning the students walk to school together and talk about their lessons before class begins.";

/**
 * 造一篇合格短文：160 词（10 × 16），10 个空位按 1~10 顺序插在句子之间。
 * 占位符不算词，所以词数恒为 160，稳稳落在 120~280 区间里。
 */
function makePassage(): string {
  const parts: string[] = [];
  for (let i = 1; i <= CLOZE_BLANK_COUNT; i++) {
    parts.push(SENTENCE);
    parts.push(`{{${i}}}`);
  }
  return parts.join(" ");
}

const UNIT_WORDS = ["join", "help", "bring", "listen", "finish", "share", "carry", "explain", "change", "decide"];

function makeBlank(no: number, word = UNIT_WORDS[no - 1] ?? "join"): ClozeBlank {
  return { no, options: [word, "walked", "yellow", "seventh"], answer: 0, word };
}

function goodDraft(): ClozeDraft {
  return {
    title: "一节普通的早晨",
    passage: makePassage(),
    blanks: Array.from({ length: CLOZE_BLANK_COUNT }, (_, i) => makeBlank(i + 1)),
  };
}

describe("findPlaceholders", () => {
  it("按出现顺序抠出占位符与位置", () => {
    const passage = "a {{1}} b {{2}}";
    const hits = findPlaceholders(passage);
    expect(hits.map((h) => h.no)).toEqual([1, 2]);
    expect(passage.slice(hits[0].from, hits[0].to)).toBe("{{1}}");
    expect(passage.slice(hits[1].from, hits[1].to)).toBe("{{2}}");
  });

  it("允许花括号里有空格", () => {
    expect(findPlaceholders("a {{ 3 }} b").map((h) => h.no)).toEqual([3]);
  });

  it("相邻两次调用结果一致 —— 带了 g 的正则有 lastIndex 状态，必须重置", () => {
    const passage = "x {{1}} y {{2}} z";
    const first = findPlaceholders(passage).map((h) => h.no);
    const second = findPlaceholders(passage).map((h) => h.no);
    expect(second).toEqual(first);
  });

  it("普通方括号与下划线不算空位", () => {
    expect(findPlaceholders("he said [sic] and then ___ left")).toEqual([]);
  });
});

describe("splitPassage", () => {
  it("切成「文字 / 空」交替，并把首尾文字都带上", () => {
    const chunks = splitPassage("Before {{1}} between {{2}} after");
    expect(chunks).toEqual([
      { kind: "text", text: "Before " },
      { kind: "blank", no: 1 },
      { kind: "text", text: " between " },
      { kind: "blank", no: 2 },
      { kind: "text", text: " after" },
    ]);
  });

  it("空位在开头或结尾时不产生空文字段", () => {
    expect(splitPassage("{{1}} end")).toEqual([
      { kind: "blank", no: 1 },
      { kind: "text", text: " end" },
    ]);
    expect(splitPassage("start {{1}}")).toEqual([
      { kind: "text", text: "start " },
      { kind: "blank", no: 1 },
    ]);
  });

  it("没有占位符时整段原样返回", () => {
    expect(splitPassage("plain text")).toEqual([{ kind: "text", text: "plain text" }]);
  });

  it("空段落返回空数组", () => {
    expect(splitPassage("")).toEqual([]);
  });
});

describe("countWords", () => {
  it("占位符不算词", () => {
    expect(countWords("one two {{1}} three")).toBe(3);
  });

  it("连续空白不重复计词", () => {
    expect(countWords("  one   two \n three  ")).toBe(3);
  });
});

describe("checkClozeStructure", () => {
  it("合格的题通过", () => {
    const check = checkClozeStructure(goodDraft());
    expect(check.notes).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("空短文只报一条，不连带报一堆噪音", () => {
    const check = checkClozeStructure({ title: "x", passage: "", blanks: [] });
    expect(check.ok).toBe(false);
    expect(check.issues).toContain("empty_passage");
    // 结构校验在空短文时提前返回，不该再报「空数不对」这些
    expect(check.issues).not.toContain("blank_count");
  });

  it("没有标题 → empty_title", () => {
    const check = checkClozeStructure({ ...goodDraft(), title: "   " });
    expect(check.issues).toContain("empty_title");
  });

  it("空位少于标准数 → blank_count", () => {
    const draft = goodDraft();
    draft.passage = draft.passage.replace(/\{\{10\}\}/, "");
    const check = checkClozeStructure(draft);
    expect(check.issues).toContain("blank_count");
    expect(check.ok).toBe(false);
  });

  it("空位编号重复 → placeholder_mismatch", () => {
    const draft = goodDraft();
    draft.passage = draft.passage.replace("{{10}}", "{{9}}");
    expect(checkClozeStructure(draft).issues).toContain("placeholder_mismatch");
  });

  it("题目空编号不合规 → blank_no_duplicate", () => {
    const draft = goodDraft();
    draft.blanks[9] = { ...draft.blanks[9], no: 9 };
    expect(checkClozeStructure(draft).issues).toContain("blank_no_duplicate");
  });

  it("选项不是 4 个 → option_count", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], options: ["a", "b", "c"] };
    expect(checkClozeStructure(draft).issues).toContain("option_count");
  });

  it("选项归一后重复 → option_duplicate", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], options: ["join", "Join", "walk", "run"] };
    expect(checkClozeStructure(draft).issues).toContain("option_duplicate");
  });

  it("选项里有空白项 → option_empty", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], options: ["join", "  ", "walk", "run"] };
    expect(checkClozeStructure(draft).issues).toContain("option_empty");
  });

  it("答案下标越界 → answer_out_of_range", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], answer: 4 };
    expect(checkClozeStructure(draft).issues).toContain("answer_out_of_range");
  });

  it("答案下标不是整数 → answer_out_of_range", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], answer: 1.5 };
    expect(checkClozeStructure(draft).issues).toContain("answer_out_of_range");
  });

  it("短文太短 → passage_too_short", () => {
    const draft = goodDraft();
    draft.passage = `short text ${Array.from({ length: 10 }, (_, i) => `{{${i + 1}}}`).join(" ")}`;
    expect(checkClozeStructure(draft).issues).toContain("passage_too_short");
  });

  it("短文太长 → passage_too_long", () => {
    const draft = goodDraft();
    draft.passage = `${Array.from({ length: 30 }, () => SENTENCE).join(" ")} ${Array.from(
      { length: 10 },
      (_, i) => `{{${i + 1}}}`,
    ).join(" ")}`;
    expect(checkClozeStructure(draft).issues).toContain("passage_too_long");
  });

  it("空没有说明考哪个词 → word_not_in_unit", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], word: "  " };
    expect(checkClozeStructure(draft).issues).toContain("word_not_in_unit");
  });
});

describe("checkClozeVocabulary", () => {
  const pool = new Set(UNIT_WORDS);

  it("全都在词表里 → 通过", () => {
    expect(checkClozeVocabulary(goodDraft(), pool).ok).toBe(true);
  });

  it("挖了一个不在本单元的词 → 报出来并带上题号", () => {
    const draft = goodDraft();
    draft.blanks[2] = { ...draft.blanks[2], word: "butterfly" };
    const check = checkClozeVocabulary(draft, pool);
    expect(check.ok).toBe(false);
    expect(check.issues).toContain("word_not_in_unit");
    expect(check.notes[0]).toContain("3");
    expect(check.notes[0]).toContain("butterfly");
  });

  it("大小写与连字符的差异不误伤", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], word: "  JOIN " };
    expect(checkClozeVocabulary(draft, pool).ok).toBe(true);
  });

  it("词表传进来时没归一也能对上（本函数自己再归一一次）", () => {
    expect(checkClozeVocabulary(goodDraft(), new Set(UNIT_WORDS.map((w) => w.toUpperCase()))).ok).toBe(
      true,
    );
  });
});

describe("checkClozeSafety", () => {
  it("正常的题通过", () => {
    expect(checkClozeSafety(goodDraft()).ok).toBe(true);
  });

  it.each(["真题", "押题", "原题", "考过", "必考", "命题组"])(
    "出现「%s」→ 直接判废",
    (phrase) => {
      const draft = goodDraft();
      draft.title = `这次${phrase}的练习`;
      const check = checkClozeSafety(draft);
      expect(check.ok).toBe(false);
      expect(check.issues).toContain("forbidden_claim");
    },
  );

  it("网址 → url_or_email", () => {
    const draft = goodDraft();
    draft.passage = `${draft.passage} Visit www.example.com for more.`;
    expect(checkClozeSafety(draft).issues).toContain("url_or_email");
  });

  it("邮箱 → url_or_email", () => {
    const draft = goodDraft();
    draft.passage = `${draft.passage} Write to me at abc@example.org.`;
    expect(checkClozeSafety(draft).issues).toContain("url_or_email");
  });

  it("emoji → emoji", () => {
    const draft = goodDraft();
    draft.title = "今天真开心 😀";
    expect(checkClozeSafety(draft).issues).toContain("emoji");
  });

  it("选项里藏了敏感说法也会被查到", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], options: ["join", "真题", "walk", "run"] };
    expect(checkClozeSafety(draft).issues).toContain("forbidden_claim");
  });
});

describe("checkCloze —— 三道合一", () => {
  it("合格题全绿", () => {
    const check = checkCloze(goodDraft(), new Set(UNIT_WORDS));
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
  });

  it("三道的问题都会收集，不会遇到第一条就停", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], answer: 9, word: "butterfly" };
    draft.title = "真题精选";
    const check = checkCloze(draft, new Set(UNIT_WORDS));
    expect(check.ok).toBe(false);
    expect(check.issues).toContain("answer_out_of_range");
    expect(check.issues).toContain("word_not_in_unit");
    expect(check.issues).toContain("forbidden_claim");
  });
});

describe("gradeCloze", () => {
  it("全对", () => {
    const draft = goodDraft();
    const choices = Object.fromEntries(draft.blanks.map((b) => [b.no, b.answer]));
    const grade = gradeCloze(draft, choices);
    expect(grade.correct_count).toBe(CLOZE_BLANK_COUNT);
    expect(grade.total).toBe(CLOZE_BLANK_COUNT);
  });

  it("选错时给出用户选的词与正确词，供「和另一个词混了」的话术用", () => {
    const draft = goodDraft();
    const grade = gradeCloze(draft, { 1: 2 });
    const first = grade.blanks[0];
    expect(first.correct).toBe(false);
    expect(first.chosen_text).toBe("yellow");
    expect(first.answer_text).toBe("join");
    expect(first.word).toBe("join");
  });

  it("没选 = 算错，不抛异常", () => {
    const grade = gradeCloze(goodDraft(), {});
    expect(grade.correct_count).toBe(0);
    expect(grade.blanks.every((b) => b.correct === false)).toBe(true);
    expect(grade.blanks.every((b) => b.chosen === null)).toBe(true);
  });

  it("传了非整数 / 越界的下标也不会崩", () => {
    const grade = gradeCloze(goodDraft(), { 1: Number.NaN, 2: 99 });
    expect(grade.blanks[0].chosen).not.toBe(Number.NaN);
    expect(grade.blanks[1].chosen_text).toBeNull();
  });

  it("结果按题号排序，与传入顺序无关", () => {
    const draft = goodDraft();
    draft.blanks.reverse();
    const grade = gradeCloze(draft, {});
    expect(grade.blanks.map((b) => b.no)).toEqual(
      Array.from({ length: CLOZE_BLANK_COUNT }, (_, i) => i + 1),
    );
  });

  it("选项越界时 answer_text 给空串而不是 undefined", () => {
    const draft = goodDraft();
    draft.blanks[0] = { ...draft.blanks[0], answer: 7 };
    const grade = gradeCloze(draft, {});
    expect(grade.blanks[0].answer_text).toBe("");
  });
});

describe("normalizeLemma", () => {
  it("小写、去连字符、压空白", () => {
    expect(normalizeLemma("  Take-Off  ")).toBe("takeoff");
  });

  it("幂等 —— 跑两遍结果一样", () => {
    const once = normalizeLemma("Well-Known ");
    expect(normalizeLemma(once)).toBe(once);
  });
});
