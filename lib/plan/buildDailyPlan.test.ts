import { describe, expect, it } from "vitest";

import type { Pace, WordMemory } from "@/lib/db/types";
import {
  buildDailyPlan,
  chooseMode,
  WEIGHT_DUE,
  WEIGHT_FRESH,
  WEIGHT_NOT_DUE,
  WEIGHT_WEAK,
} from "@/lib/plan/buildDailyPlan";
import type { WordRef } from "@/lib/scope/resolveScope";

const paceOf = (over: Partial<Pace> = {}): Pace => ({
  new_ratio: 0.6,
  session_size: 20,
  spelling_required: true,
  speed_drill: false,
  review_priority: "weak_first",
  ...over,
});

/** 造 30 个词，避免依赖真实数据的具体条数 */
const makeWords = (n: number): WordRef[] =>
  Array.from({ length: n }, (_, i) => ({
    word_id: `w:${i}`,
    lemma: `word${String(i).padStart(2, "0")}`,
    phonetic_uk: null,
    sense_id: `s:${i}`,
    sense_pos: "n.",
    meaning_zh: `释义${i}`,
    unit_id: "u1",
    unit_code: "Unit 1",
    role: "new" as const,
    confidence: 0.75,
  }));

describe("buildDailyPlan", () => {
  it("按 daily_cap 截断，不多给", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items).toHaveLength(20);
  });

  it("幂等：同输入两次结果完全一致（不掺时间、不掺随机）", () => {
    const input = { words: makeWords(30), daily_cap: 20, pace: paceOf() };
    const a = buildDailyPlan(input);
    const b = buildDailyPlan(input);
    expect(a.items.map((i) => i.word_id)).toEqual(b.items.map((i) => i.word_id));
    expect(a.estimated_minutes).toBe(b.estimated_minutes);
  });

  it("错词排在最前面，且权重更高", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      weak_word_ids: ["w:25", "w:26"],
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items[0].word_id).toBe("w:25");
    expect(out.items[0].priority_score).toBe(WEIGHT_WEAK);
    expect(out.items.filter((i) => i.priority_score === WEIGHT_FRESH).length).toBeGreaterThan(0);
  });

  it("某一类不够时用另一类补足（不会只给 3 个词）", () => {
    const out = buildDailyPlan({
      words: makeWords(10),
      weak_word_ids: [],
      daily_cap: 20,
      pace: paceOf(),
    });
    expect(out.items).toHaveLength(10); // 词不够就给全部，但不报错
  });

  it("用时估算随模式变化：考拼写比只认词更慢", () => {
    const spelling = buildDailyPlan({ words: makeWords(20), daily_cap: 20, pace: paceOf({ spelling_required: true }) });
    const recognize = buildDailyPlan({ words: makeWords(20), daily_cap: 20, pace: paceOf({ spelling_required: false }) });
    expect(spelling.estimated_minutes).toBeGreaterThan(recognize.estimated_minutes);
  });

  it("pace 里不出现任何复习间隔参数 —— 模式只由 spelling_required 决定", () => {
    expect(chooseMode(paceOf({ spelling_required: true }))).toBe("recall_spell");
    expect(chooseMode(paceOf({ spelling_required: false }))).toBe("recognize");
  });

  it("词量为 0 时不崩", () => {
    const out = buildDailyPlan({ words: [], daily_cap: 20, pace: paceOf() });
    expect(out.items).toHaveLength(0);
    expect(out.estimated_minutes).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- 接入 FSRS 后的新路径

const NOW = new Date("2026-10-24T12:00:00.000Z");

const mem = (wordId: string, due: string, over: Partial<WordMemory> = {}): WordMemory => ({
  id: `st:u1:${wordId}`,
  user_id: "u1",
  word_id: wordId,
  due,
  stability: 5,
  difficulty: 5,
  elapsed_days: 1,
  scheduled_days: 1,
  reps: 2,
  lapses: 0,
  state: "review",
  last_review: "2026-10-01T00:00:00.000Z",
  learning_steps: 0,
  updated_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

const clockOf = (rows: WordMemory[], now = NOW) => ({
  memory: new Map(rows.map((r) => [r.word_id, r])),
  now,
});

/** 逾期 N 天（相对 NOW） */
const overdueBy = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();
/** 还有 N 天才到期 */
const dueIn = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

describe("buildDailyPlan · 接入记忆状态后", () => {
  it("到期的词排在所有新词前面", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf(), // new_ratio 0.6 → newQuota 12
      clock: clockOf([
        mem("w:25", overdueBy(3)),
        mem("w:26", overdueBy(1)),
      ]),
    });

    expect(out.items[0].word_id).toBe("w:25"); // 逾期更久的先
    expect(out.items[1].word_id).toBe("w:26");
    expect(out.items[0].priority_score).toBe(WEIGHT_DUE);
    expect(out.items[2].priority_score).toBe(WEIGHT_FRESH);
  });

  it("★ 到期数 ≥ 每日额度时，一个新词都不给（防复习雪崩）", () => {
    const rows = makeWords(30).map((w) => mem(w.word_id, overdueBy(2)));
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf(),
      clock: clockOf(rows),
    });

    expect(out.items).toHaveLength(20);
    expect(out.items.every((i) => i.priority_score === WEIGHT_DUE)).toBe(true);
    expect(out.breakdown.fresh).toBe(0);
  });

  it("逾期越久越先：10 天 > 5 天 > 1 天", () => {
    const out = buildDailyPlan({
      words: makeWords(10),
      daily_cap: 10,
      pace: paceOf(),
      clock: clockOf([
        mem("w:0", overdueBy(1)),
        mem("w:1", overdueBy(10)),
        mem("w:2", overdueBy(5)),
      ]),
    });
    expect(out.items.slice(0, 3).map((i) => i.word_id)).toEqual(["w:1", "w:2", "w:0"]);
  });

  it("到期时间相同 → 按词 id 兜底，结果确定", () => {
    const same = overdueBy(2);
    const rows = [mem("w:7", same), mem("w:3", same), mem("w:5", same)];
    const a = buildDailyPlan({ words: makeWords(10), daily_cap: 10, pace: paceOf(), clock: clockOf(rows) });
    const b = buildDailyPlan({
      words: makeWords(10),
      daily_cap: 10,
      pace: paceOf(),
      clock: clockOf([...rows].reverse()),
    });
    expect(a.items.map((i) => i.word_id)).toEqual(b.items.map((i) => i.word_id));
    expect(a.items.slice(0, 3)).toMatchObject([{ word_id: "w:3" }, { word_id: "w:5" }, { word_id: "w:7" }]);
  });

  it("新词受 new_ratio 约束：到期 2 个时，新词最多 12 个（cap 20 × 0.6）", () => {
    // 前提：学过的词已经够一天的量（这里 26 个）—— 否则会走"还没攒够一天"那条
    // 例外分支给满额度，那样这条就测不到 new_ratio 了。
    const learned = Array.from({ length: 24 }, (_, i) => mem(`w:${i}`, dueIn(3)));
    const out = buildDailyPlan({
      words: makeWords(60),
      daily_cap: 20,
      pace: paceOf({ new_ratio: 0.6 }),
      clock: clockOf([mem("w:58", overdueBy(1)), mem("w:59", overdueBy(2)), ...learned]),
    });
    expect(out.breakdown.due).toBe(2);
    expect(out.breakdown.fresh).toBe(12);
    expect(out.items).toHaveLength(20);
  });

  it("新词额度用完后，空位优先给「还没到期」的旧词，而不是继续加新词", () => {
    // 2 个到期 + 12 个新词 = 14，还差 6 个空位
    const notDueRows = [0, 1, 2, 3, 4, 5].map((i) => mem(`w:${20 + i}`, dueIn(1 + i)));
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf({ new_ratio: 0.6 }),
      clock: clockOf([
        mem("w:28", overdueBy(1)),
        mem("w:29", overdueBy(2)),
        ...notDueRows,
      ]),
    });

    expect(out.breakdown.due).toBe(2);
    expect(out.breakdown.fresh).toBe(12);
    expect(out.breakdown.not_due).toBe(6);
    expect(out.items).toHaveLength(20);
    // 补位的旧词按「最早到期先」：w:20（明天）在前
    expect(out.items.slice(-6).map((i) => i.word_id)).toEqual([
      "w:20",
      "w:21",
      "w:22",
      "w:23",
      "w:24",
      "w:25",
    ]);
  });

  it("补位的旧词里，错过的那几个排前面", () => {
    const out = buildDailyPlan({
      words: makeWords(10),
      weak_word_ids: ["w:9"],
      daily_cap: 3,
      pace: paceOf({ new_ratio: 0 }),
      clock: clockOf([
        mem("w:0", dueIn(1)),
        mem("w:9", dueIn(5)),
      ]),
    });
    // new_ratio 0 → 不给新词；只有两个旧词可给，错过的那个必须先出现
    expect(out.items[0].word_id).toBe("w:9");
    expect(out.items[0].priority_score).toBe(WEIGHT_WEAK);
    expect(out.items[1].priority_score).toBe(WEIGHT_NOT_DUE);
  });

  it("★ 第一天（一条记忆状态都没有）仍然把额度填满 —— 不能只给 12 个", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf({ new_ratio: 0.6 }),
      clock: clockOf([]),
    });
    expect(out.items).toHaveLength(20);
    expect(out.items.every((i) => i.priority_score === WEIGHT_FRESH)).toBe(true);
  });

  it("★★ 只学了 1 个词时，第二天照样给满额度（不是「一条都没有」才给满）", () => {
    // 回归防线：这条曾经写成 `memory.size === 0`，症状是"用户第一天只答了 1 个词，
    // 第二天打开发现说好 24 个只给 15 个"，而界面上找不到任何解释。
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf({ new_ratio: 0.6 }),
      clock: clockOf([mem("w:0", dueIn(1))]),
    });
    expect(out.items).toHaveLength(20);
  });

  it("★★ 学过的词已经超过一天的量时，new_ratio 必须真的生效（防雪崩）", () => {
    // 上面那条例外一旦写宽（比如写成"没有到期词就给满"），这条就会红。
    // 20 个学过的词全部还没到期、额度 10 → 新词最多 6 个（0.6），
    // 剩下 4 个额度由"没到期"的旧词补位。总数仍然是 10。
    const out = buildDailyPlan({
      words: makeWords(40),
      daily_cap: 10,
      pace: paceOf({ new_ratio: 0.6 }),
      clock: clockOf(
        Array.from({ length: 20 }, (_, i) => mem(`w:${i}`, dueIn(5))),
      ),
    });
    const freshCount = out.items.filter((i) => i.priority_score === WEIGHT_FRESH).length;
    expect(out.items).toHaveLength(10);
    expect(freshCount).toBeLessThanOrEqual(6);
  });

  it("坏掉的 due 当成到期（宁可多复习一次）", () => {
    const out = buildDailyPlan({
      words: makeWords(5),
      daily_cap: 5,
      pace: paceOf(),
      clock: clockOf([mem("w:4", "不是时间")]),
    });
    expect(out.items[0].word_id).toBe("w:4");
    expect(out.items[0].priority_score).toBe(WEIGHT_DUE);
  });

  it("幂等：同一份状态跑两次，顺序完全一致", () => {
    const input = {
      words: makeWords(30),
      daily_cap: 20,
      pace: paceOf(),
      clock: clockOf([mem("w:28", overdueBy(3)), mem("w:29", overdueBy(3))]),
    };
    const a = buildDailyPlan(input);
    const b = buildDailyPlan(input);
    expect(a.items.map((i) => i.word_id)).toEqual(b.items.map((i) => i.word_id));
  });

  it("同一个词不会在结果里出现两次", () => {
    const out = buildDailyPlan({
      words: makeWords(30),
      daily_cap: 30,
      pace: paceOf({ new_ratio: 1 }),
      clock: clockOf([mem("w:0", overdueBy(2))]),
    });
    const ids = out.items.map((i) => i.word_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("不传 clock 时，breakdown 里没有 due / not_due（没走这条路线，不是「0 个」）", () => {
    const out = buildDailyPlan({ words: makeWords(10), daily_cap: 5, pace: paceOf() });
    expect(out.breakdown.due).toBeUndefined();
    expect(out.breakdown.not_due).toBeUndefined();
  });
});
