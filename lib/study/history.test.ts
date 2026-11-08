import { describe, expect, it } from "vitest";

import {
  latestOutcomeByWord,
  returningFriends,
  settledWordIds,
  weakWordIds,
  type OutcomeLog,
} from "./history";

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

function log(wordId: string, day: string, hour: number, isCorrect: boolean): OutcomeLog {
  return { word_id: wordId, is_correct: isCorrect, created_at: new Date(2026, 8, day === TODAY ? 19 : 18, hour).toISOString() };
}

describe("latestOutcomeByWord / 每个词的最后一次结果", () => {
  it("同一个词多条记录 → 取最新那条", () => {
    const rows = [log("w:a", TODAY, 9, false), log("w:a", TODAY, 10, true)];
    expect(latestOutcomeByWord(rows).get("w:a")?.is_correct).toBe(true);
  });

  it("顺序颠倒也一样（不依赖数组顺序）", () => {
    const rows = [log("w:a", TODAY, 10, true), log("w:a", TODAY, 9, false)];
    expect(latestOutcomeByWord(rows).get("w:a")?.is_correct).toBe(true);
  });

  it("同毫秒并列时取「错」的那条 —— 宁可多练一遍，也不漏掉没稳住的词", () => {
    const same = new Date(2026, 8, 19, 10, 0, 0).toISOString();
    const rows: OutcomeLog[] = [
      { word_id: "w:a", is_correct: true, created_at: same },
      { word_id: "w:a", is_correct: false, created_at: same },
    ];
    expect(latestOutcomeByWord(rows).get("w:a")?.is_correct).toBe(false);
  });

  it("坏时间戳跳过，不让一条脏数据把整个词的历史清空", () => {
    const rows: OutcomeLog[] = [
      { word_id: "w:a", is_correct: true, created_at: "not-a-date" },
      log("w:a", YESTERDAY, 9, false),
    ];
    expect(latestOutcomeByWord(rows).get("w:a")?.is_correct).toBe(false);
  });
});

describe("settledWordIds / 今天已经结清的词", () => {
  it("今天最后一次答对 → 结清", () => {
    expect([...settledWordIds([log("w:a", TODAY, 9, true)], TODAY)]).toEqual(["w:a"]);
  });

  it("今天最后一次答错 → 没结清（哪怕早上答对过）", () => {
    const rows = [log("w:a", TODAY, 9, true), log("w:a", TODAY, 10, false)];
    expect(settledWordIds(rows, TODAY).size).toBe(0);
  });

  it("昨天答对不算今天结清（跨天判断归阶段 2 的 FSRS，阶段 0 不假装会）", () => {
    expect(settledWordIds([log("w:a", YESTERDAY, 9, true)], TODAY).size).toBe(0);
  });

  it("多条词各判各的", () => {
    const rows = [log("w:a", TODAY, 9, true), log("w:b", TODAY, 9, false)];
    expect([...settledWordIds(rows, TODAY)]).toEqual(["w:a"]);
  });
});

describe("weakWordIds / 还没稳住的词", () => {
  it("最后一次答错的词才算错词", () => {
    const rows = [log("w:a", TODAY, 9, false), log("w:b", TODAY, 9, true)];
    expect(weakWordIds(rows, 10)).toEqual(["w:a"]);
  });

  it("最近错的排最前（昨天错的比上个月错的更值得今天练）", () => {
    const rows = [log("w:old", YESTERDAY, 9, false), log("w:new", TODAY, 9, false)];
    expect(weakWordIds(rows, 10)).toEqual(["w:new", "w:old"]);
  });

  it("limit 生效", () => {
    const rows = [
      log("w:1", TODAY, 9, false),
      log("w:2", TODAY, 10, false),
      log("w:3", TODAY, 11, false),
    ];
    expect(weakWordIds(rows, 2)).toEqual(["w:3", "w:2"]);
  });

  it("limit 为 0 / 负数 → 空数组（不是全部）", () => {
    const rows = [log("w:1", TODAY, 9, false)];
    expect(weakWordIds(rows, 0)).toEqual([]);
    expect(weakWordIds(rows, -5)).toEqual([]);
  });

  it("没有记录 → 空数组（第一次来的人没有错词）", () => {
    expect(weakWordIds([], 10)).toEqual([]);
  });

  it("结果顺序确定：同样的记录永远排出同样的列表（不靠 Map 插入顺序碰运气）", () => {
    const rows = [log("w:1", TODAY, 9, false), log("w:2", TODAY, 10, false)];
    expect(weakWordIds(rows, 10)).toEqual(weakWordIds(rows, 10));
  });
});

