/**
 * buildDailyPlan —— 从「一批词」到「今日任务单」
 *
 * 铁律：**纯函数，不含 AI 调用，无副作用，可单测；同输入两次结果必须一致（幂等）。**
 *
 * 阶段 0 的边界（重要，别把它当成品）：
 *   - 排序规则是**简化确定性版**：错词优先 → 其余保持 resolveScope 给的顺序。
 *   - **没有接 FSRS**。何时复习由阶段 2 的 FSRS 独占，这里不猜任何复习间隔。
 *   - 卡片模式只按 pace.spelling_required 二选一，不做通道权重分配（那是 applyProfile 的事）。
 */
import { secondsForMode } from "./estimate";
import type { WordRef } from "@/lib/scope/resolveScope";
import type { Pace } from "@/lib/db/types";

export interface DailyPlanItemDraft {
  word_id: string;
  sense_id: string | null;
  mode: string;
  priority_score: number;
  lemma: string;
  meaning_zh: string | null;
  unit_code: string;
  confidence: number;
}

export interface BuildPlanInput {
  /** 已排好序的词（来自 resolveScope） */
  words: WordRef[];
  /** 错词本里的词 id（从 review_logs 派生后传入 —— 保持本函数无 IO） */
  weak_word_ids?: string[];
  daily_cap: number;
  pace: Pace;
}

export interface BuildPlanOutput {
  items: DailyPlanItemDraft[];
  estimated_minutes: number;
  /** 一句今日提示。阶段 0 用模板，不调 AI（AI 只留给兴趣域例句那一条通路） */
  brief: string;
  breakdown: { weak: number; fresh: number };
}

export const WEIGHT_WEAK = 1.5;
export const WEIGHT_FRESH = 1.0;

export function chooseMode(pace: Pace): string {
  return pace.spelling_required ? "recall_spell" : "recognize";
}

export function buildDailyPlan(input: BuildPlanInput): BuildPlanOutput {
  const { words, daily_cap, pace } = input;
  const weakSet = new Set(input.weak_word_ids ?? []);
  const mode = chooseMode(pace);

  const toItem = (w: WordRef, weak: boolean): DailyPlanItemDraft => ({
    word_id: w.word_id,
    sense_id: w.sense_id,
    mode,
    priority_score: weak ? WEIGHT_WEAK : WEIGHT_FRESH,
    lemma: w.lemma,
    meaning_zh: w.meaning_zh,
    unit_code: w.unit_code,
    confidence: w.confidence,
  });

  // 稳定分层：错词保持原序在前，其余保持原序在后 —— 不做随机、不用时间，保证幂等
  const weakItems = words.filter((w) => weakSet.has(w.word_id)).map((w) => toItem(w, true));
  const freshItems = words.filter((w) => !weakSet.has(w.word_id)).map((w) => toItem(w, false));

  // 新词 : 复习的比例只决定"今天取多少"，绝不决定"何时再练"（后者是 FSRS 的领地）
  const ratio = Math.min(Math.max(pace.new_ratio, 0), 1);
  const freshQuota = Math.round(daily_cap * ratio);
  const weakQuota = daily_cap - freshQuota;

  const picked = [
    ...weakItems.slice(0, Math.max(weakQuota, 0)),
    ...freshItems.slice(0, Math.max(freshQuota, 0)),
  ];

  // 万一某一类不够，用另一类补足（避免"今天只有 3 个词"）
  if (picked.length < daily_cap) {
    const pickedIds = new Set(picked.map((i) => i.word_id));
    for (const item of [...weakItems, ...freshItems]) {
      if (picked.length >= daily_cap) break;
      if (!pickedIds.has(item.word_id)) {
        picked.push(item);
        pickedIds.add(item.word_id);
      }
    }
  }

  const totalSeconds = picked.reduce((sum, i) => sum + secondsForMode(i.mode), 0);
  const estimated_minutes = Math.max(1, Math.round(totalSeconds / 60));

  return {
    items: picked,
    estimated_minutes,
    brief: `今天 ${picked.length} 个词，约 ${estimated_minutes} 分钟。`,
    breakdown: { weak: picked.filter((i) => i.priority_score === WEIGHT_WEAK).length, fresh: picked.filter((i) => i.priority_score === WEIGHT_FRESH).length },
  };
}
