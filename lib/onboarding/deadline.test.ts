import { describe, expect, it } from "vitest";

import {
  daysToCover,
  daysUntil,
  deadlineOptions,
  describeRemaining,
  nextExamYear,
} from "@/lib/onboarding/deadline";

/** 统一用本地日期构造，避免测试跟着机器时区飘 */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("nextExamYear", () => {
  it("9 月（考期已过）→ 顺延到明年", () => {
    expect(nextExamYear(d(2026, 9, 18))).toBe(2027);
  });

  it("3 月（考期未到）→ 就是今年", () => {
    expect(nextExamYear(d(2026, 3, 1))).toBe(2026);
  });

  it("6 月内 → 仍算今年", () => {
    expect(nextExamYear(d(2026, 6, 10))).toBe(2026);
  });

  it("7 月 1 日 → 顺延（边界不含 7 月）", () => {
    expect(nextExamYear(d(2026, 7, 1))).toBe(2027);
  });

  it("元旦 → 当年", () => {
    expect(nextExamYear(d(2027, 1, 1))).toBe(2027);
  });
});

describe("daysUntil", () => {
  it("同一天 → 0", () => {
    expect(daysUntil("2026-09-18", d(2026, 9, 18))).toBe(0);
  });

  it("第二天 → 1", () => {
    expect(daysUntil("2026-09-19", d(2026, 9, 18))).toBe(1);
  });

  it("跨年算得对", () => {
    expect(daysUntil("2027-01-01", d(2026, 12, 31))).toBe(1);
  });

  it("跨闰年 2 月算得对（2028 是闰年）", () => {
    expect(daysUntil("2028-03-01", d(2028, 2, 28))).toBe(2);
    expect(daysUntil("2027-03-01", d(2027, 2, 28))).toBe(1);
  });

  it("已经过去的日期 → 负数", () => {
    expect(daysUntil("2026-09-17", d(2026, 9, 18))).toBe(-1);
  });

  it("时分秒不影响结果（按年月日算）", () => {
    const late = new Date(2026, 8, 18, 23, 59, 59);
    expect(daysUntil("2026-09-19", late)).toBe(1);
  });

  it("非法日期 → NaN（不抛异常，也不返回 0 这种会被当成「真的还有 0 天」的值）", () => {
    expect(Number.isNaN(daysUntil("", d(2026, 9, 18)))).toBe(true);
    expect(Number.isNaN(daysUntil("not-a-date", d(2026, 9, 18)))).toBe(true);
  });
});

describe("describeRemaining", () => {
  it("不足 60 天 → 报天数", () => {
    expect(describeRemaining(45)).toBe("大概还有 45 天");
  });

  it("60 天以上 → 报月数（不说精确天数，因为考期本来就是估的）", () => {
    expect(describeRemaining(275)).toBe("大概还有 9 个月");
  });

  it("超过两年 → 报年数", () => {
    expect(describeRemaining(1000)).toBe("大概还有 3 年");
  });

  it("已过期 / 当天 / NaN 都有话说，不显示空白或 NaN", () => {
    expect(describeRemaining(-1)).toBe("已经过了");
    expect(describeRemaining(0)).toBe("就是今天");
    expect(describeRemaining(NaN)).toBe("");
  });
});

describe("deadlineOptions", () => {
  const opts = deadlineOptions(d(2026, 9, 18));

  it("4 个选项：近三年 + 还没确定", () => {
    expect(opts).toHaveLength(4);
    expect(opts[3].value).toBeNull();
  });

  it("第一个是最近的一次中考（2027 年 6 月）", () => {
    expect(opts[0].value).toBe("2027-06-20");
    expect(opts[0].label).toBe("2027 年 6 月");
  });

  it("三个日期选项年份递增且去重", () => {
    const years = opts.slice(0, 3).map((o) => o.value!.slice(0, 4));
    expect(years).toEqual(["2027", "2028", "2029"]);
    expect(new Set(years).size).toBe(3);
  });

  it("每个选项都有给人看的提示文案", () => {
    for (const o of opts) expect(o.hint.length).toBeGreaterThan(0);
  });

  it("换一年生成结果跟着变（不是写死的）", () => {
    const later = deadlineOptions(d(2030, 9, 18));
    expect(later[0].value).toBe("2031-06-20");
  });
});

describe("daysToCover", () => {
  it("向上取整：53 词 / 每天 20 → 3 天", () => {
    expect(daysToCover(53, 20)).toBe(3);
  });

  it("刚好整除不多算一天", () => {
    expect(daysToCover(40, 20)).toBe(2);
  });

  it("少于一天也算一天", () => {
    expect(daysToCover(1, 20)).toBe(1);
  });

  it("词数为 0 → 0 天（不是 1 天）", () => {
    expect(daysToCover(0, 20)).toBe(0);
  });

  it("每天 0 词 → NaN（界面应显示「未设置」，不能显示 Infinity）", () => {
    expect(Number.isNaN(daysToCover(53, 0))).toBe(true);
  });
});
