import { describe, expect, it } from "vitest";

import { GENERIC_INTEREST_TAG } from "@/lib/onboarding/questions";
import { fallbackNote, templateExample, type FallbackReason } from "./fallback";
import type { WordFacts } from "./prompt";

const facts: WordFacts = {
  lemma: "ancient",
  phonetic: "/ˈeɪnʃənt/",
  pos: "adj.",
  meaning_zh: "古代的；古老的",
};

describe("templateExample / 兜底句", () => {
  it("句子里真的含这个词（否则它就不是例句了）", () => {
    expect(templateExample(facts, "basketball").sentence).toContain("ancient");
  });

  it("用英文兴趣域名，不用中文（中文塞进英文句子会拼出坏句）", () => {
    const { sentence } = templateExample(facts, "basketball");
    expect(sentence).toContain("basketball and football");
    expect(sentence).not.toContain("篮球");
  });

  it("中文大意用中文兴趣域名", () => {
    expect(templateExample(facts, "basketball").gloss).toContain("篮球 / 足球");
  });

  it("确定性：同样输入两次结果完全一样（它是兜底，不该有随机性）", () => {
    expect(templateExample(facts, "music")).toEqual(templateExample(facts, "music"));
  });

  it("没选兴趣时用兜底话题，且不会把未知 tag 原样塞进英文句", () => {
    const { sentence, gloss } = templateExample(facts, GENERIC_INTEREST_TAG);
    expect(sentence).toContain("everyday life");
    expect(gloss).toContain("日常话题");
  });

  it("未知 tag 也走兜底话题（不会拼出中式英文）", () => {
    expect(templateExample(facts, "calligraphy").sentence).toContain("everyday life");
  });

  /**
   * 回归测试：**同一句里的中英文必须同源**。
   * 真实踩过的坑 —— 英文写 `everyday life`、中文却写着「我们聊到 calligraphy 的时候」，
   * 一句话前后打架。根因是中英两个名字各调了一个函数，
   * 而它们对"认不出的 tag"处理方式不同（一支回落、一支原样返回）。
   */
  it("认不出的 tag：中英两边都回落兜底话题，**不许一边回落一边原样**", () => {
    const { sentence, gloss } = templateExample(facts, "calligraphy");

    expect(sentence).toContain("everyday life");
    expect(gloss).toContain("日常话题");
    expect(gloss).not.toContain("calligraphy");
  });

  it("认得出的 tag：中英两边都用这个兴趣域自己的名字", () => {
    const { sentence, gloss } = templateExample(facts, "basketball");

    expect(sentence).toContain("basketball and football");
    expect(gloss).toContain("篮球 / 足球");
  });

  it("任何词性都能套用同一个句式（这才是选元句式而不是 I like X 的理由）", () => {
    for (const lemma of ["ancient", "carefully", "run", "make up one's mind"]) {
      const { sentence } = templateExample({ ...facts, lemma }, "music");
      expect(sentence).toContain(lemma);
      expect(sentence.trim().endsWith(".")).toBe(true);
    }
  });
});

describe("fallbackNote / 降级原因要分得清", () => {
  const reasons: FallbackReason[] = [
    "no_provider",
    "network",
    "model_failed",
    "too_slow",
    "unexpected",
  ];

  it("每种原因都有一句人话（空文案等于什么都没说）", () => {
    for (const r of reasons) {
      expect(fallbackNote(r).trim().length).toBeGreaterThan(0);
    }
  });

  it("五种原因的文案互不相同 —— 混在一起说等于没说，排查时也用不上", () => {
    const texts = reasons.map(fallbackNote);
    expect(new Set(texts).size).toBe(reasons.length);
  });

  it("「太慢等超时」和「模型没写好」要分开说 —— 它们是两条不同的排查线索", () => {
    expect(fallbackNote("too_slow")).not.toBe(fallbackNote("model_failed"));
    expect(fallbackNote("too_slow")).toContain("慢");
  });

  it("「没配 Key」要说清是缺 Key，而不是含糊的“AI 不可用”", () => {
    expect(fallbackNote("no_provider")).toContain("API Key");
  });

  it("「断网」要说明它不影响练词（这是验收项 C7 的一部分）", () => {
    expect(fallbackNote("network")).toContain("断网");
  });

  it("文案里不许出现 emoji（产品级硬约束）", () => {
    for (const r of reasons) {
      // 只查常见 emoji 区间，够用了
      expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(fallbackNote(r))).toBe(false);
    }
  });
});
