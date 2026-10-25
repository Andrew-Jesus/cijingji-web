import { describe, expect, it } from "vitest";

import { GENERIC_INTEREST_TAG, INTEREST_OPTIONS, interestLabelEn } from "@/lib/onboarding/questions";
import { buildPrompt, fixedPrefixLength, isGenericInterest, type WordFacts } from "./prompt";

const facts: WordFacts = {
  lemma: "ancient",
  phonetic: "/ˈeɪnʃənt/",
  pos: "adj.",
  meaning_zh: "古代的；古老的",
};

describe("buildPrompt / 缓存前缀必须逐字稳定", () => {
  /**
   * 这是这个文件里最重要的一条测试。
   *
   * 缓存是按"请求前缀"命中的。只要 system 里混进任何随请求变化的东西
   * （今天的日期、用户名、单词本身），缓存就**永远不命中**，
   * 输入价从 ¥0.05/百万 回到 ¥1.5/百万 —— **30 倍**。
   * 而这个损失在界面上完全看不见，只有账单知道。
   */
  it("换一个词，system 逐字相同", () => {
    const a = buildPrompt("example_personalized", { facts, interestTag: "basketball" });
    const b = buildPrompt("example_personalized", {
      facts: { ...facts, lemma: "basket", meaning_zh: "篮子" },
      interestTag: "basketball",
    });
    expect(a.fixed).toBe(b.fixed);
  });

  it("换一个兴趣域，system 同样逐字相同", () => {
    const a = buildPrompt("example_personalized", { facts, interestTag: "music" });
    const b = buildPrompt("example_personalized", { facts, interestTag: "travel" });
    expect(a.fixed).toBe(b.fixed);
  });

  it("system 里不许出现具体单词（出现了就说明有人把变量塞进前缀了）", () => {
    const { fixed } = buildPrompt("example_personalized", { facts, interestTag: "music" });
    expect(fixed).not.toContain("ancient");
    expect(fixed).not.toContain("古代的");
  });

  it("system 里不许出现任何兴趣域的中文名（同上）", () => {
    const { fixed } = buildPrompt("example_personalized", { facts, interestTag: "music" });
    for (const option of INTEREST_OPTIONS) {
      expect(fixed).not.toContain(option.label);
    }
  });
});

describe("buildPrompt / 变量部分必须给全事实", () => {
  const { variable } = buildPrompt("example_personalized", { facts, interestTag: "basketball" });

  it("带上词头、音标、词性、词义 —— 这四样来自我们的词库，模型不许自己回忆", () => {
    expect(variable).toContain("ancient");
    expect(variable).toContain("/ˈeɪnʃənt/");
    expect(variable).toContain("adj.");
    expect(variable).toContain("古代的；古老的");
  });

  it("兴趣域同时给中英文名", () => {
    expect(variable).toContain("basketball and football");
    expect(variable).toContain("篮球 / 足球");
  });

  it("音标缺失时如实说未收录，而不是留一个空行让模型自由发挥", () => {
    const { variable: v } = buildPrompt("example_personalized", {
      facts: { ...facts, phonetic: null, pos: null },
      interestTag: "music",
    });
    expect(v).toContain("未收录");
  });
});

describe("system 提示词里的固定约束", () => {
  const { fixed } = buildPrompt("example_personalized", { facts, interestTag: "music" });

  it("必须提到 JSON —— 两家模型的 json_object 模式都要求提示词里出现这个词", () => {
    expect(fixed).toContain("JSON");
  });

  it("必须写明「不许编事实」和「不许出现具体人名数字」（AI 边界的落地）", () => {
    expect(fixed).toContain("不要编造");
    expect(fixed).toContain("人名");
    expect(fixed).toContain("日期");
  });

  it("必须写明禁用 emoji（产品级硬约束，提示词这一层也要拦一道）", () => {
    expect(fixed).toContain("emoji");
  });
});

describe("interestLabelEn / 英文标签", () => {
  it("每个兴趣域都有非空英文名（缺了会拼出坏句子）", () => {
    for (const option of INTEREST_OPTIONS) {
      expect(option.label_en.trim().length).toBeGreaterThan(0);
      expect(interestLabelEn(option.tag)).toBe(option.label_en);
    }
  });

  it("未知 tag 回落到兜底话题的英文名，**不是**原样返回（原样可能是中文，会拼进英文句子）", () => {
    expect(interestLabelEn("calligraphy")).toBe("everyday life");
  });
});

