import { describe, expect, it } from "vitest";
import { fsrsScheduler } from "@/lib/study/fsrs";
import { gradeFor, replayWordMemory } from "@/lib/study/replay";
import type { ReplayLog } from "@/lib/study/replay";

const at = (iso: string) => new Date(iso);

/** 一条作答流水 */
const log = (id: string, word_id: string, created_at: string, ok: boolean, rating: number | null): ReplayLog => ({
  id,
  word_id,
  is_correct: ok,
  rating,
  created_at,
});

describe("真实调度器（ts-fsrs）", () => {
  it("新卡：还没学过，下次立刻就能问（due = 当时）", () => {
    const s = fsrsScheduler.initial(at("2026-10-24T12:00:00Z"));
    expect(s.reps).toBe(0);
    expect(s.lapses).toBe(0);
    expect(s.state).toBe("new");
    expect(s.last_review).toBeNull();
    expect(s.due).toBe("2026-10-24T12:00:00.000Z");
  });

  it("答对一次：进学习步骤，10 分钟后再问（不是直接跳到明天）", () => {
    const t = at("2026-10-24T12:00:00Z");
    const s = fsrsScheduler.next(fsrsScheduler.initial(t), 3, t);
    expect(s.reps).toBe(1);
    expect(s.state).toBe("learning");
    expect(s.last_review).toBe("2026-10-24T12:00:00.000Z");
    expect(s.scheduled_days).toBe(0);
    expect(s.due).toBe("2026-10-24T12:10:00.000Z");
  });

  it("首见即答错：1 分钟后再来，但**不算一次遗忘**", () => {
    const t = at("2026-10-24T12:00:00Z");
    const s = fsrsScheduler.next(fsrsScheduler.initial(t), 1, t);
    expect(s.reps).toBe(1);
    expect(s.due).toBe("2026-10-24T12:01:00.000Z");
    // ★ 见下面那条测试：第一次见就没想起来，谈不上"忘掉"
    expect(s.lapses).toBe(0);
  });

  it("★★★★ 坑：lapses 只统计『记住了又忘掉』，首见失败不算", () => {
    // 为什么必须钉住这条：将来做"难词区 / 顽固词"时，最容易的写法就是
    // `lapses > 0`。那样一来**所有"第一次见就没认出来"的词全部不进难词区**，
    // 而那是新词最常见的情况 —— 结果就是难词区永远几乎是空的，
    // 而且**不报错、不崩、界面上看起来还挺正常**。
    // 正确做法：难词区读 `review_logs` 的错题次数（`attribution.ts` 已有），
    // `lapses` 只用来表达"它曾经是你的、后来丢了"这层更强的意思。
    const t = at("2026-10-24T12:00:00Z");
    const firstSightFail = fsrsScheduler.next(fsrsScheduler.initial(t), 1, t);
    expect(firstSightFail.lapses).toBe(0);

    // 走完学习、进入复习期之后，再答错才算一次遗忘
    let s = firstSightFail;
    let now = new Date(s.due);
    s = fsrsScheduler.next(s, 3, now);
    now = new Date(s.due);
    s = fsrsScheduler.next(s, 3, now);
    expect(s.state).toBe("review");
    now = new Date(s.due);
    s = fsrsScheduler.next(s, 1, now);
    expect(s.lapses).toBe(1);
    expect(s.state).toBe("relearning");
  });

  it("连续答对到毕业：间隔会真的拉长（不是永远 10 分钟）", () => {
    let slice = fsrsScheduler.initial(at("2026-10-24T00:00:00Z"));
    let t = at("2026-10-24T00:00:00Z");
    // 走完两个学习步骤
    for (let i = 0; i < 2; i++) {
      slice = fsrsScheduler.next(slice, 3, t);
      t = new Date(slice.due);
    }
    expect(slice.state).toBe("review");
    const firstInterval = slice.scheduled_days;
    expect(firstInterval).toBeGreaterThanOrEqual(1);

    // 再答对两次，间隔必须变长 —— 这是"熬过遗忘"在数据上的样子
    slice = fsrsScheduler.next(slice, 3, t);
    const second = slice.scheduled_days;
    expect(second).toBeGreaterThan(firstInterval);
  });

  it("★★★★ 同一批流水重放两次，结果必须逐字节相同（确定性）", () => {
    // 这条是「状态表可以随时丢弃」这个架构决定的**唯一验收标准**。
    // 只要 fuzz 被意外打开、或者哪里混进了当前时间，这条就会红。
    const logs: ReplayLog[] = [
      log("r1", "w:a", "2026-10-20T08:00:00.000Z", true, 3),
      log("r2", "w:a", "2026-10-21T08:00:00.000Z", true, 2),
      log("r3", "w:a", "2026-10-23T08:00:00.000Z", true, 3),
      log("r4", "w:b", "2026-10-20T08:05:00.000Z", false, 1),
      log("r5", "w:b", "2026-10-22T08:05:00.000Z", true, 3),
    ];

    const once = replayWordMemory({ logs, scheduler: fsrsScheduler, userId: "u1" });
    const twice = replayWordMemory({ logs, scheduler: fsrsScheduler, userId: "u1" });
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("★ 重放与时间无关：隔一年再重放，算出来的 due 一模一样", () => {
    // 反过来说：如果哪天有人在算法层偷偷用了 Date.now()，
    // 这条测试就会随机器时间漂移而红（虽然不一定当天就红，但会在换天时红）。
    const logs: ReplayLog[] = [log("r1", "w:a", "2026-10-01T08:00:00.000Z", true, 3)];
    const a = replayWordMemory({ logs, scheduler: fsrsScheduler, userId: "u1" });
    const b = replayWordMemory({ logs, scheduler: fsrsScheduler, userId: "u1" });
    expect(a[0].due).toBe(b[0].due);
  });

  it("流水顺序打乱不影响结果（重放内部会排序）", () => {
    const sorted: ReplayLog[] = [
      log("r1", "w:a", "2026-10-20T08:00:00.000Z", true, 3),
      log("r2", "w:a", "2026-10-22T08:00:00.000Z", false, 1),
      log("r3", "w:a", "2026-10-24T08:00:00.000Z", true, 3),
    ];
    const shuffled = [sorted[2], sorted[0], sorted[1]];
    const a = replayWordMemory({ logs: sorted, scheduler: fsrsScheduler, userId: "u1" });
    const b = replayWordMemory({ logs: shuffled, scheduler: fsrsScheduler, userId: "u1" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("『忘过又练回来』会留下 lapses（界面靠它说『它以前打败过你』）", () => {
    // 这一段流水模拟真实经历：先学、学进复习期、然后忘掉、最后重新认回来
    const logs: ReplayLog[] = [
      log("r1", "w:a", "2026-10-01T08:00:00.000Z", true, 3),
      log("r2", "w:a", "2026-10-01T08:11:00.000Z", true, 3),
      log("r3", "w:a", "2026-10-02T08:11:00.000Z", true, 3),
      log("r4", "w:a", "2026-10-04T08:11:00.000Z", false, 1),
      log("r5", "w:a", "2026-10-04T08:21:00.000Z", true, 3),
    ];
    const [m] = replayWordMemory({ logs, scheduler: fsrsScheduler, userId: "u1" });
    expect(m.lapses).toBe(1);
    expect(m.reps).toBe(5);
  });
});

describe("gradeFor 的边界（它决定间隔长短，错一次就是拿记忆做实验）", () => {
  it("答错了永远拿不到 Good 及以上", () => {
    for (const rating of [null, 1, 2, 3]) {
      expect(gradeFor({ is_correct: false, rating })).toBeLessThan(3);
    }
  });

  it("答错 + 用户说『很顺』（手滑）给 Hard，不是 Good", () => {
    expect(gradeFor({ is_correct: false, rating: 3 })).toBe(2);
  });

  it("答对 + 用户说『没想起来』（蒙对）给 Again —— 用户自己都说没想起来", () => {
    expect(gradeFor({ is_correct: true, rating: 1 })).toBe(1);
  });

  it("答对 + 缺 rating（老数据）默认 Good", () => {
    expect(gradeFor({ is_correct: true, rating: null })).toBe(3);
  });
});
