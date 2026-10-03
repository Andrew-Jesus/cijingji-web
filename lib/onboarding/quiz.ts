/**
 * 20 词自测 —— 抽题与分档
 *
 * 铁律：**纯函数，无 AI，无 IO，可单测；同种子必得同结果。**
 *
 * 三个刻意的设计选择，都不是随手写的：
 *
 *   1. **不用真随机，用固定种子的 PRNG。**
 *      抽题必须可复现 —— 否则"同一份数据每次抽出来的卷子不一样"，
 *      单测无从下手，线上出问题也无从排查。用 `Math.random()` 就写不出
 *      "同种子同结果"这条测试。这个阶段不需要密码学强度的随机。
 *
 *   2. **跨单元轮转取词，不是随机抽 20 个。**
 *      若只在 Unit 1 出题，"自测"就退化成"考第一单元"，分档结果没有意义。
 *      轮转保证每个单元都被覆盖到（8 个单元 → 前 4 个各 3 题、后 4 个各 2 题）。
 *
 *   3. **干扰项优先取**同一单元**的其他词。**
 *      同单元词的语义场更接近，选项才有区分度；从整个词库乱抽，
 *      正确答案会因为"太明显"而失去筛选力。
 *
 * ── 2026-10-02：多册之后的「单元身份」问题（本轮修的坑）──────────
 *
 * `unit_code` 是**课本自己的标号**：「Unit 1」。单册时代它是唯一的，
 * 三册并存之后 **八上 Unit 1 / 八下 Unit 1 / 九上 Unit 1 的 unit_code 完全一样**。
 * 于是任何"按 unit_code 分组 / 去重 / 计数"的写法都会把三册的同号单元悄悄并成一格：
 * 自测的 by_unit 从 18 格塌成 6 格，而且**不报错、不崩**。
 *
 * 修法：**分组一律用 `unit_id`**（带册次前缀，全局唯一），
 * `unit_code` 只用来"给人看"，并且给人看时必须带上册次（见 `unitLabel`）。
 *
 * 这条不是本文件独有的：凡是"看起来像 id 但其实是标号"的字段
 * （`Unit 1`、`Part A`、`Chapter 2`）一旦跨容器使用，都会踩同一个坑。
 *
 * 边界（如实说，不假装）：这个自测只是**冷启动的粗略分档**，
 * 用来决定一开始的难度，不是测评。
 */
import type { Sense, Word, WordPlacement } from "@/lib/db/types";
import type { WordSnapshot } from "@/lib/scope/resolveScope";
// PRNG 与洗牌只有一份实现（lib/util/random.ts）—— 学习页出题也用同一套。
// 抄第二份的话，"同种子同结果"这条保证迟早会在一处被改坏而另一处不知道。
import { mulberry32, shuffle } from "@/lib/util/random";

export const QUIZ_SIZE = 20;
export const OPTIONS_PER_QUESTION = 4;

/**
 * 固定种子。**故意不做成"每次重抽"**：
 * 量尺必须是同一把，否则"上次答对 12 个、这次答对 14 个"无法比较。
 * 换题源时改这个数即可，不必改逻辑。
 */
export const QUIZ_SEED = 20260918;

export interface QuizQuestion {
  word_id: string;
  lemma: string;
  phonetic_uk: string | null;
  pos: string | null;
  /**
   * 单元的**全局唯一标识**（`wys_2024:8A:U1`）。分组、计数、去重一律用它 ——
   * 用 `unit_code` 会把三册的同号单元并成一格（见文件头注释）。
   */
  unit_id: string;
  /** 课本自己的标号「Unit 1」。**只能显示，不能当身份** */
  unit_code: string;
  /** 4 条释义，已打乱 */
  options: string[];
  /** 正确选项下标。**作答前界面不得读取它** —— 但判分需要它，所以放在这里而不是另建映射 */
  answer_index: number;
}

