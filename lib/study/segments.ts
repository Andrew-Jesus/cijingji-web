/**
 * 今日路线分段 —— 「热身 → 攻坚 → 新词」（规格书 §20.3.1 四机制里的「变化」）
 *
 * 同一天不再是又一遍同样的卡，而是一段有起伏的路：
 * 先把状态找回来（热身），再打硬仗（攻坚），最后见新面孔（新词）。
 * 「比例随时长挡位变」由排课层负责（daily_cap × new_ratio，§20.6 的挡位机制），
 * 这里只负责把**已排好**的卡重排成三段呈现 —— 不碰取词规则。
 *
 * ── 铁律 ─────────────────────────────────────────────────────
 * 只重排：不丢卡、不加卡、不改任何一张卡的属性。
 * 排课层的顺序（到期优先、逾期多的先还）是记忆科学的决定，**保留在存储里**；
 * 这里重排的只是**呈现顺序** —— 就像排课按算法、上课按课表。
 * 所以 `saveDailyPlan` 存的仍是排课原样，重排发生在装载时、每次都一样（幂等）。
 *
 * ── 三段怎么分 ───────────────────────────────────────────────
 * 每张卡的身份直接读任务单里的 `priority_score`（buildDailyPlan 的四个常量）：
 *   · WEIGHT_DUE(2.0)     到期复习   → 热身（见过的词，今天该还的账，门槛低）
 *   · WEIGHT_NOT_DUE(0.5) 补位复习   → 热身（同上，只是还没到期）
 *   · WEIGHT_WEAK(1.5)    错过的词   → 攻坚（硬仗 —— weakSet 里的词在排课时
 *                                     无论走哪条路都写成这个值，不用再传 weakWordIds）
 *   · WEIGHT_FRESH(1.0)   新词       → 新词（无作答记录）
 *
 * ── 旧计划兼容 ───────────────────────────────────────────────
 * FSRS 接入前（旧路径）只有 WEAK/FRESH 两种值，排出的单子天然只有攻坚+新词两段，
 * 热身段为空、整个不出现 —— 界面对空段不渲染，不需要特判。
 * 而"今天取到旧计划"这件事不存在：任务单按 plan_date 取当天的，
 * 今天的单子必然由新路径生成。
 *
 * ── 未知 weight 兜底 ─────────────────────────────────────────
 * 只可能来自"未来加了新等级"。兜进热身（复习性质、最保守的标签）——
 * 把复习卡说成新词是撒谎，说成攻坚是吓唬人。
 */
import {
  WEIGHT_FRESH,
  WEIGHT_WEAK,
} from "@/lib/plan/buildDailyPlan";
import type { QueueEntry } from "./session";

/** 段的身份。SEGMENTS 的顺序即行进顺序 */
export type SegmentKind = "warmup" | "siege" | "fresh";

export interface JourneySegment {
  kind: SegmentKind;
  label: string;
  /** 段内词 id，保持任务单原序 */
  wordIds: readonly string[];
}

/** 三段的身份、标签与切换文案。唯一出处 —— 重排、路线行、过渡行共用这一份 */
export const SEGMENTS: readonly { kind: SegmentKind; label: string; note: string }[] = [
  { kind: "warmup", label: "热身", note: "到期的复习，先把状态找回来" },
  { kind: "siege", label: "攻坚", note: "这些词之前错过，回来算账" },
  { kind: "fresh", label: "新词", note: "硬仗打完，见几个新面孔" },
];

/**
 * weight → 段。⚠️ 未知值兜进热身（见文件头），**绝不当新词**。
 * 用 `===` 而不是区间：这四个值是排课层的字面常量，不是刻度，
 * 区间判断会在未来加新等级时悄悄吞掉它们。
 */
export function segmentOfWeight(score: number): SegmentKind {
  if (score === WEIGHT_WEAK) return "siege";
  if (score === WEIGHT_FRESH) return "fresh";
  return "warmup"; // WEIGHT_DUE / WEIGHT_NOT_DUE / 未知值
}

/** 分段输入的最小形状 —— DailyPlanItem 天然满足 */
export interface SegmentableItem {
  word_id: string;
  priority_score: number;
}

/**
 * 非空段列表，按行进顺序。**空段不出现** —— 界面不为"今天没有攻坚"画一个空格子。
 * 段内顺序 = items 原序（排课层已把段内的先后排好：到期按逾期天数、新词按 resolveScope 序）。
 */
export function buildJourneySegments(items: readonly SegmentableItem[]): JourneySegment[] {
  const byKind = new Map<SegmentKind, string[]>();
  for (const it of items) {
    const kind = segmentOfWeight(it.priority_score);
    const list = byKind.get(kind);
    if (list) list.push(it.word_id);
    else byKind.set(kind, [it.word_id]);
  }

  const out: JourneySegment[] = [];
  for (const seg of SEGMENTS) {
    const ids = byKind.get(seg.kind);
    if (ids && ids.length > 0) out.push({ kind: seg.kind, label: seg.label, wordIds: ids });
  }
  return out;
}

/** word_id → 段。给学习页查"当前这张卡属于哪一段"用（卡上没有 weight，得靠这份表） */
export function segmentByWord(
  items: readonly SegmentableItem[],
): ReadonlyMap<string, SegmentKind> {
  return new Map(items.map((it) => [it.word_id, segmentOfWeight(it.priority_score)]));
}

/**
 * 呈现顺序重排：热身 → 攻坚 → 新词，段内保持任务单原序。
 * `Array.prototype.sort` 自 ES2019 起规定为稳定排序，同段内不改相对次序；
 * 任务单里 word_id 唯一（buildDailyPlan 的 pickedIds 防重），不存在同词歧义。
 */
export function reorderForJourney<T extends SegmentableItem>(items: readonly T[]): T[] {
  const order: Record<SegmentKind, number> = { warmup: 0, siege: 1, fresh: 2 };
  return [...items].sort(
    (a, b) =>
      order[segmentOfWeight(a.priority_score)] - order[segmentOfWeight(b.priority_score)],
  );
}

/**
 * 段内进度 —— 与 `progressAt` 同一个口径：分母 = 段的词数，
 * 分子 = 段内"pos 往后不再出现"的词。答错回插不虚高（同一个词 pending 只数一次）。
 * 别段的卡不算分母也不算分子 —— 这是"这条路走到第几步"，不是全局进度。
 */
export function segmentProgressAt(
  queue: readonly QueueEntry[],
  pos: number,
  seg: JourneySegment,
): { done: number; total: number } {
  const ids = new Set(seg.wordIds);
  let pending = 0;
  for (let i = Math.max(pos, 0); i < queue.length; i += 1) {
    const entry = queue[i];
    if (entry && ids.has(entry.card.word_id)) pending += 1;
  }
  return { done: Math.max(ids.size - pending, 0), total: ids.size };
}

/**
 * 段切换时的一行文案。按**段**写而不是按"从哪切来"写：
 * 答错回插会把攻坚段的卡塞进新词段的位置，"从新词切回攻坚"这种事真实存在，
 * 按转移对写的文案在这种时刻会说出"热身完毕"这种假话。
 * 热身没有"进入"文案 —— 开场就是它，进度行已经标着，再打招呼是噪音。
 */
export function transitionNoteFor(kind: SegmentKind): string | null {
  if (kind === "warmup") return null;
  return SEGMENTS.find((s) => s.kind === kind)?.note ?? null;
}
