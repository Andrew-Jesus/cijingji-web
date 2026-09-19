/**
 * 词径记 · 数据表类型定义（阶段 0）
 *
 * 三条硬约束（依据：词径记-阶段0-实施方案-v1.md §5）：
 *   1. 表名与字段名 **snake_case**，与未来 Supabase / Postgres 的表逐字一致
 *      —— 阶段 1 换数据库时只换数据访问实现，业务代码不动。
 *   2. words 表不存放任何课程 / 考试标签，归属一律走 word_placements。
 *   3. word_placements.sense_id 允许为空，但字段必须存在（否则后期无法演进到"按义项背"）。
 */

// ---------------------------------------------------------------- 内容层（共享只读）

export type CurriculumKind = "textbook" | "exam";
export type CurriculumStatus = "active" | "legacy";

/** 课程体系。edition_year 是关键字段：'人教版八上'在新旧版是两个不同数据集。 */
export interface Curriculum {
  id: string;
  code: string;
  kind: CurriculumKind;
  publisher: string;
  edition_year: number;
  display_name: string;
  region_hint: string[];
  status: CurriculumStatus;
}

export interface Volume {
  id: string;
  curriculum_id: string;
  grade_label: string;
  grade_num: number;
  term: "上" | "下" | "全";
  word_count: number;
  status: CurriculumStatus;
}

export interface Unit {
  id: string;
  volume_id: string;
  unit_no: number;
  unit_code: string;
  title_en: string;
  title_zh: string | null;
  theme_tags: string[];
  sort_order: number;
  is_verified: boolean;
}

/** 词条本体。注意：这里没有、也不允许有 curriculum / exam 字段。 */
export interface Word {
  id: string;
  lemma: string;
  lemma_normalized: string;
  phonetic_uk: string | null;
  phonetic_us: string | null;
  freq_rank: number | null;
}

/** 义项。按单元背词的精度上限就是义项，所以必须独立成表。 */
export interface Sense {
  id: string;
  word_id: string;
  pos: string | null;
  cn_meaning: string;
  is_primary: boolean;
}

export type PlacementRole = "new" | "review" | "extension";

/** 归属层 —— 本项目的核心自建资产。 */
export interface WordPlacement {
  id: string;
  word_id: string;
  unit_id: string;
  /** 该单元只考某个义项时填；阶段 0 允许为空 */
  sense_id: string | null;
  role: PlacementRole;
  /** 是否教材黑体词。null = 未知（阶段 0 判定不可信时宁可留 null，不猜 false） */
  is_core: boolean | null;
  occurrence_no: number;
  first_volume_id: string | null;
  source: string;
  /** 0~1，驱动界面的诚实提示：低于 0.8 必须标注"可能不准" */
  confidence: number;
  is_verified: boolean;
}

/** 策略包 —— 是数据不是代码。新增学习目标 = 插一行配置。 */
export interface GoalProfile {
  id: string;
  goal_code: string;
  version: number;
  channel_weights: Record<string, number>;
  sense_policy: string;
  context_sources: string[];
  networks: Record<string, number>;
  pace: Pace;
  phases: Record<string, Partial<ProfileOverridable>>;
  /** 一句话向用户解释"为什么这样练"，直接呈现在界面上。手写，不由 AI 生成。 */
  user_facing_summary: string;
}

export interface Pace {
  new_ratio: number;
  session_size: number;
  spelling_required: boolean;
  speed_drill: boolean;
  review_priority: string;
}

/** phase 只允许覆盖白名单字段（见 lib/profile/mergeProfile.ts） */
export interface ProfileOverridable {
  channel_weights: Record<string, number>;
  sense_policy: string;
  context_sources: string[];
  networks: Record<string, number>;
  pace: Partial<Pace>;
}

// ---------------------------------------------------------------- 用户层（一人一份）

export interface Profile {
  id: string;
  nickname: string | null;
  study_code: string | null;
  goal: string;
  goal_deadline: string | null;
  daily_minutes: number;
  /** 兴趣领域 —— 个性化例句的唯一依据 */
  interests: string[];
  level_self_report: number | null;
  theme: string | null;
  timezone: string;
  created_at: string;
  /**
   * 完成冷启动引导的时间；null = 还没走完引导。
   * 界面据它决定是否跳转 /onboarding —— **不靠 level_self_report 之类的字段去猜**，
   * 猜出来的状态机迟早会在某个边界上出错。
   */
  onboarding_completed_at: string | null;
}

export type PlanStatus = "pending" | "in_progress" | "done" | "skipped";

export interface DailyPlanItem {
  word_id: string;
  sense_id: string | null;
  mode: string;
  priority_score: number;
  /**
   * 以下是**渲染快照**，可选。
   *
   * 为什么要把内容层的字段抄一份进计划里：**计划是历史记录**。
   * 明天词库更新了、某个词的义项改了、单元归属调整了 ——
   * 昨天那张任务单在历史里应该还是昨天那个样子，而不是被追改。
   * 另外学习页要一次拿到"词头 + 释义 + 单元"，有快照就不用为了渲染再查三张表。
   *
   * 注意边界：这**不是**把课程标签冗余进 `words`（那是被硬约束禁止的）。
   * 这里冗余的是"当天排的那份单子长什么样"，它属于计划这一层。
   */
  lemma?: string;
  meaning_zh?: string | null;
  unit_code?: string;
  confidence?: number;
}

export interface DailyPlan {
  id: string;
  user_id: string;
  plan_date: string;
  status: PlanStatus;
  items: DailyPlanItem[];
  brief: string | null;
  estimated_minutes: number;
  generated_at: string;
}

/** 这张表决定归因能有多准 —— 只记对错是浪费。 */
export interface ReviewLog {
  id: string;
  user_id: string;
  word_id: string;
  session_id: string;
  mode: string;
  is_correct: boolean;
  latency_ms: number;
  hesitation_count: number;
  error_type: string | null;
  rating: number | null;
  created_at: string;
}

export interface UserExample {
  id: string;
  user_id: string;
  word_id: string;
  sentence: string;
  gloss: string;
  interest_tag: string;
  is_ai_generated: boolean;
}

export interface AiUsage {
  id: string;
  user_id: string | null;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** 缓存命中 tokens 必须单独记 —— 缓存命中率是省钱设计的验收指标 */
  cached_tokens: number;
  cost_cny: number;
  /**
   * 这笔账到底有没有价。
   *
   * 为什么必须有这个字段：价格表里查不到模型时，`cost_cny` 只能是 0，
   * 但**那个 0 的含义是"不知道"而不是"免费"**。没有这个字段，
   * 汇总时就会把"没计价"算成"白嫖"，账单会看起来比实际便宜 ——
   * 记账一旦开始骗人，整套记账就没有意义了。
   */
  priced: boolean;
  /** 计价时是否高峰时段。DeepSeek 高峰价是空闲价的 2 倍，不记就解释不了"为什么这次贵" */
  peak: boolean;
  latency_ms: number;
  ok: boolean;
  created_at: string;
}
