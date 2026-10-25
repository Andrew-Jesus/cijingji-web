import { describe, expect, it } from "vitest";

import { seedBundle } from "@/lib/db/seed";
import {
  groundTruthSize,
  lookupUnitVocabulary,
  lookupWordFacts,
  unitVocabularySize,
} from "./groundTruth";

/**
 * 这一组测的是**"出题用的词表"与"词库"是否对得上**。
 *
 * 为什么值得单独测：这两样东西在运行时靠两条不同的代码路径取出来
 * （`lookupWordFacts` 按词建索引、`lookupUnitVocabulary` 按单元建索引）。
 * 一旦它们分家，症状是这样的：
 *   · 提示词里给了 51 个词 → 模型老实照着挖了 10 个 →
 *   · 审核用同一份词表核对，全过 →
 *   · 判分后要写 `review_logs`，而 `word_id` 对应的词在事实索引里**查不到** →
 *   · 那句 `recordAnswer` 静默跳过一个不存在的词，用户看到的进度里少了这 10 个。
 * 全程不报错。所以这里直接把"两边必须一致"钉住。
 */

const UNIT_IDS = seedBundle.units.map((u) => u.id);

describe("lookupUnitVocabulary / 按单元取词表", () => {
  it("已知单元能取到词表", () => {
    const vocab = lookupUnitVocabulary(UNIT_IDS[0]);
    expect(vocab).not.toBeNull();
    expect(vocab?.words.length).toBeGreaterThan(0);
  });

  it("未知单元返回 null —— **不许回落到默认单元**", () => {
    // 回落的话，前端传错一个 id，用户会拿到一套别的单元的题，
    // 而界面一切正常，只有"这些词我一个都没学过"这一条线索
    expect(lookupUnitVocabulary("wys_2024:8A:U99")).toBeNull();
    expect(lookupUnitVocabulary("")).toBeNull();
    expect(lookupUnitVocabulary("Unit 1")).toBeNull();
  });

  it("每个词都带齐四个字段（少一个都会在下游静默出错）", () => {
    for (const unitId of UNIT_IDS) {
      const vocab = lookupUnitVocabulary(unitId);
      expect(vocab).not.toBeNull();
      for (const word of vocab!.words) {
        expect(word.word_id).toMatch(/^w:/);
        expect(word.lemma.trim().length).toBeGreaterThan(0);
        expect(word.lemma_normalized.trim().length).toBeGreaterThan(0);
        expect(word.meaning_zh.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("同一个词在一个单元里只出现一次", () => {
    // `word_placements` 里同一个词可能有多条（role 不同）。
    // 不去重的话词表会出现两行同一个词，模型很可能把它挖成两个空 ——
    // 一道题考同一个词两次，没人会发现。
    for (const unitId of UNIT_IDS) {
      const ids = lookupUnitVocabulary(unitId)!.words.map((w) => w.word_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("词表里的每个 word_id 都能在事实索引里查到", () => {
    // 这是"提示词、审核、回流"三处共用的锚，两边必须一致
    for (const unitId of UNIT_IDS) {
      for (const word of lookupUnitVocabulary(unitId)!.words) {
        expect(lookupWordFacts(word.word_id)).not.toBeNull();
      }
    }
  });

  it("单元标签带上册次与单元码 —— 少了哪个模型都会写偏", () => {
    const vocab = lookupUnitVocabulary("wys_2024:8A:U1");
    expect(vocab?.unit_label).toContain("外研社版");
    expect(vocab?.unit_label).toContain("八年级上册");
    expect(vocab?.unit_label).toContain("Unit 1");
  });

  it("每个单元的词数都够挖 10 个空", () => {
    // 不够的话 `/api/ai` 会 404。这条断言的意义是：**将来换词表时能立刻发现**，
    // 而不是上线后用户点进某个单元才发现出不了题
    for (const unitId of UNIT_IDS) {
      expect(lookupUnitVocabulary(unitId)!.words.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("所有单元都在索引里（没有因为某条数据缺失被静默跳过）", () => {
    expect(unitVocabularySize()).toBe(UNIT_IDS.length);
  });

  it("词事实索引本身没被这次改动影响", () => {
    // 完形填空加了一套新索引，但例句用的那套必须原样还在
    expect(groundTruthSize()).toBeGreaterThan(600);
  });
});
