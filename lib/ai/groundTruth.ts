/**
 * 服务端的事实查询 —— 从本地种子数据里取词头 / 音标 / 词性 / 义项
 *
 * ── 为什么要由服务端查，而不是让前端把词的内容发上来 ──────────────
 * 「AI 边界」这条产品规矩说的是：**查出来的东西绝不可以交给 AI**。
 * 如果词义由前端在请求体里带上来，那么"这是不是可信事实"就取决于请求方了 ——
 * 任何人构造一个请求就能让模型围绕一段编造的"词义"写例句，
 * 而这个产品里所有的可信度都建立在"事实来自我们自己的词库"上。
 *
 * 所以：请求体**只传 wordId**，服务端自己去查。查不到就如实报错（404），
 * **不猜、不兜底造一个词义出来**。
 *
 * 阶段 0 的服务端没有数据库（数据在用户的浏览器 IndexedDB 里），
 * 所以这里读的是**构建产物的种子文件** —— 它正是本地库的数据来源，
 * 两边同一份，不会出现"服务端和本地说得不一样"。阶段 1 换 Supabase 后
 * 只把这一层的实现换掉。
 */
import { seedBundle } from "@/lib/db/seed";
import type { ClozeWordFacts, WordFacts } from "./prompt";

/**
 * word_id → 事实。**模块级构建一次**，之后都是查表。
 * （每次请求都重扫 420 条虽然也不慢，但没必要 —— 这份数据是**只读且静态**的。）
 */
let index: Map<string, WordFacts> | null = null;

function buildIndex(): Map<string, WordFacts> {
  const map = new Map<string, WordFacts>();
  const senseByWord = new Map<string, string>();
  const posByWord = new Map<string, string | null>();

  for (const s of seedBundle.senses) {
    // 只认主义项：阶段 0 一个词只练课本里考的那个意思（sense_policy = "single"）
    if (!s.is_primary) continue;
    if (!senseByWord.has(s.word_id)) {
      senseByWord.set(s.word_id, s.cn_meaning);
      posByWord.set(s.word_id, s.pos);
    }
  }

  for (const w of seedBundle.words) {
    const meaning = senseByWord.get(w.id);
    // 没有义项的词不进索引：宁可在 API 层如实报"查不到"，
    // 也不要造一个空词义让模型去自由发挥。
    if (!meaning) continue;
    map.set(w.id, {
      lemma: w.lemma,
      phonetic: w.phonetic_uk,
      pos: posByWord.get(w.id) ?? null,
      meaning_zh: meaning,
    });
  }

  return map;
}

/** 查不到返回 null —— 调用方**必须**把它当成一次真实失败来处理 */
export function lookupWordFacts(wordId: string): WordFacts | null {
  if (!index) index = buildIndex();
  return index.get(wordId) ?? null;
}

/** 索引规模，给自检用 */
export function groundTruthSize(): number {
  if (!index) index = buildIndex();
  return index.size;
}

/* ══════════════════════ 按单元取词表（完形填空用）══════════════════════ */

/**
 * 词表里的一项。
 *
 * **直接复用 `prompt.ts` 的 `ClozeWordFacts`**，不在这里另定义一份同形状的类型。
 * 理由：这两处一旦分家，将来给词加一个字段（比如音标）就会出现
 * "提示词那边有、审核这边没有"的错位，而 TypeScript 只在赋值处报错、
 * 在 `as` 与对象 spread 里一声不吭。
 */
export type UnitWord = ClozeWordFacts;

export interface UnitVocabulary {
  unit_id: string;
  /** 人话标签，直接进提示词变量部分，如「外研社版 初中英语（2024 版）· 八年级上册 · Unit 1 This is me」 */
  unit_label: string;
  words: UnitWord[];
}

let unitIndex: Map<string, UnitVocabulary> | null = null;

/**
 * 建 unit_id → 词表的索引。
 *
 * ── 三处容易做错、且**都不会报错**的地方 ──────────────────────
 * ① **必须按 `word_id` 去重**。`word_placements` 里同一个词在一个单元可能有多条
 *    （`role` 不同：new / review / extension）。不去重的话，词表里会出现两行 `suppose`，
 *    模型很可能把它挖成两个空 —— 一道题考同一个词两次，而且没人会发现。
 * ② **没有义项的词要跳过**。与 `buildIndex` 同一个口径：宁可少给一个词，
 *    也不要给模型一行「suppose（）」让它自己编一个意思。
 * ③ **单元标签用 id 拼出来，不要用 `unit_code` 猜**。`unit_code`（"Unit 1"）
 *    在三册里重号，靠它拼标签会得出"Unit 1"然后你分不清是哪本书的。
 */
function buildUnitIndex(): Map<string, UnitVocabulary> {
  const volumeById = new Map(seedBundle.volumes.map((v) => [v.id, v]));
  const curriculumById = new Map(seedBundle.curricula.map((c) => [c.id, c]));
  const wordById = new Map(seedBundle.words.map((w) => [w.id, w]));

  // 主义项（与 buildIndex 同一个口径：一个词只练课本里考的那个意思）
  const primarySense = new Map<string, string>();
  for (const s of seedBundle.senses) {
    if (!s.is_primary) continue;
    if (!primarySense.has(s.word_id)) primarySense.set(s.word_id, s.cn_meaning);
  }

  const wordsByUnit = new Map<string, UnitWord[]>();
  const seenByUnit = new Map<string, Set<string>>();

  for (const p of seedBundle.word_placements) {
    const word = wordById.get(p.word_id);
    const meaning = primarySense.get(p.word_id)?.trim();
    if (!word || !meaning) continue;

    let seen = seenByUnit.get(p.unit_id);
    if (!seen) {
      seen = new Set<string>();
      seenByUnit.set(p.unit_id, seen);
    }
    if (seen.has(p.word_id)) continue;
    seen.add(p.word_id);

    const list = wordsByUnit.get(p.unit_id);
    const item: UnitWord = {
      word_id: word.id,
      lemma: word.lemma,
      lemma_normalized: word.lemma_normalized,
      meaning_zh: meaning,
    };
    if (list) list.push(item);
    else wordsByUnit.set(p.unit_id, [item]);
  }

  const out = new Map<string, UnitVocabulary>();
  for (const unit of seedBundle.units) {
    const words = wordsByUnit.get(unit.id);
    // 一个词都没有的单元不进索引 —— 调用方据此 404，而不是拿空词表去求模型写题
    if (!words || words.length === 0) continue;

    const volume = volumeById.get(unit.volume_id);
    const curriculum = volume ? curriculumById.get(volume.curriculum_id) : undefined;
    const unit_label = [
      curriculum?.display_name,
      volume?.grade_label,
      `${unit.unit_code}${unit.title_en ? ` ${unit.title_en}` : ""}`,
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" · ");

    out.set(unit.id, { unit_id: unit.id, unit_label, words });
  }

  return out;
}

/** 查不到返回 null —— 调用方必须当成真实失败（单元 id 拼错时**不要**回落到默认单元） */
export function lookupUnitVocabulary(unitId: string): UnitVocabulary | null {
  if (!unitIndex) unitIndex = buildUnitIndex();
  return unitIndex.get(unitId) ?? null;
}

/** 知道有几个单元能出题，给自检用 */
export function unitVocabularySize(): number {
  if (!unitIndex) unitIndex = buildUnitIndex();
  return unitIndex.size;
}
