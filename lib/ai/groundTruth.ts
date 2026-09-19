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
import type { WordFacts } from "./prompt";

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