describe("isGenericInterest", () => {
  it("兜底 tag → true", () => {
    expect(isGenericInterest(GENERIC_INTEREST_TAG)).toBe(true);
  });

  it("真实兴趣 → false", () => {
    expect(isGenericInterest("music")).toBe(false);
  });
});

/* ══════════════════════ 完形填空的提示词 ══════════════════════ */

/**
 * 这一组只测一件事，但它是省钱的关键：**system 前缀必须与具体单元无关。**
 *
 * 完形填空的变量部分是"单元名 + 51 个词"，每个单元都不一样。
 * 如果这些东西漏进 system，缓存就永远命中不了 —— 而缓存命中率在账单上
 * 差 30 倍（输入价 ¥1.5/百万 → ¥0.05/百万），在界面上却完全看不出来。
 * 所以这条要用测试钉死，而不是靠"我记得别写进去"。
 */
const CLOZE_WORDS = [
  {
    word_id: "w:suppose",
    lemma: "suppose",
    lemma_normalized: "suppose",
    meaning_zh: "猜想；认为",
  },
  {
    word_id: "w:actress",
    lemma: "actress",
    lemma_normalized: "actress",
    meaning_zh: "女演员",
  },
];

describe("buildPrompt / 完形填空", () => {
  const unitA = { unitLabel: "外研社版 · 八年级上册 · Unit 1 This is me", words: CLOZE_WORDS };
  const unitB = {
    unitLabel: "外研社版 · 九年级上册 · Unit 6 Problems",
    words: [
      {
        word_id: "w:ancient",
        lemma: "ancient",
        lemma_normalized: "ancient",
        meaning_zh: "古代的",
      },
    ],
  };

  it("换单元、换词表 → system 逐字相同（否则缓存永远不命中）", () => {
    const a = buildPrompt("cloze_generate", unitA);
    const b = buildPrompt("cloze_generate", unitB);
    expect(a.fixed).toBe(b.fixed);
  });

  it("system 里不许出现具体的单元名或任何具体单词", () => {
    const { fixed } = buildPrompt("cloze_generate", unitA);
    expect(fixed).not.toContain("This is me");
    expect(fixed).not.toContain("suppose");
    expect(fixed).not.toContain("actress");
  });

  it("变量部分带上单元名与整份词表（含中文意思）", () => {
    const { variable } = buildPrompt("cloze_generate", unitA);

    expect(variable).toContain("Unit 1 This is me");
    expect(variable).toContain("suppose");
    expect(variable).toContain("猜想；认为");
    expect(variable).toContain("actress");
    expect(variable).toContain("2 个词");
  });

  it("不同单元的变量部分必须不同（不然模型拿到的是别人的词表）", () => {
    const a = buildPrompt("cloze_generate", unitA);
    const b = buildPrompt("cloze_generate", unitB);
    expect(a.variable).not.toBe(b.variable);
  });

  it("system 里写清了三条不能省的约束", () => {
    const { fixed } = buildPrompt("cloze_generate", unitA);
    // ① 十个空
    expect(fixed).toContain("正好 10 个");
    // ② 四个选项要同词性不同词（否则变成语法题）
    expect(fixed).toContain("同一词性的不同词");
    // ③ 挖空词要写原形（否则回流到复习安排时对不上词）
    expect(fixed).toContain("原形");
  });

  it("system 里明确禁了「真题 / 押题」这类说法", () => {
    const { fixed } = buildPrompt("cloze_generate", unitA);
    expect(fixed).toContain("真题");
    expect(fixed).toContain("押题");
  });

  it("前缀够长 —— 短到几百字符的话，缓存省不下多少，说明结构有问题", () => {
    expect(fixedPrefixLength("cloze_generate")).toBeGreaterThan(500);
  });

  it("两个任务的 system 不是同一个（复制粘贴忘记改的经典事故）", () => {
    expect(buildPrompt("example_personalized", { facts, interestTag: "music" }).fixed).not.toBe(
      buildPrompt("cloze_generate", unitA).fixed,
    );
  });
});
