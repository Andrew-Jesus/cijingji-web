/**
 * 「今日任务单」的唯一装配口径 —— 纯函数，可单测
 *
 * ── 为什么必须收敛到这一个函数 ────────────────────────────────
 * 有三处页面要展示同一份今天的量：首页、引导结果页、学习页。
 * 在收敛之前，首页与结果页各自跑了一遍
 * `validateScope → resolveScope → mergeProfile → chooseMode → dailyCapFor → buildDailyPlan`
 * 这六步 —— **同一段流水线写两遍、第三处又要再写一遍**。
 * 而它一旦不一致，症状是用户最容易发现也最伤信任的那类：
 * "结果页说每天 36 个词，首页显示 20 个"。
 *
 * 所以这六步收成一个纯函数：
 *   · 输入相同 → 输出必然相同（幂等，可快照测试）；
 *   · 页面只负责"把数据读出来"和"把结果显示出去"，不碰装配规则；
 *   · 以后要加"按复习阶段调量"，只改这一个函数。
 *
 * 注意它是**纯的**：不读数据库、不读环境、不看时钟。
 * （`plan_date` 由调用方给，函数自己不取"今天" —— 取时间会让它没法单测。）
 */
import type { GoalProfile } from "@/lib/db/types";
import { mergeProfile, type MergedProfile } from "@/lib/profile/mergeProfile";
import { LIMITS, defaultScope, validateScope, type ScopeJson } from "@/lib/scope/schema";
import { resolveScope, type WordSnapshot } from "@/lib/scope/resolveScope";
import { buildDailyPlan, chooseMode, type BuildPlanOutput } from "./buildDailyPlan";
import { dailyCapFor } from "./estimate";

/** 范围没有 label 时的兜底叫法。**唯一一处** —— 三个页面共用同一个词 */
export const DEFAULT_SCOPE_LABEL = "起始单元";

export function scopeLabelOf(scope: ScopeJson): string {
  return scope.label?.trim() || DEFAULT_SCOPE_LABEL;
}

export interface AssemblePlanInput {
  snapshot: WordSnapshot;
  /** 策略包那一行（阶段 0 固定是中考） */
  goalProfile: GoalProfile;
  /** 用户答的"每天多少分钟" */
  dailyMinutes: number;
  /** 还没稳住的词（来自 review_logs）。不传 = 当没有 */
  weakWordIds?: readonly string[];
  /** 不传则用阶段 0 默认范围（八上 Unit 1） */
  scope?: ScopeJson;
}

export type AssemblePlanResult =
  | {
      ok: true;
      plan: BuildPlanOutput;
      merged: MergedProfile;
      /** 实际会用的卡片模板（recognize / recall_spell） */
      mode: string;
      dailyCap: number;
      scope: ScopeJson;
      scopeLabel: string;
      /** 该范围内一共多少词（用来算"几天过一遍"） */
      wordsInScope: number;
      /** 范围内最低置信度，驱动界面的诚实标注 */
      scopeConfidence: number;
    }
  | { ok: false; code: string; message: string };

export function assembleTodayPlan(input: AssemblePlanInput): AssemblePlanResult {
  const validated = validateScope(input.scope ?? defaultScope());
  if (!validated.ok) {
    // 范围不合法是**配置/代码问题**，不是数据问题，所以要报出来而不是静默给个空计划
    return {
      ok: false,
      code: "INVALID_SCOPE",
      message: `范围不合法：${validated.issues.join("；")}`,
    };
  }

  const resolved = resolveScope(validated.scope, input.snapshot);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.message };
  }

  const merged = mergeProfile({
    profile: input.goalProfile,
    phases: input.goalProfile.phases,
  });
  const mode = chooseMode(merged.pace);
  // 每日词量的**唯一来源**。buildDailyPlan 只吃 daily_cap，
  // 而用户答的是分钟 —— 缺了这一层映射，两个页面就会各自给出不一致的数字。
  const dailyCap = dailyCapFor(input.dailyMinutes, mode, LIMITS.daily_cap);

  const plan = buildDailyPlan({
    words: resolved.words,
    weak_word_ids: [...(input.weakWordIds ?? [])],
    daily_cap: dailyCap,
    pace: merged.pace,
  });

  return {
    ok: true,
    plan,
    merged,
    mode,
    dailyCap,
    scope: validated.scope,
    scopeLabel: scopeLabelOf(validated.scope),
    wordsInScope: resolved.words.length,
    scopeConfidence: resolved.confidence,
  };
}