describe("settled 与 weak 是对同一件事的两面", () => {
  it("一个词要么结清、要么是错词、要么今天还没做过 —— 不会两边都算", () => {
    const rows = [
      log("w:done", TODAY, 9, true),
      log("w:weak", TODAY, 9, false),
      log("w:untouched", YESTERDAY, 9, true),
    ];
    const settled = settledWordIds(rows, TODAY);
    const weak = new Set(weakWordIds(rows, 10));
    expect(settled.has("w:done")).toBe(true);
    expect(weak.has("w:done")).toBe(false);
    expect(weak.has("w:weak")).toBe(true);
    expect(settled.has("w:weak")).toBe(false);
    expect(settled.has("w:untouched")).toBe(false);
    expect(weak.has("w:untouched")).toBe(false);
  });
});

describe("returningFriends / 老熟人回来", () => {
  /** 任意日期的记录（month 用 1~12 的自然月）。2026-09-19 = 本文件的 TODAY */
  function logOn(wordId: string, month: number, day: number, hour: number, isCorrect: boolean): OutcomeLog {
    return { word_id: wordId, is_correct: isCorrect, created_at: new Date(2026, month - 1, day, hour).toISOString() };
  }
  /** 收工时刻：9 月 19 日下午 —— now 决定"今天"的日界 */
  const FINISH = new Date(2026, 8, 19, 15, 0, 0);

  it("规格书原例：错 2 次、隔 11 天、今天对 → 算老熟人", () => {
    const rows = [
      logOn("w:suppose", 9, 8, 10, false),
      logOn("w:suppose", 9, 8, 11, false),
      logOn("w:suppose", 9, 19, 9, true),
    ];
    expect(returningFriends(rows, FINISH)).toEqual([
      { word_id: "w:suppose", wrongs_before: 2, gap_days: 11 },
    ]);
  });

  it("恰好 3 天 → 算（与记忆台阶「熬过一次遗忘」同一个门槛）", () => {
    const rows = [logOn("w:a", 9, 16, 10, false), logOn("w:a", 9, 19, 9, true)];
    expect(returningFriends(rows, FINISH)).toHaveLength(1);
  });

  it("昨天错的今天对 → 不算（才隔一天，谈不上回来）", () => {
    const rows = [log("w:a", YESTERDAY, 10, false), log("w:a", TODAY, 9, true)];
    expect(returningFriends(rows, FINISH)).toEqual([]);
  });

  it("今天先错后对 → 算翻盘；旧账只数今天以前的错", () => {
    const rows = [
      logOn("w:a", 9, 8, 10, false),
      logOn("w:a", 9, 8, 11, false),
      log("w:a", TODAY, 8, false),
      log("w:a", TODAY, 9, true),
    ];
    expect(returningFriends(rows, FINISH)).toEqual([
      { word_id: "w:a", wrongs_before: 2, gap_days: 11 },
    ]);
  });

  it("今天先对后错 → 不算（最后一次是错的，说「今天对了」是假话）", () => {
    const rows = [
      logOn("w:a", 9, 8, 10, false),
      log("w:a", TODAY, 9, true),
      log("w:a", TODAY, 10, false),
    ];
    expect(returningFriends(rows, FINISH)).toEqual([]);
  });

  it("以前只对过、没错过 → 不算（没打败过你的不算老熟人）", () => {
    const rows = [logOn("w:a", 9, 8, 10, true), log("w:a", TODAY, 9, true)];
    expect(returningFriends(rows, FINISH)).toEqual([]);
  });

  it("以前错过但今天没作答 → 不算", () => {
    expect(returningFriends([logOn("w:a", 9, 8, 10, false)], FINISH)).toEqual([]);
  });

  it("排序：隔得久的在前；并列比错次；再并列按 word_id", () => {
    const rows = [
      // w:b 隔 4 天错 1 次
      logOn("w:b", 9, 15, 10, false),
      log("w:b", TODAY, 9, true),
      // w:a 隔 4 天错 2 次（并列时错次多的在前）
      logOn("w:a", 9, 15, 9, false),
      logOn("w:a", 9, 15, 11, false),
      log("w:a", TODAY, 9, true),
      // w:c 隔 30 天错 1 次（最久，最前）
      logOn("w:c", 8, 20, 10, false),
      log("w:c", TODAY, 9, true),
    ];
    expect(returningFriends(rows, FINISH).map((f) => f.word_id)).toEqual(["w:c", "w:a", "w:b"]);
  });

  it("坏时间戳整条跳过，不把词的历史清零", () => {
    const rows: OutcomeLog[] = [
      { word_id: "w:a", is_correct: false, created_at: "not-a-date" },
      logOn("w:a", 9, 8, 10, false),
      log("w:a", TODAY, 9, true),
    ];
    expect(returningFriends(rows, FINISH)).toEqual([
      { word_id: "w:a", wrongs_before: 1, gap_days: 11 },
    ]);
  });

  it("minGapDays 可以调高 —— 默认之外不另造第二套默认值", () => {
    const rows = [logOn("w:a", 9, 16, 10, false), log("w:a", TODAY, 9, true)];
    expect(returningFriends(rows, FINISH, 7)).toEqual([]);
    expect(returningFriends(rows, FINISH, 3)).toHaveLength(1);
  });
});
