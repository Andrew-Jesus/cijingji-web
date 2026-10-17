/**
 * 助记的两条线都要测：
 *   ① **专属助记**（表里有 → 用它；表里没有 → 回落通用建议）
 *   ② **生成脚本的规则**（词源断言必须被拦住，否则整块的价值是负的）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// 直接借用脚本里的纯函数（tsconfig 能解析 .mjs，不需要抑制注释）
import {
  DEFAULT_MODEL,
  PROMPT_VERSION,
  buildPrompt,
  checkMnemonic,
  fnv1a,
  pickWords,
} from "../../scripts/gen-mnemonics.mjs";

import { PROVIDERS } from "@/lib/ai/config";
import { hashSeed } from "@/lib/util/random";
import bundleJson from "@/lib/db/seed-data.json";
import type { Sense, Unit, Word, WordPlacement } from "@/lib/db/types";
import { associationCount, associationFor, mnemonicFor } from "@/lib/study/mnemonic";
import type { StudyCard, StudyMode } from "@/lib/study/types";

function card(wordId: string, mode: StudyMode = "recognize"): StudyCard {
  return {
    word_id: wordId,
    mode,
    lemma: "whatever",
    phonetic_uk: null,
    pos: "n.",
    meaning_zh: "某个意思",
    unit_code: "Unit 1",
    confidence: 1,
  };
}

describe("助记表为空时（当前仓库状态）", () => {
  it("一条专属助记都没有", () => {
    expect(associationCount()).toBe(0);
    expect(associationFor("w:condition")).toBeNull();
  });

  it("回落到通用建议，且**不留空**（空抽屉比没有抽屉更糟）", () => {
    for (const mode of ["recognize", "recall_spell"] as const) {
      const tip = mnemonicFor(card("w:condition", mode));
      expect(tip.kind).toBe("generic");
      expect(tip.lines.length).toBeGreaterThan(0);
      expect(tip.lines.every((l) => l.trim().length > 0)).toBe(true);
      expect(tip.note.length).toBeGreaterThan(0);
    }
  });

  it("两种问法给的通用建议不是同一段（写不出来 ≠ 选不出来）", () => {
    const a = mnemonicFor(card("w:condition", "recognize"));
    const b = mnemonicFor(card("w:condition", "recall_spell"));
    expect(a.lines).not.toEqual(b.lines);
    expect(a.title).not.toBe(b.title);
  });
});

describe("checkMnemonic 规则（脚本真正的防线）", () => {
  it("放行正常的联想", () => {
    expect(checkMnemonic("condition：把 con 想成「看」，看病就是查身体状况").ok).toBe(true);
    expect(checkMnemonic("联想成「啊，条件反射」—— 一想到条件就想到它").ok).toBe(true);
  });

  it("★ 拦住词源断言（这一条最重要，假词源比没有更糟）", () => {
    for (const bad of [
      "这个词来自拉丁语 condicio",
      "词根是 dic，表示说",
      "源自古法语的 condicion",
      "originally from Latin",
      "它的词源是「共同+说」",
    ]) {
      expect(checkMnemonic(bad).ok, bad).toBe(false);
    }
  });

  it("模型放弃时（输出「无」）不当作一条助记", () => {
    expect(checkMnemonic("无").ok).toBe(false);
    expect(checkMnemonic("  无  ").ok).toBe(false);
  });

  it("把通用建议重说一遍不算助记", () => {
    expect(checkMnemonic("多读几遍就记住了").ok).toBe(false);
    expect(checkMnemonic("注意拼写，别漏字母").ok).toBe(false);
  });

  it("空串 / 太短 / 太长 / 多行 都收不了", () => {
    expect(checkMnemonic("").ok).toBe(false);
    expect(checkMnemonic("啊").ok).toBe(false);
    expect(checkMnemonic("长".repeat(81)).ok).toBe(false);
    expect(checkMnemonic("第一行\n第二行").ok).toBe(false);
  });

  it("不雅内容拦得住", () => {
    expect(checkMnemonic("这个助记写成了妈的").ok).toBe(false);
  });
});

describe("提示词", () => {
  it("把「不许提词源」写死进提示词（模型默认行为就是讲词源）", () => {
    const p = buildPrompt({ lemma: "condition", pos: "n.", meaning: "长期疾病" });
    expect(p).toContain("condition");
    expect(p).toContain("长期疾病");
    expect(p).toContain("不要提词源");
    expect(p).toContain("无");
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("脚本与配置不许漂移", () => {
  it("脚本里的默认模型 == lib/ai/config.ts 里 DeepSeek 的默认模型", () => {
    // 模型名只该有一处真值。脚本是 .mjs 读不了 TS，所以用源码比对把两边钉住。
    const src = readFileSync(join(process.cwd(), "scripts", "gen-mnemonics.mjs"), "utf8");
    const m = /export const DEFAULT_MODEL = "([^"]+)"/.exec(src);
    expect(m?.[1]).toBeDefined();
    expect(m?.[1]).toBe(PROVIDERS.deepseek.defaultModel);
    expect(DEFAULT_MODEL).toBe(PROVIDERS.deepseek.defaultModel);
  });
});

describe("脚本里的工具", () => {
  it("fnv1a 与 lib/util/random.ts 的 hashSeed 是同一算法（复刻份不许漂移）", () => {
    for (const s of ["", "a", "w:act", "w:condition", "长一点的字符串"]) {
      expect(fnv1a(s)).toBe(hashSeed(s));
    }
  });
});

describe("选词（试点要有代表性）", () => {
  const bundle = bundleJson as unknown as {
    units: Unit[];
    words: Word[];
    senses: Sense[];
    word_placements: WordPlacement[];
  };
  const snapshot = {
    units: bundle.units,
    words: bundle.words,
    senses: bundle.senses,
    placements: bundle.word_placements,
  };

  it("30 个词覆盖多个单元，不是全挤在第一单元", () => {
    const picked = pickWords(snapshot, 30);
    expect(picked).toHaveLength(30);
    const units = new Set(picked.map((p: { unit_id: string }) => p.unit_id));
    expect(units.size).toBeGreaterThanOrEqual(10);
  });

  it("不重复考同一个词，且每条都带释义（没有释义就写不出助记）", () => {
    const picked = pickWords(snapshot, 30) as { word_id: string; meaning: string }[];
    expect(new Set(picked.map((p) => p.word_id)).size).toBe(picked.length);
    expect(picked.every((p) => p.meaning.trim().length > 0)).toBe(true);
  });

  it("要的比词库多时，给满为止而不是报错", () => {
    const picked = pickWords(snapshot, 10_000);
    expect(picked.length).toBe(bundle.words.length);
  });
});
