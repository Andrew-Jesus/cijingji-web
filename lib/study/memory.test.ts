import { describe, expect, it } from "vitest";

import type { WordMemory } from "@/lib/db/types";
import {
  hasBeenForgotten,
  isDue,
  isUntouched,
  maturityOf,
  overdueDays,
} from "@/lib/study/memory";

const AT = new Date("2026-10-24T12:00:00.000Z");

const mem = (over: Partial<WordMemory> = {}): WordMemory => ({
  id: "st:u1:w:condition",
  user_id: "u1",
  word_id: "w:condition",
  due: "2026-10-24T12:00:00.000Z",
  stability: 0,
  difficulty: 5,
  elapsed_days: 0,
  scheduled_days: 0,
  reps: 0,
  lapses: 0,
  state: "new",
  last_review: null,
  learning_steps: 0,
  updated_at: "2026-10-24T12:00:00.000Z",
  ...over,
});

describe("isDue", () => {
  it("到期时间等于此刻 —— 算到期（不是「还没到」）", () => {
    expect(isDue(mem({ due: AT.toISOString() }), AT)).toBe(true);
  });

  it("一秒之后到期 —— 不算", () => {
    expect(isDue(mem({ due: "2026-10-24T12:00:01.000Z" }), AT)).toBe(false);
  });

  it("早就过期 —— 算", () => {
    expect(isDue(mem({ due: "2026-10-01T00:00:00.000Z" }), AT)).toBe(true);
  });

  it("坏掉的时间戳当到期 —— 宁可多复习一次，也不要让这个词永远消失", () => {
    expect(isDue(mem({ due: "不是时间" }), AT)).toBe(true);
  });
});

describe("overdueDays", () => {
  it("没逾期是 0，不是负数", () => {
    expect(overdueDays(mem({ due: "2026-10-30T00:00:00.000Z" }), AT)).toBe(0);
  });

  it("只差一小时 —— 向下取整仍是 0（今天刚到期，不算「逾期一天」）", () => {
    expect(overdueDays(mem({ due: "2026-10-24T11:00:00.000Z" }), AT)).toBe(0);
  });

  it("差 23 小时 —— 仍算 0 天", () => {
    expect(overdueDays(mem({ due: "2026-10-23T13:00:00.000Z" }), AT)).toBe(0);
  });

  it("差 25 小时 —— 1 天", () => {
    expect(overdueDays(mem({ due: "2026-10-23T11:00:00.000Z" }), AT)).toBe(1);
  });

  it("差 10 天 —— 10", () => {
    expect(overdueDays(mem({ due: "2026-10-14T12:00:00.000Z" }), AT)).toBe(10);
  });

  it("坏掉的时间戳返回 0（它只用来排序，不需要报警）", () => {
    expect(overdueDays(mem({ due: "坏" }), AT)).toBe(0);
  });
});

describe("maturityOf —— 四档只看 stability，不掺练习次数", () => {
  it("一次都没做过 = 生词，即使 stability 被写成了别的值", () => {
    expect(maturityOf(mem({ reps: 0, stability: 99 }))).toBe("new");
  });

  it("reps 为负（脏数据）也当生词，不会算出第五档", () => {
    expect(maturityOf(mem({ reps: -3, stability: 5 }))).toBe("new");
  });

  it("做过一次、稳定度不到 3 天 = 刚认得", () => {
    expect(maturityOf(mem({ reps: 1, stability: 2.999 }))).toBe("learning");
  });

  it("稳定度正好 3 天 = 记住了（边界值归高一档）", () => {
    expect(maturityOf(mem({ reps: 3, stability: 3 }))).toBe("familiar");
  });

  it("稳定度 20.9 天仍是「记住了」", () => {
    expect(maturityOf(mem({ reps: 5, stability: 20.9 }))).toBe("familiar");
  });

  it("稳定度正好 21 天 = 很牢", () => {
    expect(maturityOf(mem({ reps: 6, stability: 21 }))).toBe("solid");
  });

  it("lapses 再多也不直接决定档次 —— 那会变成「练得多就升级」", () => {
    const a = maturityOf(mem({ reps: 4, stability: 8, lapses: 0 }));
    const b = maturityOf(mem({ reps: 4, stability: 8, lapses: 9 }));
    expect(a).toBe(b);
    expect(a).toBe("familiar");
  });
});

describe("hasBeenForgotten / isUntouched", () => {
  it("lapses > 0 才算忘过", () => {
    expect(hasBeenForgotten(mem({ lapses: 0 }))).toBe(false);
    expect(hasBeenForgotten(mem({ lapses: 1 }))).toBe(true);
  });

  it("从没作答过 = untouched", () => {
    expect(isUntouched(mem({ reps: 0, state: "new" }))).toBe(true);
  });

  it("做过但状态停在 learning —— 不算 untouched", () => {
    expect(isUntouched(mem({ reps: 1, state: "learning" }))).toBe(false);
  });
});
