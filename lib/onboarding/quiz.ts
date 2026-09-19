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
 * 边界（如实说，不假装）：这个自测只是**冷启动的粗略分档**，
 * 用来决定一开始的难度，不是测评。题源是样张数据，与 Andy 的课本不一致。
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
  /** 限定单元；不传 = 用快照里全部有词的单元 */
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

  // 单元顺序 = unit_no 升序（确定性）
  const unitIds = [...candidatesByUnit.keys()].sort(
    (a, b) => (unitById.get(a)?.unit_no ?? 0) - (unitById.get(b)?.unit_no ?? 0),
  );

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

export function scoreQuiz(questions: QuizQuestion[], answers: (number | null)[]): QuizResult {
  const { correct, total } = scoreAnswers(questions, answers);

  const byUnitMap = new Map<string, UnitBreakdown>();
  questions.forEach((q, i) => {
    const row = byUnitMap.get(q.unit_code) ?? { unit_code: q.unit_code, correct: 0, total: 0 };
    row.total += 1;
    if (answers[i] === q.answer_index) row.correct += 1;
    byUnitMap.set(q.unit_code, row);
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
