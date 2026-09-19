/**
 * 冷启动引导的题目数据
 *
 * 铁律：**这是数据，不是代码**（与 goal_profiles 同思路）。
 * 新增一个兴趣域 = 往数组里加一行，页面逻辑一行不用改。
 *
 * interests 的 tag 存**英文**：它是稳定标识符，会进入 AI 提示词，
 * 也是 user_examples 的唯一键 (word_id, interest_tag) 的一半；
 * 中文只用于界面展示（interestLabel 负责翻译）。
 */

export interface GoalOption {
  code: string;
  label: string;
  hint: string;
  /** 阶段 0 只收录中考。false = 选了必须如实说"暂未收录"，不假装支持 */
  supported: boolean;
}

export const GOAL_OPTIONS: GoalOption[] = [
  { code: "zhongkao", label: "中考", hint: "初三下学期的升学考试", supported: true },
  { code: "gaokao", label: "高考", hint: "高中阶段的升学考试", supported: false },
  { code: "cet4", label: "大学四级", hint: "大学英语四级考试", supported: false },
  { code: "undecided", label: "还没想好", hint: "先按中考方案安排", supported: false },
];

/** 选了未收录目标时的原话。如实说，不含糊，也不拦着用户往下走。 */
export const UNSUPPORTED_GOAL_NOTE =
  "这个目标我们还没收录。先按中考的方案给你安排 —— 等你要用的时候，我们再把它补上。";

export interface MinuteOption {
  value: number;
  label: string;
  hint: string;
}

export const MINUTE_OPTIONS: MinuteOption[] = [
  { value: 10, label: "10 分钟", hint: "时间紧，能挤一点是一点" },
  { value: 15, label: "15 分钟", hint: "差不多刚好" },
  { value: 20, label: "20 分钟", hint: "能稳定拿出来" },
  { value: 30, label: "30 分钟以上", hint: "想快点补上来" },
];

export interface InterestOption {
  /** 英文 tag：存库 + 进 AI 提示词，稳定标识符 */
  tag: string;
  /** 界面展示用（中文） */
  label: string;
  /**
   * 提示词与兜底模板用（英文）。
   * 为什么中文不够：例句是**英文句子**，让模型把"篮球 / 足球"翻译成英文场景
   * 会引入一个没必要的转换步骤（也容易写成 basketball-or-football 那种别扭说法）。
   * 另外兜底模板句是拼出来的英文句子，中文标签根本塞不进去。
   */
  label_en: string;
}

export const INTEREST_OPTIONS: InterestOption[] = [
  { tag: "basketball", label: "篮球 / 足球", label_en: "basketball and football" },
  { tag: "music", label: "音乐", label_en: "music" },
  { tag: "movies", label: "电影 / 剧集", label_en: "movies and TV shows" },
  { tag: "gaming", label: "电子游戏", label_en: "video games" },
  { tag: "food", label: "美食", label_en: "food" },
  { tag: "travel", label: "旅行", label_en: "travel" },
  { tag: "anime", label: "动漫", label_en: "anime" },
  { tag: "reading", label: "读书", label_en: "reading" },
  { tag: "tech", label: "科技 / 编程", label_en: "technology and coding" },
  { tag: "pets", label: "宠物", label_en: "pets" },
];

/**
 * 「一个兴趣都没选」时用的兜底话题。
 *
 * 为什么不干脆不调 AI：**例句是学习页的固定环节**，缺了它这一屏就是空的。
 * 所以给它一个中性话题，并在界面上如实标注"还没选兴趣，先用日常话题"，
 * 引导用户去补选 —— 这比空着更有用。
 *
 * tag 取 `general`：它同样进 `user_examples` 的键，
 * 用户后来补选了兴趣，会生成新的一条（旧的不会顶掉，因为键不同）。
 */
export const GENERIC_INTEREST_TAG = "general";
export const GENERIC_INTEREST_LABEL = "日常话题";
export const GENERIC_INTEREST_LABEL_EN = "everyday life";

/**
 * 最多选几个。
 * 定 3 是产品判断：例句一次只结合一个兴趣域才自然，
 * 选太多等于把"量身定制"稀释成"泛泛而谈"。界面要把这句话讲给用户听。
 */
export const MAX_INTERESTS = 3;

/** tag → 中文名。查不到就原样返回，不抛异常（旧数据里可能有已下线的 tag）。 */
export function interestLabel(tag: string): string {
  if (tag === GENERIC_INTEREST_TAG) return GENERIC_INTEREST_LABEL;
  return INTEREST_OPTIONS.find((o) => o.tag === tag)?.label ?? tag;
}

/**
 * tag → 英文名，给提示词与兜底模板用。
 * 查不到就**回落兜底话题的英文名**而不是原样返回 ——
 * 因为下游是"拼一句英文"，塞一个未知 tag（可能是中文）进去会拼出坏句子。
 * 中文界面那一路（interestLabel）可以原样返回，英文这一路不行，这是两者的关键差别。
 */
export function interestLabelEn(tag: string): string {
  if (tag === GENERIC_INTEREST_TAG) return GENERIC_INTEREST_LABEL_EN;
  return INTEREST_OPTIONS.find((o) => o.tag === tag)?.label_en ?? GENERIC_INTEREST_LABEL_EN;
}

/**
 * code → 目标选项。查不到返回 null（旧数据里可能有已下线的目标，不抛异常）。
 *
 * 为什么要有这一层：首页、问答页、结果页都要「按 goal 找选项」，
 * 各自写一遍 `GOAL_OPTIONS.find(...)` 就是三个真值来源 —— 改一处必漏两处。
 */
export function findGoal(code: string | null | undefined): GoalOption | null {
  if (!code) return null;
  return GOAL_OPTIONS.find((o) => o.code === code) ?? null;
}

/**
 * 这个目标有没有已收录的方案。
 * false 的含义是「必须如实告诉用户暂未收录」，**不是**「不许往下走」。
 */
export function isGoalSupported(code: string | null | undefined): boolean {
  return findGoal(code)?.supported === true;
}
