/**
 * 自测专用释义修正表
 *
 * ── 为什么要有这个文件（2026-10-17，Andy 实测反馈）────────────────
 *
 * 词库的释义只有一个来源：**课本词表原文**（这是护城河，也过了两路 OCR + 回图正校）。
 * 问题在于课本给的是**那一课的语境义**，有时窄得离谱：
 * `condition` 在八上 Unit 3 记的是「长期疾病」（课里讲的是病情），
 * 而学习者脑子里 `condition` 是「条件 / 状况」。
 *
 * 于是 20 题自测里出现了这么一题：题面 `condition`，四个选项里
 * 没有一个「条件」—— 用户明明认识这个词，却**找不到任何正确选项**。
 * 这既冤枉人，又会让人以为题目出错了（信任损伤比答错更贵）。
 *
 * ── 三条边界（这张表不许越界）─────────────────────────────────
 *
 *   1. **绝不改词库**。`seed-data.json` 里的 primary 释义一个字都不动
 *      —— 学习卡片要跟课本走，那是「教」；这里只是「考」的口径。
 *   2. **释义必须有出处**，取自 ECDICT（MIT，项目唯一可商用的词典源）的
 *      `translation` 字段，不凭印象编。`source` 里写明原文，便于复核。
 *   3. **只登记「课本义窄到没法独立成题」的词**，不是「我想换个说法」的词。
 *      判断标准：课本义与通用义**指向不同的现实事物**（病情 vs 条件），
 *      而不是同义改写（「愉快」vs「快乐」不算）。
 *
 * ── 这张表会失效吗 ────────────────────────────────────────────
 *
 * 会。它按 `word_id` 硬编码，词库换版、单元调整后可能对不上。
 * 所以 `quiz.test.ts` 里有一条断言：**表里每个 word_id 必须仍在词库中存在**，
 * 对不上就当场报错，而不是悄悄失效。
 */

export interface QuizSenseFix {
  /** 词条 id，形如 `w:condition` */
  word_id: string;
  /** 自测里当正确答案用的释义（通用义） */
  meaning: string;
  /** 课本原释义。留在这里只为将来核对「当初为什么要改」 */
  textbook: string;
  /** 出处原文，必须可查 */
  source: string;
  /** 一句话说明为什么不改就没法做题 */
  reason: string;
}

export const QUIZ_SENSE_FIX: readonly QuizSenseFix[] = [
  {
    word_id: "w:condition",
    textbook: "长期疾病",
    meaning: "情况；状况；条件",
    source: "ECDICT condition.translation = `n. 情况, 条件`",
    reason:
      "课本八上 Unit 3 取的是医学义（a heart condition 这类用法）。只给这一条时，认识 condition 是「条件」的人四个选项全对不上（2026-10-17 实测）。",
  },
  {
    word_id: "w:reach",
    textbook: "实现，达成",
    meaning: "到达；抵达；达到",
    source: "ECDICT reach.translation = `vt. 到达, 达到, 伸出, 延伸, 影响`",
    reason:
      "课本取「实现（目标）」义。通用认知是「到达」，同样属于窄义单独成题会冤枉人；「达到」已覆盖课本义，不丢信息。",
  },
];

/** 查这个词在自测里该用哪条释义；没登记就返回 null（照常用课本义） */
export function quizSenseFixFor(wordId: string): string | null {
  return QUIZ_SENSE_FIX.find((f) => f.word_id === wordId)?.meaning ?? null;
}
