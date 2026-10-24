import { describe, expect, it } from "vitest";

import {
  gradeFor,
  replayWordMemory,
  type MemoryGrade,
  type MemoryScheduler,
  type MemorySlice,
  type ReplayLog,
} from "@/lib/study/replay";

/**
 * 假调度器。
 *
 * 它**故意不是真 FSRS** —— 这里要验的是重放逻辑（排序、累加、脏数据），
 * 不是算法本身。假算法有两条简单到可以心算的规则：
 *   · Again(1) → 稳定度归 1，lapses +1
 *   · Hard(2) → +1，Good(3) → +2
 * 于是任何一条断言的期望值都能当场推出来，测试失败时一眼看得出错在哪。
 */
const fakeScheduler: MemoryScheduler = {
  initial: (at) => ({
    due: at.toISOString(),
    stability: 0,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: "new",
    last_review: null,
    learning_steps: 0,
  }),
  next: (prev: MemorySlice, grade: MemoryGrade, at) => ({
    ...prev,
    reps: prev.reps + 1,
    lapses: prev.lapses + (grade === 1 ? 1 : 0),
    stability: grade === 1 ? 1 : prev.stability + (grade >= 3 ? 2 : 1),
    due: new Date(at.getTime() + 86_400_000).toISOString(),
    last_review: at.toISOString(),
    state: "review",
  }),
};

const log = (over: Partial<ReplayLog> & { id: string }): ReplayLog => ({
  word_id: "w:condition",
  is_correct: true,
  rating: 3,
  created_at: "2026-10-01T10:00:00.000Z",
  ...over,
});

const run = (logs: ReplayLog[]) =>
  replayWordMemory({ logs, scheduler: fakeScheduler, userId: "u1" });

describe("gradeFor —— 客观对错是硬约束，用户的感受只能往下调", () => {
  it("答对 + 很顺 → Good", () => {
    expect(gradeFor({ is_correct: true, rating: 3 })).toBe(3);
  });

  it("答对 + 没想起来（蒙对的）→ Again，不能拉长间隔", () => {
    expect(gradeFor({ is_correct: true, rating: 1 })).toBe(1);
  });

  it("答对 + 费劲 → Hard", () => {
    expect(gradeFor({ is_correct: true, rating: 2 })).toBe(2);
  });

  it("答对 + 没有 rating（老数据）→ Good，与 defaultRating 同一个默认", () => {
    expect(gradeFor({ is_correct: true, rating: null })).toBe(3);
  });

  it("答错 → 永远拿不到 Good 及以上（最重要的那条）", () => {
    for (const rating of [null, 1, 2, 3, 4, 5, 0, -1, Number.NaN]) {
      const g = gradeFor({ is_correct: false, rating });
      expect(g, `rating=${String(rating)}`).toBeLessThanOrEqual(2);
    }
  });

  it("答错 + 用户说「其实会，是手滑」→ Hard", () => {
    expect(gradeFor({ is_correct: false, rating: 3 })).toBe(2);
  });

  it("答错 + 没想起来 → Again", () => {
    expect(gradeFor({ is_correct: false, rating: 1 })).toBe(1);
  });

  it("答错 + rating 为空 → Again", () => {
    expect(gradeFor({ is_correct: false, rating: null })).toBe(1);
  });
});

