/**
 * 今日进度 —— 纯逻辑层
 *
 * 小词（左下角悬浮球）外圈那道进度环读的就是这里算出来的数。
 *
 * ── 为什么要单独成一个文件 ─────────────────────────────────────
 * "今天做了多少"有两个来源：
 *   · 任务的**总量** —— 由 buildDailyPlan 排出来（首页在用）
 *   · **已完成数** —— 从 review_logs 数出来
 * 这两处如果各算各的，迟早会对不上（首页说 20 个，球说 18 个）。
 * 所以把"数已完成"收成一个纯函数，**首页与小词共用同一处**。
 *
 * ── 为什么按"本地日"而不是 UTC ────────────────────────────────
 * 用户说的"今天"是他手表上的今天。若按 UTC 算，东八区晚上 8 点之后
 * 就成"明天"了 —— 进度环会在睡前突然清零。所以只用本地时区取日期，
 * **不用 toISOString()**（那个是 UTC）。
 */

/** 只取用得上的两个字段，避免为了测试去造一整个 ReviewLog */
export interface ReviewLogLike {
  word_id: string;
  created_at: string;
}

/** "2026-09-19"。本地时区 */
export function localDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 今天一共练过多少个**不同的**词。
 *
 * 为什么去重：同一个词一晚上可能被练三遍（第一遍忘了，后面又冒出来），
 * 那也只算"完成了 1 个词"。不去重的话，进度会窜过 100%。
 */
export function countDoneToday(logs: readonly ReviewLogLike[], now: Date): number {
  return doneWordIdsToday(logs, now).size;
}

/**
 * 今天练过的词 id 集合 —— 上面那个计数与下面的"任务单内计数"共用它，
 * **全项目只有这一处按本地日界筛 log 的逻辑**。
 */
export function doneWordIdsToday(logs: readonly ReviewLogLike[], now: Date): Set<string> {
  const today = localDayKey(now);
  const seen = new Set<string>();
  for (const log of logs) {
    const at = new Date(log.created_at);
    // 坏掉的时间戳直接跳过：一条脏数据不该把整个进度拖垮
    if (Number.isNaN(at.getTime())) continue;
    if (localDayKey(at) !== today) continue;
    seen.add(log.word_id);
  }
  return seen;
}

/**
 * 今日进度（首页与学习页**共用这一个口径**）。
 *
 * 定义：今天练过的词中，**属于今天任务单**的那部分有几个。
 *
 * 两个页面必须用同一个函数，否则会出现最伤信任的那类 bug：
 * 学完 20 个词回到首页，环显示 18/20。两处口径只要各自算一遍，迟早会飘 ——
 * 所以"哪些算练过""分母是多少"这两件事都只在这一个文件里定义。
 *
 * 分母恒为**今天任务单的长度**，不是"范围里有多少词"（那是几十上百个），
 * 也不是"范围内已练的词数"（那会让分母随着练习变动，环永远不满）。
 */
export function countDoneInPlan(
  logs: readonly ReviewLogLike[],
  planWordIds: readonly string[],
  now: Date,
): number {
  if (planWordIds.length === 0) return 0;
  const plan = new Set(planWordIds);
  const done = doneWordIdsToday(logs, now);
  let n = 0;
  for (const id of done) if (plan.has(id)) n += 1;
  return n;
}

/** 0~1。总量为 0 时返回 0（而不是 NaN / Infinity） */
export function progressRatio(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(done / total, 0), 1);
}
