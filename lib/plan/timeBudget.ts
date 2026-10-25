/**
 * 时长挡位 —— 「这次有多少时间」→「今天练多少个词」
 *
 * ── 为什么单独一层，而不是在页面里写 if ────────────────────────
 * 分钟数不只首页用：引导结果页拿 `profile.daily_minutes` 讲"以后每天多少"，
 * 学习页在没有当天任务单时要自己排一份。三处一旦各写一套换算，就会出现
 * "首页说 12 个词、学习页给 24 个"这种最伤信任的不一致。
 *
 * 所以本文件**只回答一个问题：用户这次选了多少分钟**。
 * "多少分钟 → 多少个词"由 `assembleTodayPlan → dailyCapFor` 一处负责，不在这里重算。
 *
 * ── 铁律 ──────────────────────────────────────────────────
 * **纯函数：不读时钟、不读存储、不写存储。**
 * `nowHour` 由调用方给 —— 自己取时间就没法单测（同一个用例在 9 点和 22 点结论不同）。
 * 落盘与读盘在 `timeBudgetStore.ts`。
 *
 * ── 为什么是「这次」而不是「每天」────────────────────────────
 * 同一个人，早上出门前有 3 分钟、晚上有 20 分钟。做成一个全局设置，
 * 他要么每天被过多的词压垮，要么每天只练 3 分钟。所以默认值按"上次选的"给，
 * 且**随时可在首页一指点掉** —— 不做弹窗、不做拦截页。
 */

/** 四个预设挡位（分钟）。改动这里 = 改界面上的按钮数量，别处不用动 */
export const BUDGET_TIER_MINUTES = [3, 5, 10, 20] as const;

/** 自定义时长的合法区间 */
export const CUSTOM_MINUTE_MIN = 1;
export const CUSTOM_MINUTE_MAX = 60;

/** 脏数据兜底时用的分钟数：取引导里最常见的那一档，不是最低档 */
const FALLBACK_MINUTES = 10;

/**
 * 把任意输入收成合法分钟数。
 * 非数字 → 10（**不是 1**：把用户按在最低档，他会以为软件坏了）。
 */
export function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return FALLBACK_MINUTES;
  return Math.min(Math.max(Math.round(value), CUSTOM_MINUTE_MIN), CUSTOM_MINUTE_MAX);
}

/** 这个分钟数正好等于某个预设挡位吗（界面据此高亮） */
export function isTierMinutes(minutes: number): boolean {
  return (BUDGET_TIER_MINUTES as readonly number[]).includes(minutes);
}

/**
 * 归到最接近的预设挡位。距离相同时取**更小**那个 ——
 * 少给几个词顶多让用户觉得没练够（他会自己点大一档），
 * 多给几个词会让他练到一半退出。
 */
export function nearestTier(minutes: number): number {
  const target = Number.isFinite(minutes) && minutes > 0 ? minutes : FALLBACK_MINUTES;
  // 显式标 number：`BUDGET_TIER_MINUTES[0]` 在这里会被推成字面量 3，后面赋 5 就报错
  let best: number = BUDGET_TIER_MINUTES[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const tier of BUDGET_TIER_MINUTES) {
    const gap = Math.abs(tier - target);
    if (gap < bestGap) {
      best = tier;
      bestGap = gap;
    }
  }
  return best;
}

export interface SuggestInput {
  /** 上次选的分钟数；null = 从没选过 */
  lastUsed: number | null;
  /** 引导里答的"每天多少分钟" */
  profileMinutes: number;
}

/**
 * 默认该给多少分钟。**永不阻塞**：算出来的值直接用来排课，不问、不等确认。
 *
 * 优先级只有两级：
 *   ① 上次选的 —— 尊重用户的习惯，不因为换了时段就偷偷改掉他的设置
 *   ② 从没选过 → 用他自己在引导里答的"每天多少分钟"，落到最近的挡位
 *
 * ── 为什么**没有**"按时段推断"（这条是想过之后否掉的）────────────
 * 原本打算 21 点后给 3 分钟、上学前给 5 分钟。听上去体贴，但它会和
 * **引导结果页**当场打架：用户刚答完"每天 10 分钟"、看到"24 个词"，
 * 三秒后落到首页却是"12 个词" —— 他会认为这软件算错了。
 *
 * 而且这个推断只在"从没选过"那一次生效，代价高、收益低。
 * 想少练一点，挡位条就在主卡上，一指点掉，比替他猜准得多。
 */
export function suggestMinutes({ lastUsed, profileMinutes }: SuggestInput): number {
  if (lastUsed !== null && Number.isFinite(lastUsed) && lastUsed > 0) {
    return clampMinutes(lastUsed);
  }
  return nearestTier(profileMinutes);
}

/**
 * 解析 localStorage 里的原始字符串。
 *
 * 单独抽成纯函数的原因：**读盘失败的兜底逻辑恰恰是最容易写错、
 * 又最难在页面上发现的部分**。隐私模式下 localStorage 会抛异常，
 * 旧版本可能存过别的形状 —— 这些都必须"退回没选过"，而不是把整页搞崩。
 *
 * 认的形状：`{"minutes": 12}`。缺字段、非数字、≤0 一律当"没选过"。
 */
export function parseStoredBudget(raw: string | null): number | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const minutes = (parsed as { minutes?: unknown }).minutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  return clampMinutes(minutes);
}

/** 落盘形状。与 `parseStoredBudget` 必须成对改 —— 一边改一边不改 = 用户设置静默丢失 */
export function serializeBudget(minutes: number): string {
  return JSON.stringify({ minutes: clampMinutes(minutes) });
}

/** 界面上的一句话叫法 */
export function budgetLabel(minutes: number): string {
  return `${minutes} 分钟`;
}
