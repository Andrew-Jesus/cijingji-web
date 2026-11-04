import { describe, expect, it } from "vitest";

import {
  MILESTONE_LABEL,
  MILESTONE_ORDER,
  isConquered,
  milestoneFromLogs,
  milestonesByWord,
  type MilestoneLog,
} from "./milestone";

/** 便捷构造：从基准时刻偏移 n 天造一条正确记录 */
const hit = (dayOffset: number, base = "2026-11-01T08:00:00.000Z"): MilestoneLog => ({
  is_correct: true,
  created_at: new Date(Date.parse(base) + dayOffset * 86_400_000).toISOString(),
});

const miss = (dayOffset: number, base = "2026-11-01T08:00:00.000Z"): MilestoneLog => ({
  is_correct: false,
  created_at: new Date(Date.parse(base) + dayOffset * 86_400_000).toISOString(),
});

describe("记忆台阶 · 单词判级", () => {
  it("没有任何记录 → 生词", () => {
    expect(milestoneFromLogs([])).toBe("new");
  });

  it("只答错过、从没答对过 → 仍是生词（台阶只说爬到哪，摔跤是难词区的事）", () => {
    expect(milestoneFromLogs([miss(0), miss(1)])).toBe("new");
  });

  it("答对过一次 → 认得", () => {
    expect(milestoneFromLogs([hit(0)])).toBe("known");
  });

  it("两次正确隔 2 天 → 还只是认得（判据要 ≥3 天）", () => {
    expect(milestoneFromLogs([hit(0), hit(2)])).toBe("known");
  });

  it("两次正确恰好隔 3 天 → 熬过一次遗忘（边界：含 3）", () => {
    expect(milestoneFromLogs([hit(0), hit(3)])).toBe("endured");
  });

  it("两次正确隔不到 3 天（2.99）→ 认得", () => {
    const base = Date.parse("2026-11-01T08:00:00.000Z");
    expect(
      milestoneFromLogs([
        { is_correct: true, created_at: new Date(base).toISOString() },
        { is_correct: true, created_at: new Date(base + 2.99 * 86_400_000).toISOString() },
      ]),
    ).toBe("known");
  });

  it("三次正确但最大间隔只有 6 天 → 熬过一次遗忘（没到 7 天不算稳）", () => {
    expect(milestoneFromLogs([hit(0), hit(3), hit(6)])).toBe("endured");
  });

  it("三次正确且有一次恰好隔 7 天 → 稳了（边界：含 7）", () => {
    expect(milestoneFromLogs([hit(0), hit(3), hit(7)])).toBe("solid");
  });

  it("只对过两次、哪怕隔 30 天 → 仍是熬过一次遗忘（稳了要 ≥3 次正确）", () => {
    expect(milestoneFromLogs([hit(0), hit(30)])).toBe("endured");
  });

  it("三次都是同一天连对（间隔 0）→ 认得", () => {
    expect(milestoneFromLogs([hit(0), hit(0), hit(0)])).toBe("known");
  });

  it("乱序输入不影响判级 —— 函数内部自己排", () => {
    expect(milestoneFromLogs([hit(7), hit(0), miss(2), hit(3)])).toBe("solid");
  });

  it("错答穿插在正确之间，不影响间隔计算", () => {
    expect(milestoneFromLogs([hit(0), miss(1), miss(2), hit(3), hit(7)])).toBe("solid");
  });

  it("时间解析不了的记录被忽略，不抛错也不误判", () => {
    expect(milestoneFromLogs([hit(0), { is_correct: true, created_at: "不是时间" }])).toBe("known");
  });

  it("同一个词摔过跤（lapse）不影响台阶 —— 判级只看正确间隔", () => {
    // 第 0 天对、第 1 天错、第 4 天又对：两次正确隔 4 天 → 熬过一次遗忘
    expect(milestoneFromLogs([hit(0), miss(1), hit(4)])).toBe("endured");
  });
});

describe("记忆台阶 · 全量聚合", () => {
  it("按词分组各判各的，互不串味", () => {
    const logs = [
      { word_id: "w:apple", ...hit(0) },
      { word_id: "w:apple", ...hit(3) },
      { word_id: "w:cat", ...hit(0) },
      { word_id: "w:dog", ...miss(0) },
    ];
    const m = milestonesByWord(logs);
    expect(m.get("w:apple")).toBe("endured");
    expect(m.get("w:cat")).toBe("known");
    expect(m.get("w:dog")).toBe("new");
    expect(m.size).toBe(3);
  });

  it("没出现过的词不在结果里 —— 调用方查不到就是生词，不给假默认值", () => {
    const m = milestonesByWord([{ word_id: "w:apple", ...hit(0) }]);
    expect(m.has("w:cat")).toBe(false);
  });
});

describe("记忆台阶 · 征服口径与常量", () => {
  it("征服 = 熬过一次遗忘及以上；认得只是交手", () => {
    expect(isConquered("new")).toBe(false);
    expect(isConquered("known")).toBe(false);
    expect(isConquered("endured")).toBe(true);
    expect(isConquered("solid")).toBe(true);
  });

  it("顺序从低到高，四个人话名字一个不少", () => {
    expect(MILESTONE_ORDER).toEqual(["new", "known", "endured", "solid"]);
    for (const m of MILESTONE_ORDER) {
      expect(MILESTONE_LABEL[m]).toBeTruthy();
    }
  });
});
