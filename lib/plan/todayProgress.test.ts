import { describe, expect, it } from "vitest";

import { countDoneInPlan, countDoneToday, doneWordIdsToday, localDayKey, progressRatio } from "./todayProgress";

/**
 * 一律用本地时间构造再转 ISO —— 测试机时区不同也不会飘。
 * 若这里写死 "2026-09-19T01:00:00Z"，在东八区跑就会落到 19 日上午、
 * 在西半球跑就落到 18 日，测试会莫名其妙地红。
 */
function at(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0).toISOString();
}

describe("localDayKey", () => {
  it("补零成 YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 8, 9, 10))).toBe("2026-09-09");
  });

  it("深夜 23:30 仍算当天（按 UTC 就会翻到第二天）", () => {
    expect(localDayKey(new Date(2026, 8, 19, 23, 30))).toBe("2026-09-19");
  });

  it("凌晨 00:10 算新的一天", () => {
    expect(localDayKey(new Date(2026, 8, 20, 0, 10))).toBe("2026-09-20");
  });
});

describe("countDoneToday", () => {
  const now = new Date(2026, 8, 19, 20, 0);

  it("没练过就是 0", () => {
    expect(countDoneToday([], now)).toBe(0);
  });

  it("同一个词练三遍也只算一个 —— 否则进度会超过 100%", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w1", created_at: at(2026, 9, 19, 10) },
      { word_id: "w1", created_at: at(2026, 9, 19, 11) },
    ];
    expect(countDoneToday(logs, now)).toBe(1);
  });

  it("不同的词各算一个", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w2", created_at: at(2026, 9, 19, 9) },
      { word_id: "w3", created_at: at(2026, 9, 19, 10) },
    ];
    expect(countDoneToday(logs, now)).toBe(3);
  });

  it("昨天练的今天不算", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 18, 12) },
      { word_id: "w2", created_at: at(2026, 9, 19, 8) },
    ];
    expect(countDoneToday(logs, now)).toBe(1);
  });

  it("坏掉的时间戳跳过，不拖垮进度", () => {
    const logs = [
      { word_id: "w1", created_at: "这不是时间" },
      { word_id: "w2", created_at: "" },
      { word_id: "w3", created_at: at(2026, 9, 19, 8) },
    ];
    expect(countDoneToday(logs, now)).toBe(1);
  });

  it("今天 00:00 整算今天（边界不丢）", () => {
    const logs = [{ word_id: "w1", created_at: at(2026, 9, 19, 0, 0) }];
    expect(countDoneToday(logs, now)).toBe(1);
  });

  it("明天的时间戳不算今天（提前写入的脏数据）", () => {
    const logs = [{ word_id: "w1", created_at: at(2026, 9, 20, 1) }];
    expect(countDoneToday(logs, now)).toBe(0);
  });
});

describe("progressRatio", () => {
  it("总量为 0 时返回 0，而不是 NaN / Infinity", () => {
    expect(progressRatio(0, 0)).toBe(0);
    expect(progressRatio(5, 0)).toBe(0);
  });
  it("按比例算", () => {
    expect(progressRatio(12, 20)).toBeCloseTo(0.6);
  });

  it("封顶 1，不越界", () => {
    expect(progressRatio(30, 20)).toBe(1);
  });

  it("负数归零", () => {
    expect(progressRatio(-3, 20)).toBe(0);
  });
});

describe("doneWordIdsToday", () => {
  const now = new Date(2026, 8, 19, 20, 0);

  it("返回今天的词 id 集合（去重）", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w1", created_at: at(2026, 9, 19, 10) },
      { word_id: "w2", created_at: at(2026, 9, 19, 10) },
    ];
    expect([...doneWordIdsToday(logs, now)].sort()).toEqual(["w1", "w2"]);
  });

  it("countDoneToday 就是它的大小（两套口径不允许分家）", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w2", created_at: at(2026, 9, 18, 9) },
    ];
    expect(countDoneToday(logs, now)).toBe(doneWordIdsToday(logs, now).size);
  });
});

/**
 * 这一组是首页与学习页共用口径的**技术保证**。
 * 两处各自算一遍迟早会飘（"学完 20 个回到首页显示 18/20"），
 * 所以分母与"哪些算练过"都在同一个函数里定义。
 */
describe("countDoneInPlan / 今日进度的唯一口径", () => {
  const now = new Date(2026, 8, 19, 20, 0);
  const plan = ["w1", "w2", "w3", "w4"];

  it("只数任务单里的词", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w99", created_at: at(2026, 9, 19, 9) }, // 不在今天这一单里
    ];
    expect(countDoneInPlan(logs, plan, now)).toBe(1);
  });

  it("同一个词练几遍只算一个", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9) },
      { word_id: "w1", created_at: at(2026, 9, 19, 10) },
      { word_id: "w1", created_at: at(2026, 9, 19, 11) },
    ];
    expect(countDoneInPlan(logs, plan, now)).toBe(1);
  });

  it("答错的词也算「练过」—— 进度环量的是练没练过，不是对没对", () => {
    const logs = [
      { word_id: "w1", created_at: at(2026, 9, 19, 9), is_correct: false },
      { word_id: "w2", created_at: at(2026, 9, 19, 9), is_correct: true },
    ];
    expect(countDoneInPlan(logs, plan, now)).toBe(2);
  });

  it("昨天练的词不算今天", () => {
    const logs = [{ word_id: "w1", created_at: at(2026, 9, 18, 9) }];
    expect(countDoneInPlan(logs, plan, now)).toBe(0);
  });

  it("任务单为空 → 0（不是 NaN）", () => {
    expect(countDoneInPlan([], [], now)).toBe(0);
  });

  it("结果永远不超过任务单长度（进度环不会画过头）", () => {
    const logs = plan.map((id) => ({ word_id: id, created_at: at(2026, 9, 19, 9) }));
    expect(countDoneInPlan(logs, plan, now)).toBe(plan.length);
    expect(progressRatio(countDoneInPlan(logs, plan, now), plan.length)).toBe(1);
  });
});
