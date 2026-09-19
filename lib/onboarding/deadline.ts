/**
 * 考试期限：选项生成与剩余天数
 *
 * 铁律：**纯函数，`today` 必须由调用方传入，不在内部读时钟** ——
 * 内部读 `new Date()` 的函数没法单测，也没法复现跨年的边界。
 *
 * 诚实边界（重要）：中考的具体日期**每个城市、每一年都不一样**（天津一般在 6 月中下旬，
 * 但会有浮动）。所以这里只取一个代表性日期用于**估算**，
 * 界面文案一律写「大概还有」，**不写精确天数**，也不假装知道准确考期。
 */

/** 中考在 6 月 */
export const EXAM_MONTH = 6;
/** 代表性日期（不是任何城市的真实考期，只用于估算） */
export const EXAM_DAY = 20;

export interface DeadlineOption {
  /** ISO 日期 `YYYY-MM-DD`；null = 还没确定 */
  value: string | null;
  label: string;
  hint: string;
}

/** 下一次中考在哪一年：过了 6 月就顺延一年 */
export function nextExamYear(today: Date): number {
  return today.getMonth() + 1 > EXAM_MONTH ? today.getFullYear() + 1 : today.getFullYear();
}

/**
 * 距目标日期还有几天。按**本地日期的年月日**算，与时分秒、时区无关。
 * 传入非法日期返回 NaN（调用方负责显示"未设置"，不要显示 NaN）。
 */
export function daysUntil(iso: string, today: Date): number {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
  const [y, m, d] = parts;
  const target = Date.UTC(y, m - 1, d);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86_400_000);
}

/** 剩余天数 → 人话。**不说精确天数**，因为考期本来就是估的。 */
export function describeRemaining(days: number): string {
  if (!Number.isFinite(days)) return "";
  if (days < 0) return "已经过了";
  if (days === 0) return "就是今天";
  if (days < 60) return `大概还有 ${days} 天`;
  const months = Math.round(days / 30);
  if (months <= 24) return `大概还有 ${months} 个月`;
  return `大概还有 ${Math.round(days / 365)} 年`;
}

/**
 * 第一题的期限选项。
 * 生成而非写死：中考每年 6 月，写死年份明年就过期了。
 */
export function deadlineOptions(today: Date): DeadlineOption[] {
  const base = nextExamYear(today);
  const options: DeadlineOption[] = [];

  for (let i = 0; i < 3; i++) {
    const year = base + i;
    const value = `${year}-06-${String(EXAM_DAY).padStart(2, "0")}`;
    const days = daysUntil(value, today);
    options.push({
      value,
      label: `${year} 年 6 月`,
      hint: i === 0 ? `最近的一次 · ${describeRemaining(days)}` : describeRemaining(days),
    });
  }

  options.push({
    value: null,
    label: "还没确定",
    hint: "先按最近的一次中考来安排",
  });

  return options;
}

/**
 * 「预计 X 天过一遍」——把词数摊到每天的词量上。
 * 向上取整：宁可多算一天，也不说"3 天能背完 61 个词"这种做不到的话。
 */
export function daysToCover(totalWords: number, perDay: number): number {
  if (totalWords <= 0) return 0;
  if (perDay <= 0) return NaN;
  return Math.ceil(totalWords / perDay);
}