describe("replayWordMemory", () => {
  it("空流水 → 一条状态都不产生（没学过的词不该出现在表里）", () => {
    expect(run([])).toEqual([]);
  });

  it("一条正确记录 → 一个词、reps=1、稳定度按 Good 走", () => {
    const [row] = run([log({ id: "rl-1" })]);
    expect(row.word_id).toBe("w:condition");
    expect(row.reps).toBe(1);
    expect(row.stability).toBe(2);
    expect(row.lapses).toBe(0);
    expect(row.state).toBe("review");
    expect(row.last_review).toBe("2026-10-01T10:00:00.000Z");
  });

  it("一条错误记录 → lapses 记 1，稳定度归 1", () => {
    const [row] = run([log({ id: "rl-1", is_correct: false, rating: 1 })]);
    expect(row.lapses).toBe(1);
    expect(row.stability).toBe(1);
  });

  it("同词多条 → 逐条累加（先错后对：reps=2、lapses=1、稳定度 1+2=3）", () => {
    const [row] = run([
      log({ id: "rl-1", is_correct: false, rating: 1, created_at: "2026-10-01T10:00:00.000Z" }),
      log({ id: "rl-2", is_correct: true, rating: 3, created_at: "2026-10-03T10:00:00.000Z" }),
    ]);
    expect(row.reps).toBe(2);
    expect(row.lapses).toBe(1);
    expect(row.stability).toBe(3);
  });

  it("★ 输入顺序不影响结果：重放自己会排序", () => {
    const early = log({ id: "rl-1", is_correct: false, rating: 1, created_at: "2026-10-01T10:00:00.000Z" });
    const late = log({ id: "rl-2", is_correct: true, rating: 3, created_at: "2026-10-05T10:00:00.000Z" });

    const a = run([early, late])[0];
    const b = run([late, early])[0];

    expect(a.stability).toBe(b.stability);
    expect(a.reps).toBe(b.reps);
    // 顺序真的起作用了：如果先跑 late 再跑 early，稳定度会是 1 而不是 3
    expect(a.stability).toBe(3);
  });

  it("同一时刻的两条 → 按 id 兜底，两次重放结果一致（不靠数组原顺序碰运气）", () => {
    const x = log({ id: "rl-a", is_correct: false, rating: 1, created_at: "2026-10-01T10:00:00.000Z" });
    const y = log({ id: "rl-b", is_correct: true, rating: 3, created_at: "2026-10-01T10:00:00.000Z" });

    const first = run([x, y])[0];
    const second = run([y, x])[0];
    expect(first.stability).toBe(second.stability);
    expect(first.reps).toBe(2);
  });

  it("坏掉的时间戳跳过，不打断这个词的历史", () => {
    const [row] = run([
      log({ id: "rl-1", created_at: "坏掉的字符串" }),
      log({ id: "rl-2", created_at: "2026-10-02T10:00:00.000Z" }),
    ]);
    expect(row.reps).toBe(1);
  });

  it("全是坏时间戳 → 不产生状态（而不是产生一条脏状态）", () => {
    expect(run([log({ id: "rl-1", created_at: "x" })])).toEqual([]);
  });

  it("多个词分开算，互不干扰", () => {
    const rows = run([
      log({ id: "rl-1", word_id: "w:a", is_correct: true, rating: 3 }),
      log({ id: "rl-2", word_id: "w:b", is_correct: false, rating: 1 }),
    ]);
    const byWord = new Map(rows.map((r) => [r.word_id, r]));
    expect(byWord.get("w:a")?.lapses).toBe(0);
    expect(byWord.get("w:b")?.lapses).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("编号带主人，且与 ids.ts 的规则一致", () => {
    const [row] = run([log({ id: "rl-1", word_id: "w:reach" })]);
    expect(row.id).toBe("st:u1:w:reach");
    expect(row.user_id).toBe("u1");
  });

  it("换了个人重放，编号也随之变化（不会两人共用一条状态）", () => {
    const rows = replayWordMemory({
      logs: [log({ id: "rl-1", word_id: "w:reach" })],
      scheduler: fakeScheduler,
      userId: "u2",
    });
    expect(rows[0].id).toBe("st:u2:w:reach");
  });

  it("updated_at 取最后一条记录的时间（说明这份状态算到哪一刻）", () => {
    const [row] = run([
      log({ id: "rl-1", created_at: "2026-10-01T10:00:00.000Z" }),
      log({ id: "rl-2", created_at: "2026-10-09T10:00:00.000Z" }),
    ]);
    expect(row.updated_at).toBe("2026-10-09T10:00:00.000Z");
  });

  it("所有时间字段都是 UTC ISO 串，且 due 在 last_review 之后（排序依赖这个）", () => {
    const [row] = run([log({ id: "rl-1", created_at: "2026-10-01T10:00:00.000Z" })]);
    expect(row.due).toBe("2026-10-02T10:00:00.000Z");
    expect(Date.parse(row.due)).toBeGreaterThan(Date.parse(row.last_review ?? ""));
  });
});
