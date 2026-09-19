/**
 * 用时估算参数
 *
 * 注意：这些是**估算参数，不是事实**，也不属于 goal_profiles.pace 的白名单字段
 * （pace 只允许放 new_ratio / session_size / spelling_required / speed_drill / review_priority）。
 * 要调整只用改这一个文件。
 */
export const SECONDS_PER_ITEM: Record<string, number> = {
  recognize: 12,
  recall_spell: 25,
  listening: 15,
  cloze: 20,
};

export const DEFAULT_SECONDS_PER_ITEM = 18;

export function secondsForMode(mode: string): number {
  return SECONDS_PER_ITEM[mode] ?? DEFAULT_SECONDS_PER_ITEM;
}

/**
 * 「每天愿意花多久」→「每天几个词」。
 *
 * 为什么必须有这个函数：`buildDailyPlan` 只吃 `daily_cap`，
 * 而用户在引导里答的是**分钟数**。中间缺一层映射的话，
 * 两处就会各自给出不一致的数字（结果页说 36 个、首页显示 20 个）——
 * 这是用户最容易发现、也最伤信任的那类 bug。
 *
 * **唯一来源**：结果页与首页都必须调它，不要在页面里另写一份。
 *
 * `hardCap` 是安全阀（LIMITS.daily_cap）：防止有人填 600 分钟就把整本书塞进一天。
 */
export function dailyCapFor(minutes: number, mode: string, hardCap: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 1;
  const byTime = Math.floor((minutes * 60) / secondsForMode(mode));
  return Math.max(1, Math.min(byTime, hardCap));
}
