import { describe, expect, it } from "vitest";

import {
  aggregateErrors,
  MIN_SAMPLES,
  REMEDY,
  remedyFor,
  topErrorType,
  withinLocalDays,
  type AttributionLog,
} from "./attribution";

/** 造一条日志。默认是「答对、3 秒、没犹豫」——只有要测的字段才写出来 */
function log(over: Partial<AttributionLog> & { word_id: string }): AttributionLog {
  return {
    is_correct: true,
    error_type: null,
    latency_ms: 3000,
    hesitation_count: 0,
    created_at: "2026-10-17T10:00:00.000Z",
    ...over,
  };
}

/** 造 n 条「答对」的日志，用来把 total 顶到阈值以上 */
function correctLogs(n: number, prefix = "ok"): AttributionLog[] {
  return Array.from({ length: n }, (_, i) =>
    log({ word_id: `${prefix}${i}`, is_correct: true }),
  );
}

describe("aggregateErrors / 空与样本不足", () => {
  it("空日志：全是 0，且 share 不是 NaN", () => {
    const r = aggregateErrors([]);
    expect(r.total).toBe(0);
    expect(r.wrong).toBe(0);
    expect(r.byType.meaning.share).toBe(0);
    expect(r.byType.spelling.share).toBe(0);
    expect(r.byType.confusion.share).toBe(0);
    expect(r.stubborn).toEqual([]);
    expect(r.slowest).toEqual([]);
    expect(r.hesitant).toEqual([]);
    expect(r.ignored).toBe(0);
    expect(r.confidence).toBe("too_few_samples");
  });

  it(`作答 ${MIN_SAMPLES - 1} 条：判为样本不足`, () => {
    expect(aggregateErrors(correctLogs(MIN_SAMPLES - 1)).confidence).toBe("too_few_samples");
  });

  it(`作答 ${MIN_SAMPLES} 条：刚好够，判为 ok（边界值单独测）`, () => {
    expect(aggregateErrors(correctLogs(MIN_SAMPLES)).confidence).toBe("ok");
  });

  it("样本不足时仍然把计数算出来 —— 只是不给结论", () => {
    const logs = [
      log({ word_id: "a", is_correct: false, error_type: "spelling" }),
      log({ word_id: "b", is_correct: false, error_type: "spelling" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.total).toBe(2);
    expect(r.wrong).toBe(2);
    expect(r.byType.spelling.count).toBe(2);
    expect(r.byType.spelling.share).toBe(1);
    expect(r.confidence).toBe("too_few_samples");
  });
});

describe("aggregateErrors / 错因分布", () => {
  it("三种错因分别计数，share 的分母是错题数不是总作答数", () => {
    const logs = [
      ...correctLogs(2),
      log({ word_id: "w1", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w2", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w3", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w4", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w5", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w6", is_correct: false, error_type: "meaning" }),
      log({ word_id: "w7", is_correct: false, error_type: "meaning" }),
      log({ word_id: "w8", is_correct: false, error_type: "confusion" }),
    ];
    const r = aggregateErrors(logs);

    expect(r.total).toBe(10);
    expect(r.wrong).toBe(8);
    expect(r.byType.spelling.count).toBe(5);
    expect(r.byType.meaning.count).toBe(2);
    expect(r.byType.confusion.count).toBe(1);
    // 5/8 而不是 5/10 —— 分母是错题
    expect(r.byType.spelling.share).toBeCloseTo(5 / 8, 6);
    expect(r.byType.meaning.share).toBeCloseTo(2 / 8, 6);
    expect(r.unclassified).toBe(0);
  });

  it("答对却带着错因：不计入任何一种", () => {
    const logs = [
      ...correctLogs(4),
      log({ word_id: "x", is_correct: true, error_type: "spelling" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.byType.spelling.count).toBe(0);
    expect(r.unclassified).toBe(0);
    expect(r.wrong).toBe(0);
  });

  it("未知错因计入 unclassified，不冒充 meaning", () => {
    const logs = [
      ...correctLogs(4),
      log({ word_id: "x", is_correct: false, error_type: "手滑" }),
      log({ word_id: "y", is_correct: false, error_type: null }),
    ];
    const r = aggregateErrors(logs);
    expect(r.wrong).toBe(2);
    expect(r.unclassified).toBe(2);
    expect(r.byType.meaning.count).toBe(0);
  });

  it("全部答对时 byType 全 0，confidence 仍是 ok", () => {
    const r = aggregateErrors(correctLogs(MIN_SAMPLES));
    expect(r.wrong).toBe(0);
    expect(r.byType.spelling.count).toBe(0);
    expect(r.byType.spelling.share).toBe(0);
    expect(r.confidence).toBe("ok");
  });
});

describe("aggregateErrors / 脏数据", () => {
  it("压根没带时间：算有效记录，不进 ignored", () => {
    const logs: AttributionLog[] = [
      { word_id: "a", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "b", is_correct: true, error_type: null, latency_ms: 2500, hesitation_count: 0 },
    ];
    const r = aggregateErrors(logs);
    expect(r.total).toBe(2);
    expect(r.wrong).toBe(1);
    expect(r.ignored).toBe(0);
  });

  it("时间为 null：同样算有效，不当作脏数据", () => {
    const r = aggregateErrors([
      { word_id: "a", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0, created_at: null },
    ]);
    expect(r.total).toBe(1);
    expect(r.ignored).toBe(0);
  });

  it("没时间的词：last_wrong_at 是 null，不编成 0", () => {
    const r = aggregateErrors([
      { word_id: "w", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "w", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
    ]);
    expect(r.stubborn).toHaveLength(1);
    expect(r.stubborn[0].last_wrong_at).toBeNull();
  });

  it("错次相同时，有时间的排在没有时间的前面", () => {
    const logs: AttributionLog[] = [
      { word_id: "no-time", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "no-time", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      log({ word_id: "timed", is_correct: false, error_type: "spelling" }),
      log({ word_id: "timed", is_correct: false, error_type: "spelling" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.stubborn.map((s) => s.word_id)).toEqual(["timed", "no-time"]);
  });

  it("两个都没时间时按 word_id 兜底，不产生 NaN 比较", () => {
    const logs: AttributionLog[] = [
      { word_id: "z", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "z", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "a", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
      { word_id: "a", is_correct: false, error_type: "spelling", latency_ms: 3000, hesitation_count: 0 },
    ];
    expect(aggregateErrors(logs).stubborn.map((s) => s.word_id)).toEqual(["a", "z"]);
  });

  it("时间戳坏掉的记录跳过，并单独计数", () => {
    const logs = [
      ...correctLogs(5),
      log({ word_id: "bad", is_correct: false, error_type: "spelling", created_at: "不是时间" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.total).toBe(5);
    expect(r.wrong).toBe(0);
    expect(r.ignored).toBe(1);
  });

  it("犹豫次数是非有限值时不计入（不会把 NaN 传进求和）", () => {
    const logs = [
      log({ word_id: "w", hesitation_count: Number.NaN }),
      log({ word_id: "w", hesitation_count: 2 }),
    ];
    const r = aggregateErrors(logs);
    expect(r.hesitant).toHaveLength(1);
    expect(r.hesitant[0].hesitation).toBe(2);
  });

  it("非有限耗时不算进均值样本；负耗时按 0 计", () => {
    const logs = [
      log({ word_id: "w", latency_ms: 4000 }),
      log({ word_id: "w", latency_ms: Number.NaN }),
      log({ word_id: "w", latency_ms: -9000 }),
    ];
    const r = aggregateErrors(logs);
    const slow = r.slowest.find((s) => s.word_id === "w");
    // 只有 2 条可用（4000 与 0），NaN 那条被排除
    expect(slow).toBeDefined();
    expect(slow!.samples).toBe(2);
    expect(slow!.avg_latency_ms).toBe(2000);
  });
});

describe("aggregateErrors / 顽固词", () => {
  it("同一个词错 2 次才进榜，错 1 次不进", () => {
    const logs = [
      ...correctLogs(4),
      log({ word_id: "once", is_correct: false, error_type: "spelling" }),
      log({ word_id: "twice", is_correct: false, error_type: "spelling" }),
      log({ word_id: "twice", is_correct: false, error_type: "spelling" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.stubborn.map((s) => s.word_id)).toEqual(["twice"]);
    expect(r.stubborn[0].wrong).toBe(2);
    expect(r.stubborn[0].attempts).toBe(2);
  });

  it("按错次降序；错次相同则最近错的排前面", () => {
    const logs = [
      log({ word_id: "old", is_correct: false, error_type: "spelling", created_at: "2026-10-01T00:00:00.000Z" }),
      log({ word_id: "old", is_correct: false, error_type: "spelling", created_at: "2026-10-02T00:00:00.000Z" }),
      log({ word_id: "recent", is_correct: false, error_type: "spelling", created_at: "2026-10-16T00:00:00.000Z" }),
      log({ word_id: "recent", is_correct: false, error_type: "spelling", created_at: "2026-10-17T00:00:00.000Z" }),
      log({ word_id: "many", is_correct: false, error_type: "meaning" }),
      log({ word_id: "many", is_correct: false, error_type: "meaning" }),
      log({ word_id: "many", is_correct: false, error_type: "meaning" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.stubborn.map((s) => s.word_id)).toEqual(["many", "recent", "old"]);
  });

  it("kinds 去重且顺序固定（meaning → spelling → confusion）", () => {
    const logs = [
      log({ word_id: "w", is_correct: false, error_type: "confusion" }),
      log({ word_id: "w", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w", is_correct: false, error_type: "confusion" }),
      log({ word_id: "w", is_correct: false, error_type: "meaning" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.stubborn[0].kinds).toEqual(["meaning", "spelling", "confusion"]);
  });
});

describe("aggregateErrors / 最慢与最犹豫", () => {
  it("最慢榜单默认要求至少 2 次作答，单次的词不进", () => {
    const logs = [
      log({ word_id: "fast", latency_ms: 1000 }),
      log({ word_id: "fast", latency_ms: 1200 }),
      log({ word_id: "slow_once", latency_ms: 20000 }),
      log({ word_id: "slow", latency_ms: 8000 }),
      log({ word_id: "slow", latency_ms: 9000 }),
    ];
    const r = aggregateErrors(logs);
    expect(r.slowest.map((s) => s.word_id)).toEqual(["slow", "fast"]);
    expect(r.slowest[0].avg_latency_ms).toBe(8500);
  });

  it("minSlowSamples 可以放宽到 1（参数真的生效）", () => {
    const logs = [
      log({ word_id: "once", latency_ms: 20000 }),
      log({ word_id: "twice", latency_ms: 5000 }),
      log({ word_id: "twice", latency_ms: 5000 }),
    ];
    const r = aggregateErrors(logs, { minSlowSamples: 1 });
    expect(r.slowest.map((s) => s.word_id)).toEqual(["once", "twice"]);
  });

  it("犹豫次数按求和排，不按平均摊薄", () => {
    const logs = [
      log({ word_id: "a", hesitation_count: 2 }),
      log({ word_id: "a", hesitation_count: 2 }),
      log({ word_id: "b", hesitation_count: 3 }),
    ];
    const r = aggregateErrors(logs);
    expect(r.hesitant[0].word_id).toBe("a");
    expect(r.hesitant[0].hesitation).toBe(4);
    expect(r.hesitant[1].word_id).toBe("b");
  });

  it("limit 对每个榜单都生效", () => {
    const logs = Array.from({ length: 8 }, (_, i) =>
      log({ word_id: `w${i}`, is_correct: false, error_type: "spelling" }),
    ).flatMap((l) => [l, { ...l }]);
    const r = aggregateErrors(logs, { limit: 3 });
    expect(r.stubborn).toHaveLength(3);
  });

  it("limit 传负数按 0 处理（榜单为空，不返回负数切片）", () => {
    const logs = [
      log({ word_id: "w", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w", is_correct: false, error_type: "spelling" }),
      log({ word_id: "w", hesitation_count: 2 }),
    ];
    const r = aggregateErrors(logs, { limit: -1 });
    expect(r.stubborn).toEqual([]);
    expect(r.slowest).toEqual([]);
    expect(r.hesitant).toEqual([]);
  });

  it("minSlowSamples 传 0 时按 1 处理（不会把门槛降到负数）", () => {
    const logs = [log({ word_id: "once", latency_ms: 9000 })];
    const r = aggregateErrors(logs, { minSlowSamples: 0 });
    expect(r.slowest.map((s) => s.word_id)).toEqual(["once"]);
  });
});

describe("aggregateErrors / 结果确定性", () => {
  it("同样的输入两次调用结果完全一致（顺序也一致）", () => {
    const logs = [
      log({ word_id: "b", is_correct: false, error_type: "spelling" }),
      log({ word_id: "a", is_correct: false, error_type: "spelling" }),
      log({ word_id: "c", is_correct: false, error_type: "meaning" }),
      log({ word_id: "c", is_correct: false, error_type: "meaning" }),
      log({ word_id: "a", is_correct: false, error_type: "meaning" }),
    ];
    expect(aggregateErrors(logs)).toEqual(aggregateErrors(logs));
  });

  it("错次相同时按 word_id 兜底排序，不靠插入顺序", () => {
    const logs = [
      log({ word_id: "z", is_correct: false, error_type: "spelling" }),
      log({ word_id: "z", is_correct: false, error_type: "spelling" }),
      log({ word_id: "a", is_correct: false, error_type: "spelling" }),
      log({ word_id: "a", is_correct: false, error_type: "spelling" }),
    ];
    const r = aggregateErrors(logs);
    expect(r.stubborn.map((s) => s.word_id)).toEqual(["a", "z"]);
  });
});

describe("topErrorType / 挑最该补的一类", () => {
  function make(counts: { meaning?: number; spelling?: number; confusion?: number }, padding = 5) {
    const logs: AttributionLog[] = [...correctLogs(padding)];
    for (const [type, n] of Object.entries(counts)) {
      for (let i = 0; i < (n ?? 0); i += 1) {
        logs.push(log({ word_id: `${type}${i}`, is_correct: false, error_type: type }));
      }
    }
    return aggregateErrors(logs);
  }

  it("取错得最多的那一类", () => {
    expect(topErrorType(make({ meaning: 1, spelling: 4 }))).toBe("spelling");
  });

  it("并列时不猜，返回 null", () => {
    expect(topErrorType(make({ meaning: 2, spelling: 2 }))).toBeNull();
  });

  it("样本不足时返回 null（少样本挑第一名没有意义）", () => {
    const r = aggregateErrors([
      log({ word_id: "a", is_correct: false, error_type: "spelling" }),
      log({ word_id: "b", is_correct: false, error_type: "spelling" }),
    ]);
    expect(topErrorType(r)).toBeNull();
  });

  it("全部答对时返回 null", () => {
    expect(topErrorType(aggregateErrors(correctLogs(6)))).toBeNull();
  });
});

describe("remedyFor / 三种错因三种补救", () => {
  it("每种错因都有话说，且互不相同", () => {
    const texts = [remedyFor("meaning"), remedyFor("spelling"), remedyFor("confusion")];
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(3);
  });

  it("REMEDY 覆盖三种错因（不多不少）", () => {
    expect(Object.keys(REMEDY).sort()).toEqual(["confusion", "meaning", "spelling"]);
  });
});

describe("withinLocalDays —— 回顾页的「最近 N 天」", () => {
  /*
    口径是**自然日**，不是"从此刻往前推 N×24 小时"。
    后者会在半夜切进去半截 —— 同样说"近 7 天"，晚上 9 点和早上 9 点看到的数不一样。
  */
  const NOW = new Date(2026, 9, 17, 15, 0, 0); // 2026-10-17 15:00（本机时区）

  function row(date: Date, id: string) {
    return { word_id: id, created_at: date.toISOString() };
  }

  it("含今天；往回到第 N 天的 0 点，再往前一天就不要了", () => {
    const rows = [
      row(new Date(2026, 9, 17, 9, 0), "today"),
      row(new Date(2026, 9, 16, 23, 0), "yesterday"),
      row(new Date(2026, 9, 11, 0, 1), "first-day"), // 17 − 6 = 11，窗口第一天
      row(new Date(2026, 9, 10, 23, 59), "too-old"), // 差一分钟到第 8 天
    ];
    expect(withinLocalDays(rows, 7, NOW).map((r) => r.word_id)).toEqual([
      "today",
      "yesterday",
      "first-day",
    ]);
  });

  it("days = 1 就是「只有今天」", () => {
    const rows = [
      row(new Date(2026, 9, 17, 0, 0), "today-start"),
      row(new Date(2026, 9, 16, 23, 59), "yesterday-night"),
    ];
    expect(withinLocalDays(rows, 1, NOW).map((r) => r.word_id)).toEqual(["today-start"]);
  });

  it("days 传 0 / 负数 / 小数都夹到至少 1 天（0 天没有意义）", () => {
    const rows = [
      row(new Date(2026, 9, 17, 9, 0), "today"),
      row(new Date(2026, 9, 15, 9, 0), "two-days-ago"),
    ];
    for (const days of [0, -3, 0.4]) {
      expect(withinLocalDays(rows, days, NOW).map((r) => r.word_id)).toEqual(["today"]);
    }
  });

  it("★ 没有时间 / 时间坏掉的记录不进窗口 —— 不知道哪天发生，就不能算进「最近 7 天」", () => {
    const rows = [
      { word_id: "no-time", created_at: null },
      { word_id: "missing" },
      { word_id: "broken", created_at: "not-a-date" },
      row(new Date(2026, 9, 17, 9, 0), "good"),
    ];
    expect(withinLocalDays(rows, 7, NOW).map((r) => r.word_id)).toEqual(["good"]);
  });

  it("比今天还晚的时间不算（上界是明天 0 点，开区间）", () => {
    const rows = [
      row(new Date(2026, 9, 17, 23, 59), "tonight"),
      row(new Date(2026, 9, 18, 0, 0), "tomorrow"),
    ];
    expect(withinLocalDays(rows, 7, NOW).map((r) => r.word_id)).toEqual(["tonight"]);
  });

  it("跨月也对 —— 往上退靠日期运算，不靠减毫秒", () => {
    const nowNov = new Date(2026, 10, 3, 10, 0, 0); // 11-03
    const rows = [
      row(new Date(2026, 10, 3, 9, 0), "nov-3"),
      row(new Date(2026, 9, 28, 9, 0), "oct-28"), // 11-03 往回 6 天 = 10-28
      row(new Date(2026, 9, 27, 9, 0), "oct-27"),
    ];
    expect(withinLocalDays(rows, 7, nowNov).map((r) => r.word_id)).toEqual(["nov-3", "oct-28"]);
  });
});