export interface BuildQuizInput {
  snapshot: WordSnapshot;
  size?: number;
  seed?: number;
  /** 限定单元（传的是 **unit_id**）；不传 = 用快照里全部有词的单元 */
  units?: string[];
}

// ------------------------------------------------------------------ 主函数

export function buildQuiz(input: BuildQuizInput): QuizQuestion[] {
  const { snapshot } = input;
  const size = input.size ?? QUIZ_SIZE;
  const rng = mulberry32(input.seed ?? QUIZ_SEED);

  const unitById = new Map(snapshot.units.map((u) => [u.id, u]));
  const wordById = new Map(snapshot.words.map((w) => [w.id, w]));

  const primaryByWord = new Map<string, Sense>();
  for (const s of snapshot.senses) {
    if (s.is_primary) primaryByWord.set(s.word_id, s);
  }

  // ---- 每个单元的候选（有义项、释义非空、词条存在）----
  const candidatesByUnit = new Map<string, WordPlacement[]>();
  const seenPerUnit = new Set<string>(); // `${unit}|${word}`，同一词在同一单元只留一条
  for (const p of snapshot.placements) {
    if (input.units && !input.units.includes(p.unit_id)) continue;
    if (!unitById.has(p.unit_id)) continue;
    if (!wordById.has(p.word_id)) continue;
    const sense = primaryByWord.get(p.word_id);
    if (!sense || sense.cn_meaning.trim() === "") continue;

    const key = `${p.unit_id}|${p.word_id}`;
    if (seenPerUnit.has(key)) continue;
    seenPerUnit.add(key);

    const arr = candidatesByUnit.get(p.unit_id);
    if (arr) arr.push(p);
    else candidatesByUnit.set(p.unit_id, [p]);
  }

  // 单元顺序 = 册次 → unit_no 升序（确定性）。
  // 为什么不能只按 unit_no：三册各有 Unit 1~6，只按 unit_no 排序会让
  // 三册的 Unit 1 挤在一起，轮转时"一遍扫过去"的顺序在册与册之间来回跳。
  // 排序键里带上 unit_id 前缀（册次在冒号前一段），跨册顺序就稳定了。
  const unitIds = [...candidatesByUnit.keys()].sort((a, b) => {
    const va = volumeKeyOf(a);
    const vb = volumeKeyOf(b);
    if (va !== vb) return va < vb ? -1 : 1;
    return (unitById.get(a)?.unit_no ?? 0) - (unitById.get(b)?.unit_no ?? 0);
  });

  // 单元内：先按 lemma 排序（消除上游顺序差异），再用种子洗牌
  const poolByUnit = new Map<string, WordPlacement[]>();
  for (const uid of unitIds) {
    const sorted = [...(candidatesByUnit.get(uid) ?? [])].sort((a, b) =>
      lemma(wordById, a).localeCompare(lemma(wordById, b)),
    );
    poolByUnit.set(uid, shuffle(sorted, rng));
  }

  // ---- 轮转取词 ----
  const cursor = new Map<string, number>(unitIds.map((u) => [u, 0]));
  const picked: WordPlacement[] = [];
  let progressed = true;
  while (picked.length < size && progressed) {
    progressed = false;
    for (const uid of unitIds) {
      if (picked.length >= size) break;
      const pool = poolByUnit.get(uid) ?? [];
      const i = cursor.get(uid) ?? 0;
      if (i < pool.length) {
        picked.push(pool[i]);
        cursor.set(uid, i + 1);
        progressed = true;
      }
    }
  }

  // ---- 干扰项池 ----
  const globalPool: MeaningRef[] = [];
  for (const s of snapshot.senses) {
    if (!s.is_primary) continue;
    if (s.cn_meaning.trim() === "") continue;
    globalPool.push({ word_id: s.word_id, meaning: s.cn_meaning });
  }
  const poolByUnitMeanings = new Map<string, MeaningRef[]>();
  for (const uid of unitIds) {
    const list: MeaningRef[] = [];
    for (const p of poolByUnit.get(uid) ?? []) {
      const s = primaryByWord.get(p.word_id);
      if (s) list.push({ word_id: p.word_id, meaning: s.cn_meaning });
    }
    poolByUnitMeanings.set(uid, list);
  }

  // ---- 出题 ----
  const wantDistractors = OPTIONS_PER_QUESTION - 1;

  /** 从释义池里取不重复的干扰项；先同单元，不够再全局兜底 */
  const pickDistractors = (
    wordId: string,
    unitPool: MeaningRef[],
    correct: string,
  ): string[] => {
    const taken = new Set<string>([norm(correct)]);
    const out: string[] = [];

    const draw = (pool: MeaningRef[]) => {
      for (const cand of shuffle(pool, rng)) {
        if (out.length >= wantDistractors) return;
        if (cand.word_id === wordId) continue;
        const key = norm(cand.meaning);
        if (taken.has(key)) continue; // 同一个释义不能出现两次，否则"两个正确答案"
        taken.add(key);
        out.push(cand.meaning);
      }
    };

    draw(unitPool);
    if (out.length < wantDistractors) draw(globalPool);
    return out;
  };

  const questions: QuizQuestion[] = [];
  for (const p of picked) {
    const word = wordById.get(p.word_id);
    const sense = primaryByWord.get(p.word_id);
    if (!word || !sense) continue;

    const correct = sense.cn_meaning;
    const distractors = pickDistractors(p.word_id, poolByUnitMeanings.get(p.unit_id) ?? [], correct);

    // 数据太小时可能连一个干扰项都凑不出 —— 那种题不该出现在卷子上
    if (distractors.length === 0) continue;

    const options = shuffle([correct, ...distractors], rng);
    questions.push({
      word_id: p.word_id,
      lemma: word.lemma,
      phonetic_uk: word.phonetic_uk,
      pos: sense.pos,
      unit_id: p.unit_id,
      unit_code: unitById.get(p.unit_id)?.unit_code ?? "",
      options,
      answer_index: options.indexOf(correct),
    });
  }

  return questions;
}

