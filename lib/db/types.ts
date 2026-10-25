/**
 * 词径记 · 数据表类型定义（阶段 0）
 *
 * 三条硬约束（依据：词径记-阶段0-实施方案-v1.md §5）：
 *   1. 表名与字段名 **snake_case**，与未来 Supabase / Postgres 的表逐字一致
 *      —— 阶段 1 换数据库时只换数据访问实现，业务代码不动。
 *   2. words 表不存放任何课程 / 考试标签，归属一律走 word_placements。
 *   3. word_placements.sense_id 允许为空，但字段必须存在（否则后期无法演进到"按义项背"）。
 */
// `ClozeBlank` 是完形填空的题目结构（纯类型 + 纯函数，不碰数据库）。
// 复用它而不是在这里重写一份：两处各写一遍，"选项 4 个"这条约束就有两个说法了。
import type { ClozeBlank } from "@/lib/study/cloze";

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
   * 最后一次改动的时间。
   *
   * 为什么要单独有它：`created_at` 表达不了"改过"。一个人只有一份画像，
   * 两台设备各改一次时，靠 `created_at` 根本判不出谁后写 ——
   * 先建号的那份永远"更旧"，于是**后改的那次改动会被丢掉且不报错**。
   * 同步器拿它做"最后改的算数"的判据（实施方案 §7.3）。
   */
  updated_at: string;
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
  /**
   * 最后一次改动的时间。**可选** —— 阶段 0 存下来的老计划没有这个字段，
   * 读的时候一律回落 `generated_at`（回落口径只允许有一处，在同步器里）。
   *
   * 注意它**不参与**"同一天两份计划谁赢"的判定：那件事按 §7.3 看"**进度谁更靠前**"。
   * 时间新 ≠ 用户实际在做的那份 —— 电脑上刚打开首页顺手续排一份 `pending`，
   * 按时间取就会把手机上做到一半的进度打回原点，用户会以为"我的进度丢了"。
   */
  updated_at?: string;
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

/**
 * 一套完形填空（生成后存本地，下次直接拿来用）。
 *
 * ── 为什么存本地、不存云端公共池 ────────────────────────────
 * 规格书原本设想的是云端公共池（同单元同难度复用，成本不随人数线性上涨）。
 * 这一版按"与例句生成逻辑差不多"的做法先落本地缓存：**同一台设备、同一个单元，
 * 只调一次 AI**。好处是零基础设施改动、断网也能重做；
 * 代价是**每个新用户第一次都要付一次生成成本**。
 *
 * 这个代价是明摆着的，不是没想到：等用户量真的上来，
 * 把这张表搬到 Supabase 做成公共池就行 —— 表结构与字段已经按
 * "可以直接上云"的形状写好了（snake_case、没有本地特有的字段）。
 *
 * ── `content_version` 是干什么的 ────────────────────────────
 * 词库更新后（`seed-data.json` 的内容指纹变了），旧的题可能考着已经不存在的词。
 * 读缓存时比一下指纹，不一致就当作没有缓存、重新出题。
 * 没有这个字段的话，用户会一直看到旧词库时代的题，**而且不会报错**。
 */
export interface ClozeSet {
  /** `cz:<user_id>:<unit_id>` —— 带主人，见 `lib/db/ids.ts` */
  id: string;
  user_id: string;
  /** 单元 id（如 `wys_2024:8A:U1`）。**不是 `unit_code`** —— 那个三册重号 */
  unit_id: string;
  /**
   * 人话的单元名（「外研社版 · 八年级上册 · Unit 1 This is me」）。
   * 存一份快照：从缓存直接打开页面时，不必再去 join units / volumes / curricula 三张表。
   */
  unit_label: string;
  title: string;
  /** 短文原文，空位写成 `{{1}}` … `{{10}}`。存原文而不是拆好的段落，
   *  这样拆题逻辑只有 `lib/study/cloze.ts` 一处，界面与判分用的是同一份 */
  passage: string;
  blanks: ClozeBlank[];
  /**
   * `ai` = 模型写的；`template` = 兜底通用题。
   *
   * ⚠️ **兜底题不会被存进这张表**（见 `clozeRepo.saveCloze`）：
   * 存了之后用户下次来还是这套跟他的单元无关的题，而且会挡住"下次重试"。
   */
  source: "ai" | "template";
  model: string | null;
  /** 生成时的词库内容指纹 */
  content_version: string;
  created_at: string;
}

/**
 * 一个词的**记忆状态**（FSRS 排期状态）—— 用户层，但**不参与云同步**。
 *
 * ── 为什么不上云（这是个刻意的架构决定，别改成同步）────────────
 * 它是 `review_logs` 的**派生值**，不是原始事实：
 *   FSRS 状态 = 把某个词的全部作答记录按时间顺序重放一遍得到的结果。
 * 既然是派生值，就没有"两台设备谁的状态对"这个问题 —— 拿流水重放一遍就有答案。
 *
 * 反过来，如果它也上云，会立刻出现一个**没有正确答案**的冲突：
 *   手机和电脑各自练了同一个词，各自推进了 FSRS 状态。
 *   合并时该取谁的？按时间新的？那另一次的作答就等于白练（FSRS 需要连续的历史）。
 *   按 stability 大的？那是**篡改算法输入**，会得到一个算法从没算过的卡片。
 * 所以：**真相源只有 `review_logs` 一个，状态表是本机的缓存，可以随时丢弃重建。**
 *
 * 代价是换设备后要重放一遍流水（几千条、几十毫秒），换来的是永远不会出现
 * "状态和流水对不上"这种无解的数据问题。
 *
 * ── 为什么字段名是 snake_case 且不用 ts-fsrs 的类型 ─────────────
 * ① 与全库其它表一致（将来真要同步，字段名不用改）；
 * ② 数据层不依赖算法库 —— 换调度算法（FSRS-5 → FSRS-6）只改 `lib/study/fsrs.ts` 的映射，
 *    表结构与这里一行不用动。
 *
 * ── 日期一律存 ISO 字符串（UTC，定长 24 字符）─────────────────
 * 定长的 ISO 串**字典序等于时间序**，所以 Dexie 可以直接用字符串索引按 `due` 排序。
 * 存 `number` 也行，但存字符串在数据库里能直接看懂是哪天。
 * ⚠️ 必须统一用 `toISOString()`；混进一个本地时区的串（如 `2026-10-24 22:00`）
 * 排序就会错，而且**不会报错**。
 */
export type MemoryState = "new" | "learning" | "review" | "relearning";

export interface WordMemory {
  /** `st:<user_id>:<word_id>` —— 带主人，见 `lib/db/ids.ts` */
  id: string;
  user_id: string;
  word_id: string;
  /** 下次该复习的时间。`due <= now` 就是"到期了" */
  due: string;
  /** 记忆稳定度（天）。越大 = 忘得越慢 */
  stability: number;
  /** 这个词对这个人有多难（约 1~10）。**每个词各自算，不是全局值** */
  difficulty: number;
  /** 上一次复习时距再上一次的天数（FSRS 的输入之一） */
  elapsed_days: number;
  /** 上一次给出的间隔（天） */
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: MemoryState;
  /** 第一次学习时为空 */
  last_review: string | null;
  /** 学习步骤走到第几步。FSRS 的 learning / relearning 阶段要用 */
  learning_steps: number;
  updated_at: string;
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
