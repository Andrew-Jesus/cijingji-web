/**
 * mergeProfile —— 三层优先级合并
 *
 * 固定优先级（必须写死并单测覆盖）：
 *     overrides（用户手动）  >  phases[phase]（阶段覆盖）  >  goal_profile（目标默认）
 *
 * 铁律：**纯函数，无 AI，无副作用，可单测。**
 * 约束：phase 只允许覆盖**白名单字段**，不得任意扩展 schema
 *      —— 否则配置会退化成"每个阶段一套 schema"，等于没抽象。
 */
import type { Pace, ProfileOverridable, GoalProfile } from "@/lib/db/types";

/** phase 允许覆盖的字段白名单（上游 多目标学习策略方案 §3.1） */
export const PHASE_OVERRIDABLE_FIELDS = [
  "channel_weights",
  "sense_policy",
  "context_sources",
  "networks",
  "pace",
] as const;

export interface MergeInput {
  /** 目标默认（goal_profiles 那一行） */
  profile: Pick<GoalProfile, "channel_weights" | "sense_policy" | "context_sources" | "networks" | "pace">;
  /** 阶段名，如 foundation / reinforce / sprint */
  phase?: string;
  /** 该目标的 phases 覆盖层 */
  phases?: Record<string, Partial<ProfileOverridable>>;
  /** 用户手动微调，优先级最高 */
  overrides?: Partial<ProfileOverridable>;
}

export interface MergedProfile {
  channel_weights: Record<string, number>;
  sense_policy: string;
  context_sources: string[];
  networks: Record<string, number>;
  pace: Pace;
  /** 记录哪些字段被覆盖了，便于界面解释"为什么这样练" */
  applied_layers: ("phase" | "overrides")[];
}

const DEFAULT_PACE: Pace = {
  new_ratio: 0.5,
  session_size: 20,
  spelling_required: false,
  speed_drill: false,
  review_priority: "weak_first",
};

/** 皮实一点：任何字段缺失都回落默认值，不抛错崩页面 */
export function mergeProfile(input: MergeInput): MergedProfile {
  const { profile, phase, phases, overrides } = input;

  const phaseLayer: Partial<ProfileOverridable> =
    phase && phases ? (phases[phase] ?? {}) : {};

  const applied: ("phase" | "overrides")[] = [];
  if (Object.keys(phaseLayer).length > 0) applied.push("phase");
  if (overrides && Object.keys(overrides).length > 0) applied.push("overrides");

  const pick = <K extends keyof ProfileOverridable>(key: K) => {
    // 顺序即优先级：低的先写，高的覆盖
    return (
      (overrides?.[key] as ProfileOverridable[K] | undefined) ??
      (phaseLayer[key] as ProfileOverridable[K] | undefined) ??
      (profile[key] as ProfileOverridable[K] | undefined)
    );
  };

  const paceMerged: Pace = {
    ...DEFAULT_PACE,
    ...(profile.pace ?? {}),
    ...(phaseLayer.pace ?? {}),
    ...(overrides?.pace ?? {}),
  };

  return {
    channel_weights: pick("channel_weights") ?? {},
    sense_policy: pick("sense_policy") ?? "single",
    context_sources: pick("context_sources") ?? [],
    networks: pick("networks") ?? {},
    pace: paceMerged,
    applied_layers: applied,
  };
}

/** 检查一个 phases 配置有没有越出白名单 —— 配置写错时应在开发期就炸，而不是线上静默失效 */
export function findIllegalPhaseFields(
  phases: Record<string, Record<string, unknown>>,
): string[] {
  const allowed = new Set<string>(PHASE_OVERRIDABLE_FIELDS);
  const illegal: string[] = [];
  for (const [phaseName, layer] of Object.entries(phases)) {
    for (const key of Object.keys(layer)) {
      if (!allowed.has(key)) illegal.push(`${phaseName}.${key}`);
    }
  }
  return illegal;
}