// ------------------------------------------------------------------ 判分与分档

export type Level = 1 | 2 | 3;

export interface LevelBand {
  /** 得分率上界（含）。按比例而非绝对题数分档，换题量不会失效。 */
  max_ratio: number;
  level: Level;
  label: string;
  note: string;
}

/**
 * 分档线。阈值不是拍的，是拿"瞎猜的期望值"对齐的：
 * 四选一乱猜的期望得分率是 **25%**，
 *   所以 ≤40% 这一档，含义是"基本还是靠猜" —— 按入门安排；
 *   >70% 才算真的认得。
 *
 * 档位名（入门 / 中等 / 熟练）取自实施方案 §7.2，**不要自行改名** ——
 * 文档与界面用同一个词，跨会话核对时才对得上。
 */
export const LEVEL_BANDS: LevelBand[] = [
  {
    max_ratio: 0.4,
    level: 1,
    label: "入门",
    note: "先按最稳的节奏来：新词少一点，先把「认得出来」这一步走扎实。",
  },
  {
    max_ratio: 0.7,
    level: 2,
    label: "中等",
    note: "认得不少了。接下来重点练「能写出来」和「知道怎么用」。",
  },
  {
    max_ratio: 1.01,
    level: 3,
    label: "熟练",
    note: "基础不错，可以适当加快，多分一点时间给拼写和搭配。",
  },
];

export interface UnitBreakdown {
  /** 分组键，全局唯一（带册次前缀） */
  unit_id: string;
  /**
   * ⚠️ 与 `QuizQuestion.unit_code` **不是同一个东西**。
   *
   * 问题对象上它是课本标号（"Unit 1"）；这里它是**给人看的那一整行**
   * （"八上 Unit 1"）。原因很实在：三册并存时"Unit 1"会出现三次，
   * 结果页那张清单会出现三行一模一样的「Unit 1 0/1」，用户没法分辨。
   * 这里是**唯一**一处被允许带上册次的 `unit_code`。
   */
  unit_code: string;
  correct: number;
  total: number;
}

