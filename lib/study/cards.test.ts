import { describe, expect, it } from "vitest";

import type { Sense, Unit, Word, WordPlacement } from "@/lib/db/types";
import type { WordSnapshot } from "@/lib/scope/resolveScope";
import { buildKnownLemmaSet, buildStudyCards, normalizeMode } from "./cards";

const U1 = "renjiao_2024:8A:U1";
const U2 = "renjiao_2024:8A:U2";

function unit(id: string, unitNo: number): Unit {
  return {
    id,
    volume_id: "renjiao_2024:8A",
    unit_no: unitNo,
    unit_code: `Unit ${unitNo}`,
    title_en: "",
    title_zh: null,
    theme_tags: [],
    sort_order: unitNo,
    is_verified: false,
  };
}

function word(id: string, lemma: string): Word {
  return {
    id,
    lemma,
    lemma_normalized: lemma.toLowerCase().replace(/-/g, ""),
    phonetic_uk: `/${lemma}/`,
    phonetic_us: null,
    freq_rank: null,
  };
}

function sense(wordId: string, meaning: string, pos = "n."): Sense {
  return { id: `s:${wordId}`, word_id: wordId, pos, cn_meaning: meaning, is_primary: true };
}

function placement(wordId: string, unitId: string): WordPlacement {
  return {
    id: `p:${wordId}:${unitId}`,
    word_id: wordId,
    unit_id: unitId,
    sense_id: null,
    role: "new",
    is_core: null,
    occurrence_no: 1,
    first_volume_id: null,
    source: "extracted",
    confidence: 0.75,
    is_verified: false,
  };
}

interface Fixture {
  snapshot: WordSnapshot;
  items: { word_id: string; mode: string; meaning_zh: string | null }[];
}

function fixture(): Fixture {
  const snapshot: WordSnapshot = {
    units: [unit(U1, 1), unit(U2, 2)],
    words: [
      word("w:a", "ancient"),
      word("w:b", "basket"),
      word("w:c", "camera"),
      word("w:d", "dolphin"),
      word("w:e", "engine"),
      word("w:f", "forest"),
      word("w:g", "garden"),
    ],
    senses: [
      sense("w:a", "古代的"),
      sense("w:b", "篮子"),
      sense("w:c", "相机"),
      sense("w:d", "海豚"),
      sense("w:e", "发动机"),
      sense("w:f", "森林"),
      sense("w:g", "花园"),
    ],
    placements: [
      placement("w:a", U1),
      placement("w:b", U1),
      placement("w:c", U1),
      placement("w:d", U1),
      placement("w:e", U1),
      placement("w:f", U1),
      placement("w:g", U2),
    ],
  };

  return {
    snapshot,
    items: [
      { word_id: "w:a", mode: "recognize", meaning_zh: "古代的" },
      { word_id: "w:g", mode: "recognize", meaning_zh: "花园" },
    ],
  };
}

describe("normalizeMode", () => {
  it("认得出两个模板", () => {
    expect(normalizeMode("recognize")).toBe("recognize");
    expect(normalizeMode("recall_spell")).toBe("recall_spell");
  });

  it("未知模板回落成 recognize（将来加了新模板，旧版本页面读到也不能打不开）", () => {
    expect(normalizeMode("listening")).toBe("recognize");
    expect(normalizeMode("")).toBe("recognize");
  });
});

describe("buildStudyCards / recognize", () => {
  const { snapshot, items } = fixture();
  const cards = buildStudyCards({ items, snapshot });

  it("每题给 4 个选项", () => {
    expect(cards[0].options).toHaveLength(4);
  });

  it("answer_index 指向正确释义，且正确释义在选项里只出现一次", () => {
    const card = cards[0];
    expect(card.options?.[card.answer_index ?? -1]).toBe("古代的");
    expect(card.options?.filter((o) => o === "古代的")).toHaveLength(1);
  });

  it("选项不重复（重复 = 两个正确答案，用户选另一个会被判错，最伤信任）", () => {
    for (const card of cards) {
      const options = card.options ?? [];
      expect(new Set(options).size).toBe(options.length);
    }
  });

  it("干扰项优先取**同一单元**的词（同语义场的选项才有区分度）", () => {
    const card = cards[0]; // w:a 在 U1，U1 里还有 b~f 五个词，够取 3 个
    const wrong = (card.options ?? []).filter((o) => o !== "古代的");
    // 花园 (w:g) 属于 U2，不该出现在 U1 的干扰项里
    expect(wrong).not.toContain("花园");
  });

  it("同一个词每次生成的卡片完全一样（选项顺序稳定，不会今天一个顺序明天一个顺序）", () => {
    const again = buildStudyCards({ items, snapshot });
    expect(again).toEqual(cards);
  });

  it("音标与词性带进卡片（界面要展示，且它们来自词库不是模型）", () => {
    expect(cards[0].phonetic_uk).toBe("/ancient/");
    expect(cards[0].pos).toBe("n.");
  });

  it("置信度带进卡片（低于 0.8 时界面要标注「可能不准」）", () => {
    expect(cards[0].confidence).toBe(0.75);
  });
});

