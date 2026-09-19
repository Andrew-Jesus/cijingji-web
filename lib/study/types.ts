/**
 * 学习会话的共享类型 —— 只放类型，不放逻辑
 *
 * 单独开一个文件是为了**避免循环引用**：
 * cards / grade / rating / session 互相都要用到这几个类型，
 * 谁 import 谁都会绕回去。类型集中在最底层，逻辑层只依赖它。
 */

/**
 * 卡片模板。与 `goal_profiles.pace.spelling_required` 挂钩：
 *   - `recognize`    看英选中 —— 只要求"认得出"
 *   - `recall_spell` 中译英   —— 要求"写得出"
 *
 * 两个模板的**卡片内容与模板本身分离**：同一个词换模板不算新词，
 * 这是以后做"通道权重"（applyProfile）的前提。阶段 0 只用这两个。
 */
export type StudyMode = "recognize" | "recall_spell";

/** 一道题的作答。两种题型两种形态，用 tag 区分，判分时不必猜 */
export type StudyAnswer =
  | { kind: "index"; value: number }
  | { kind: "text"; value: string };

/**
 * 错因。**由题型 + 对错推导，不靠模型猜。**
 *   - `meaning`   看英选中的意思选错了 —— 释义记混了
 *   - `spelling`  中译英拼错了 —— 记住了词但写不对
 *   - `confusion` 中译英拼成了**词库里另一个真实的词** —— 这是"两个词混了"，比拼错严重
 *
 * 为什么 `confusion` 要单独存在：它和 `spelling` 的补救方式完全不同
 * （拼错要练拼写，弄混要拉词对做对比）。只记"错了"是浪费这张表。
 */
export type ErrorType = "meaning" | "spelling" | "confusion";

export interface GradeResult {
  is_correct: boolean;
  /** 答对时为 null —— 没有错因可言 */
  error_type: ErrorType | null;
}

/**
 * 三级反馈。**数值直接写进 `review_logs.rating`**，与 FSRS 的 1/2/3/4 体系对齐
 * （阶段 0 只用到 1/2/3，4 = Easy 先不开放：起步阶段多一个"太简单"只会分散注意力）。
 *
 *   1 = Again（没想起来）
 *   2 = Hard（想起来了，但费劲）
 *   3 = Good（顺利想起来了）
 */
export type Rating = 1 | 2 | 3;

/** 做题过程中逐步收集的原始事实 —— 判分与记账都从这里取，避免页面里散着算 */
export interface StudyCard {
  word_id: string;
  mode: StudyMode;
  lemma: string;
  phonetic_uk: string | null;
  pos: string | null;
  meaning_zh: string | null;
  unit_code: string;
  confidence: number;
  /** `recognize` 才有：4 条中文释义（已打乱） */
  options?: string[];
  /** `recognize` 才有：正确选项下标。**作答前界面不得读取它** */
  answer_index?: number;
  /** `recall_spell` 才有：可接受的写法（原形 + 归一形） */
  answers?: string[];
}

/** 一次作答的完整记录（页面收齐后交给 studyRepo 落库） */
export interface ReviewRecord {
  word_id: string;
  session_id: string;
  mode: StudyMode;
  is_correct: boolean;
  latency_ms: number;
  hesitation_count: number;
  error_type: ErrorType | null;
  rating: Rating;
}

/** 页内终态要展示的东西 */
export interface StudySummary {
  total: number;
  correct: number;
  incorrect: number;
  /** 最后一个词的出场顺序 → lemma，用来列"今天卡住的词" */
  stuck: { word_id: string; lemma: string; times: number }[];
  elapsed_ms: number;
  /**
   * 一共做了多少次作答（含 Again 重复的那几遍）。
   * 与 `total` 不一样 —— 后者是"今天有几个词"，这个是"一共点了几下"。
   */
  attempts: number;
}