export interface QuizResult {
  total: number;
  correct: number;
  ratio: number;
  level: Level;
  label: string;
  note: string;
  by_unit: UnitBreakdown[];
}

/** 只数数，不分档 —— 界面想自己展示"答对 13 / 20"时用它 */
export function scoreAnswers(
  questions: QuizQuestion[],
  answers: (number | null)[],
): { correct: number; total: number } {
  let correct = 0;
  questions.forEach((q, i) => {
    if (answers[i] === q.answer_index) correct += 1;
  });
  return { correct, total: questions.length };
}

/** 得分率 → 档位（纯计算，便于单独测边界值） */
export function bandFor(correct: number, total: number): Omit<QuizResult, "by_unit"> {
  const ratio = total > 0 ? correct / total : 0;
  const band = LEVEL_BANDS.find((b) => ratio <= b.max_ratio) ?? LEVEL_BANDS[LEVEL_BANDS.length - 1];
  return {
    total,
    correct,
    ratio,
    level: band.level,
    label: band.label,
    note: band.note,
  };
}

/**
 * 判分 + 按单元汇总。
 *
 * **按 `unit_id` 分组，不按 `unit_code`** —— 后者三册重号（见文件头注释）。
 */
export function scoreQuiz(questions: QuizQuestion[], answers: (number | null)[]): QuizResult {
  const { correct, total } = scoreAnswers(questions, answers);

  const byUnitMap = new Map<string, UnitBreakdown>();
  questions.forEach((q, i) => {
    const row =
      byUnitMap.get(q.unit_id) ??
      { unit_id: q.unit_id, unit_code: unitLabel(q), correct: 0, total: 0 };
    row.total += 1;
    if (answers[i] === q.answer_index) row.correct += 1;
    byUnitMap.set(q.unit_id, row);
  });

  return { ...bandFor(correct, total), by_unit: [...byUnitMap.values()] };
}

export function levelLabel(level: number): string {
  return LEVEL_BANDS.find((b) => b.level === level)?.label ?? `第 ${level} 档`;
}

// ------------------------------------------------------------------ 工具

interface MeaningRef {
  word_id: string;
  meaning: string;
}

function lemma(wordById: Map<string, Word>, p: WordPlacement): string {
  return (wordById.get(p.word_id)?.lemma ?? "").toLowerCase();
}

/** 只做空白归一 —— 不做大小写/标点清洗，中文释义那套清洗会误伤 */
function norm(s: string): string {
  return s.trim();
}

// ------------------------------------------------------------------ 单元身份

/** 年级的中文数字。下标 = 年级数字（8 → 「八」） */
const GRADE_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 从 `wys_2024:8A:U1` 里取出册次那一段（`8A`） */
function volumeKeyOf(unitId: string): string {
  return unitId.split(":")[1] ?? "";
}

/**
 * `8A` → 「八上」。用户手上翻的是课本，课本封面上写的是「八年级上册」，
 * 只写 `8A` 他对不上号。
 *
 * 认不出来就把原串还回去 —— **绝不猜**（猜错会把九上说成八上）。
 */
export function volumeShortLabel(volumeKey: string): string {
  const m = /^(\d)([ABF])$/.exec(volumeKey);
  if (!m) return volumeKey;
  const grade = GRADE_CN[Number(m[1])] ?? m[1];
  const term = m[2] === "A" ? "上" : m[2] === "B" ? "下" : "全";
  return `${grade}${term}`;
}

/** 一个单元的整行显示名：「八上 Unit 1」。册次拿不到时退回课本标号本身 */
export function unitLabel(q: Pick<QuizQuestion, "unit_id" | "unit_code">): string {
  const short = volumeShortLabel(volumeKeyOf(q.unit_id));
  return short ? `${short} ${q.unit_code}` : q.unit_code;
}
