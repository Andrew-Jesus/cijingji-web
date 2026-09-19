/**
 * 出题 —— 从「今日任务单的一行」变成「一张能作答的卡片」
 *
 * 铁律：**纯函数，无 AI，无 IO，可单测；同一个词每次生成的卡片完全一样。**
 *
 * ── 卡片模板与卡片内容分离（方案 §7.5 的硬要求）────────────────
 * 同一个词，`recognize`（看英选中）和 `recall_spell`（中译英）是**同一份内容的两种问法**，
 * 不是两个词条。所以这里只按 `mode` 换"问法"，词头/音标/义项一律取自同一处。
 * 这是以后做「通道权重」的前提 —— 那时候"同一个词用几种通道练"才说得通。
 *
 * ── 为什么种子取自 word_id，而不是"第几题"────────────────────
 * 如果按题序定种，那么"今天只练后 10 个词"时，同一个词的选项顺序会和昨天不一样，
 * 复习时会出现"我明明记得它在第二个"这种无意义的干扰。
 * 用 `hashSeed(word_id + mode)` 定种 = **这个词的这张卡永远长这样**，选项顺序稳定。
 *
 * ── 干扰项取同一单元的词（沿用自测那套判断）──────────────────
 * 同单元的词语义场接近，选项才有区分度。从整本书乱抽，
 * 正确答案会因为"太明显"而失去筛选力 —— 那样答对不代表会，答错也不知道错在哪。
 */
import type { Sense } from "@/lib/db/types";
import type { WordSnapshot } from "@/lib/scope/resolveScope";
import { hashSeed, mulberry32, shuffle } from "@/lib/util/random";
import type { StudyCard, StudyMode } from "./types";

export const OPTIONS_PER_CARD = 4;

/**
 * 任务单里的一行。
 *
 * 展示用的字段（lemma / meaning_zh / unit_code / confidence）**都是可选的** ——
 * 它们是为了让计划"自带快照"（见 `DailyPlanItem` 的注释）而抄进来的，
 * 早期存下来的计划可能没有。缺了就回落到词库里的当前值，
 * **而不是**因此出一道空题或者干脆把这张卡丢掉。
 */
export interface CardSourceItem {
  word_id: string;
  /**
   * 任务单里带下来的义项 id。
   *
   * **出题不用它**（卡片一律取 `is_primary` 的那个义项），留着是为了「按义项背」
   * 那天能顺着这条线演进。所以它是**可选**的：出题不该因为少这一个字段就出不来，
   * 早期存的计划、以及手工构造的数据都不必为它造一个值。
   */
  sense_id?: string | null;
  mode: string;
  lemma?: string;
  meaning_zh?: string | null;
  unit_code?: string;
  confidence?: number;
}

export interface BuildCardsInput {
  items: readonly CardSourceItem[];
  snapshot: WordSnapshot;
}

/**
 * 未知的 mode 一律当 `recognize`。
 *
 * 为什么是"回落"而不是"报错"：`mode` 存在数据库里，将来加了新模板
 * （listening / cloze）而旧版本页面读到它时，报错会让整页打不开；
 * 回落成最基础的问法，用户照样能练。
 */
export function normalizeMode(mode: string): StudyMode {
  return mode === "recall_spell" ? "recall_spell" : "recognize";
}

interface MeaningRef {
  word_id: string;
  meaning: string;
}