describe("buildStudyCards / recall_spell", () => {
  it("拼写题没有选项，但有可接受的写法（原形 + 归一形）", () => {
    const { snapshot } = fixture();
    const cards = buildStudyCards({
      items: [{ word_id: "w:a", mode: "recall_spell", meaning_zh: "古代的" }],
      snapshot,
    });
    expect(cards[0].options).toBeUndefined();
    expect(cards[0].answer_index).toBeUndefined();
    expect(cards[0].answers).toContain("ancient");
  });

  it("带连字符的词，归一形也作为可接受写法", () => {
    const { snapshot } = fixture();
    snapshot.words.push(word("w:h", "well-known"));
    snapshot.senses.push(sense("w:h", "有名的"));
    snapshot.placements.push(placement("w:h", U1));
    const cards = buildStudyCards({
      items: [{ word_id: "w:h", mode: "recall_spell", meaning_zh: "有名的" }],
      snapshot,
    });
    expect(cards[0].answers).toContain("well-known");
    expect(cards[0].answers).toContain("wellknown");
  });
});

describe("buildStudyCards / 数据不完整时的行为", () => {
  it("没有中文释义 → 跳过这张卡，**不拿空字符串凑一张题**", () => {
    const { snapshot } = fixture();
    const cards = buildStudyCards({
      items: [
        { word_id: "w:a", mode: "recognize", meaning_zh: "" },
        { word_id: "w:b", mode: "recognize", meaning_zh: "篮子" },
      ],
      snapshot,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].word_id).toBe("w:b");
  });

  it("词库里没有这个词 → 跳过，不抛异常把整页搞挂", () => {
    const { snapshot } = fixture();
    const cards = buildStudyCards({
      items: [{ word_id: "w:missing", mode: "recognize", meaning_zh: "不存在" }],
      snapshot,
    });
    expect(cards).toHaveLength(0);
  });

  it("单元里没有别的词、凑不出干扰项 → 改用拼写题（不出只有 1 个选项的假选择题）", () => {
    const { snapshot } = fixture();
    const cards = buildStudyCards({
      items: [{ word_id: "w:g", mode: "recognize", meaning_zh: "花园" }],
      snapshot,
    });
    // w:g 在 U2 里是唯一的词，但全局池还有别的词 —— 所以这里应该能凑出来
    expect(cards[0].options?.length).toBe(4);

    // 真正的极端情况：整库只有这一个词
    const lonely: WordSnapshot = {
      units: [unit(U2, 2)],
      words: [word("w:g", "garden")],
      senses: [sense("w:g", "花园")],
      placements: [placement("w:g", U2)],
    };
    const single = buildStudyCards({
      items: [{ word_id: "w:g", mode: "recognize", meaning_zh: "花园" }],
      snapshot: lonely,
    });
    expect(single[0].mode).toBe("recall_spell");
    expect(single[0].options).toBeUndefined();
  });

  it("计划里缺展示字段时回落到词库当前值（早期存下的计划也能练）", () => {
    const { snapshot } = fixture();
    const cards = buildStudyCards({
      items: [{ word_id: "w:a", mode: "recognize", meaning_zh: null }],
      snapshot,
    });
    expect(cards[0].lemma).toBe("ancient");
    expect(cards[0].meaning_zh).toBe("古代的");
    expect(cards[0].unit_code).toBe("Unit 1");
  });
});

describe("buildKnownLemmaSet", () => {
  it("归一形集合，用来判「拼成了另一个真实的词」", () => {
    const { snapshot } = fixture();
    const set = buildKnownLemmaSet(snapshot);
    expect(set.has("ancient")).toBe(true);
    expect(set.has("garden")).toBe(true);
    expect(set.has("nonexistent")).toBe(false);
  });

  it("带连字符的词以去连字符的形式进集合（与判分时的归一化口径一致）", () => {
    const { snapshot } = fixture();
    snapshot.words.push(word("w:h", "well-known"));
    expect(buildKnownLemmaSet(snapshot).has("wellknown")).toBe(true);
  });
});