export function buildStudyCards({ items, snapshot }: BuildCardsInput): StudyCard[] {
  const wordById = new Map(snapshot.words.map((w) => [w.id, w]));
  const unitCodeById = new Map(snapshot.units.map((u) => [u.id, u.unit_code]));

  const primaryByWord = new Map<string, Sense>();
  for (const s of snapshot.senses) {
    if (s.is_primary) primaryByWord.set(s.word_id, s);
  }

  // 同一个词可能归属多个单元（如 mm 在 U2/U3 各一条）。取**第一条归属**作为"它的单元"，
  // 与 resolveScope 的去重口径一致（都保先出现的那条）。
  const placementOfWord = new Map<string, { unit_id: string; confidence: number }>();
  for (const p of snapshot.placements) {
    if (!placementOfWord.has(p.word_id)) {
      placementOfWord.set(p.word_id, { unit_id: p.unit_id, confidence: p.confidence });
    }
  }

  // 单元 → 该单元的释义池（干扰项来源）
  const meaningsByUnit = new Map<string, MeaningRef[]>();
  const globalPool: MeaningRef[] = [];
  for (const p of snapshot.placements) {
    const s = primaryByWord.get(p.word_id);
    const meaning = s?.cn_meaning?.trim();
    if (!meaning) continue;
    const ref: MeaningRef = { word_id: p.word_id, meaning };

    const list = meaningsByUnit.get(p.unit_id);
    if (list) list.push(ref);
    else meaningsByUnit.set(p.unit_id, [ref]);

    globalPool.push(ref);
  }

  const cards: StudyCard[] = [];

  for (const item of items) {
    const word = wordById.get(item.word_id);
    if (!word) continue;

    const sense = primaryByWord.get(item.word_id) ?? null;
    // 优先用任务单里带下来的释义（它与结果页展示的是同一份），没有才回落到主义项
    const meaning = (item.meaning_zh ?? sense?.cn_meaning ?? "").trim();
    // 没有中文释义就出不了题：`recognize` 没选项、`recall_spell` 没题干。
    // 如实跳过，而不是拿一个空字符串去凑一张卡。
    if (!meaning) continue;

    const mode = normalizeMode(item.mode);
    const placement = placementOfWord.get(item.word_id) ?? null;
    const unitId = placement?.unit_id ?? null;

    const card: StudyCard = {
      word_id: item.word_id,
      mode,
      // 计划里的快照优先；没有就回落到词库当前值 —— 卡片少一个字段不该让整道题消失
      lemma: item.lemma?.trim() || word.lemma,
      phonetic_uk: word.phonetic_uk,
      pos: sense?.pos ?? null,
      meaning_zh: meaning,
      unit_code: item.unit_code?.trim() || (unitId ? (unitCodeById.get(unitId) ?? "") : ""),
      confidence: item.confidence ?? placement?.confidence ?? 1,
      answers: uniqueAnswers(word.lemma, word.lemma_normalized),
    };

    if (mode === "recognize") {
      const picks = pickDistractors(
        { word_id: item.word_id, meaning },
        unitId,
        meaningsByUnit,
        globalPool,
      );

      // 凑不出干扰项时**改用拼写题**：宁可换一种问法，也不要出一道"只有一个选项"的假选择题。
      if (picks.length === 0) {
        card.mode = "recall_spell";
        delete card.options;
        delete card.answer_index;
      } else {
        const rng = mulberry32(hashSeed(`${item.word_id}|${mode}`));
        const options = shuffle([meaning, ...picks], rng);
        card.options = options;
        card.answer_index = options.indexOf(meaning);
      }
    }

    cards.push(card);
  }

  return cards;
}

/**
 * 取干扰项：先同单元，不够再全局兜底。
 * 排序靠 `shuffle(pool, rng)` 而不是 `pool.slice()` —— 后者会让"永远是前几个词"
 * 变成一条可被用户摸出来的规律。
 */
function pickDistractors(
  correct: MeaningRef,
  unitId: string | null,
  meaningsByUnit: Map<string, MeaningRef[]>,
  globalPool: MeaningRef[],
): string[] {
  const rng = mulberry32(hashSeed(`${correct.word_id}|distractors`));
  const taken = new Set<string>([correct.meaning.trim()]);
  const out: string[] = [];
  const want = OPTIONS_PER_CARD - 1;

  const draw = (pool: readonly MeaningRef[]) => {
    for (const cand of shuffle(pool, rng)) {
      if (out.length >= want) return;
      if (cand.word_id === correct.word_id) continue;
      const key = cand.meaning.trim();
      // 同一个释义不能出现两次 —— 否则一道题里有**两个正确答案**，
      // 用户选另一个也会被判错，这是最伤信任的一类 bug。
      if (taken.has(key)) continue;
      taken.add(key);
      out.push(cand.meaning);
    }
  };

  if (unitId) draw(meaningsByUnit.get(unitId) ?? []);
  if (out.length < want) draw(globalPool);
  return out;
}

/** 可接受的写法：原形 + 归一形（去连字符、小写）。去重后返回，避免同一答案判两次 */
function uniqueAnswers(lemma: string, normalized: string): string[] {
  const set = new Set<string>([lemma.trim(), normalized.trim()].filter((s) => s.length > 0));
  return [...set];
}

/**
 * 词库里全部词形的归一集合 —— 判"拼成了另一个真实的词"（confusion）要用。
 *
 * 为什么放在这里（而不是塞进每张卡）：这是**整个词库级别**的事实，
 * 每张卡各存一份 420 个字符串是纯粹的浪费，而且会出现"两张卡的集合不一样"这种怪事。
 */
export function buildKnownLemmaSet(snapshot: WordSnapshot): Set<string> {
  const set = new Set<string>();
  for (const w of snapshot.words) {
    const n = w.lemma_normalized.trim().toLowerCase();
    if (n) set.add(n);
  }
  return set;
}
