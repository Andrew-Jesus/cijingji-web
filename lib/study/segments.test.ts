import { describe, expect, it } from "vitest";

import { WEIGHT_DUE, WEIGHT_FRESH, WEIGHT_NOT_DUE, WEIGHT_WEAK } from "@/lib/plan/buildDailyPlan";

import type { QueueEntry } from "./session";
import type { StudyCard } from "./types";
import {
  buildJourneySegments,
  reorderForJourney,
  segmentByWord,
  segmentOfWeight,
  segmentProgressAt,
  transitionNoteFor,
  type SegmentableItem,
} from "./segments";

/** 最小可用卡 —— 分段函数只看 word_id，其余字段填占位值 */
function card(wordId: string): StudyCard {
  return {
    word_id: wordId,
    mode: "recognize",
    lemma: wordId,
    phonetic_uk: null,
    pos: null,
    meaning_zh: null,
    unit_code: "",
    confidence: 1,
    answers: [wordId],
  };
}

function entry(wordId: string, round = 0): QueueEntry {
  return { card: card(wordId), round };
}

function item(wordId: string, score: number): SegmentableItem {
  return { word_id: wordId, priority_score: score };
}

describe("segmentOfWeight / weight 到段的身份", () => {
  it("四个排课常量各归其段", () => {
    expect(segmentOfWeight(WEIGHT_DUE)).toBe("warmup");
    expect(segmentOfWeight(WEIGHT_NOT_DUE)).toBe("warmup");
    expect(segmentOfWeight(WEIGHT_WEAK)).toBe("siege");
    expect(segmentOfWeight(WEIGHT_FRESH)).toBe("fresh");
  });

  it("未知值兜进热身 —— 绝不把复习卡说成新词", () => {
    expect(segmentOfWeight(99)).toBe("warmup");
    expect(segmentOfWeight(0)).toBe("warmup");
    expect(segmentOfWeight(NaN)).toBe("warmup");
  });
});

describe("buildJourneySegments / 非空段、行进顺序", () => {
  const MIXED = [
    item("w:due1", WEIGHT_DUE),
    item("w:fresh1", WEIGHT_FRESH),
    item("w:due2", WEIGHT_DUE),
    item("w:weak1", WEIGHT_WEAK),
    item("w:notdue1", WEIGHT_NOT_DUE),
    item("w:fresh2", WEIGHT_FRESH),
  ];

  it("三段齐全时按 热身 → 攻坚 → 新词 排列，空段不出现", () => {
    const segs = buildJourneySegments(MIXED);
    expect(segs.map((s) => s.kind)).toEqual(["warmup", "siege", "fresh"]);
  });

  it("段内保持任务单原序（到期词 due1 在 due2 前、新词 fresh1 在 fresh2 前）", () => {
    const segs = buildJourneySegments(MIXED);
    expect(segs[0]!.wordIds).toEqual(["w:due1", "w:due2", "w:notdue1"]);
    expect(segs[1]!.wordIds).toEqual(["w:weak1"]);
    expect(segs[2]!.wordIds).toEqual(["w:fresh1", "w:fresh2"]);
  });

  it("只有新词（第一天用户）→ 只有新词一段", () => {
    const segs = buildJourneySegments([item("w:a", WEIGHT_FRESH), item("w:b", WEIGHT_FRESH)]);
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe("fresh");
    expect(segs[0]!.wordIds).toEqual(["w:a", "w:b"]);
  });

  it("FSRS 接入前的旧计划（只有 WEAK/FRESH）→ 没有热身段，不渲染空格子", () => {
    const segs = buildJourneySegments([item("w:a", WEIGHT_WEAK), item("w:b", WEIGHT_FRESH)]);
    expect(segs.map((s) => s.kind)).toEqual(["siege", "fresh"]);
  });

  it("空任务单 → 空段列表", () => {
    expect(buildJourneySegments([])).toEqual([]);
  });
});

describe("reorderForJourney / 只动顺序，不丢卡不改卡", () => {
  it("重排后按段序排列，段内保持原相对顺序", () => {
    const items = [
      item("w:fresh1", WEIGHT_FRESH),
      item("w:due1", WEIGHT_DUE),
      item("w:weak1", WEIGHT_WEAK),
      item("w:fresh2", WEIGHT_FRESH),
    ];
    const ordered = reorderForJourney(items);
    expect(ordered.map((i) => i.word_id)).toEqual(["w:due1", "w:weak1", "w:fresh1", "w:fresh2"]);
  });

  it("不丢不重：长度与 word_id 集合不变，其余字段原样带过来", () => {
    const items = [
      { word_id: "w:a", priority_score: WEIGHT_FRESH, sense_id: "s:1", lemma: "apple" },
      { word_id: "w:b", priority_score: WEIGHT_DUE, sense_id: null, lemma: "beach" },
    ];
    const ordered = reorderForJourney(items);
    expect(ordered.length).toBe(2);
    expect(new Set(ordered.map((i) => i.word_id))).toEqual(new Set(["w:a", "w:b"]));
    const apple = ordered.find((i) => i.word_id === "w:a")!;
    expect(apple.sense_id).toBe("s:1");
    expect(apple.lemma).toBe("apple");
  });

  it("已经是段序的单子 → 顺序原样返回（幂等）", () => {
    const items = [item("w:a", WEIGHT_DUE), item("w:b", WEIGHT_WEAK), item("w:c", WEIGHT_FRESH)];
    expect(reorderForJourney(items).map((i) => i.word_id)).toEqual(["w:a", "w:b", "w:c"]);
  });

  it("两次重排结果完全一致（幂等，可快照）", () => {
    const items = [
      item("w:a", WEIGHT_FRESH),
      item("w:b", WEIGHT_WEAK),
      item("w:c", WEIGHT_DUE),
      item("w:d", WEIGHT_NOT_DUE),
    ];
    const once = reorderForJourney(items);
    const twice = reorderForJourney(once);
    expect(twice).toEqual(once);
  });
});

describe("segmentByWord / 学习页查当前卡的段", () => {
  it("每个词都能查到自己的段", () => {
    const map = segmentByWord([
      item("w:a", WEIGHT_DUE),
      item("w:b", WEIGHT_WEAK),
      item("w:c", WEIGHT_FRESH),
    ]);
    expect(map.get("w:a")).toBe("warmup");
    expect(map.get("w:b")).toBe("siege");
    expect(map.get("w:c")).toBe("fresh");
    expect(map.get("w:missing")).toBeUndefined();
  });
});

describe("segmentProgressAt / 段内进度（与 progressAt 同口径）", () => {
  const seg = {
    kind: "warmup" as const,
    label: "热身",
    wordIds: ["w:a", "w:b", "w:c"],
  };
  const queue = [entry("w:a"), entry("w:b"), entry("w:c"), entry("w:x"), entry("w:y")];

  it("一步没走 → 0 / 段内词数（别段的词不进分母）", () => {
    expect(segmentProgressAt(queue, 0, seg)).toEqual({ done: 0, total: 3 });
  });

  it("走完前两张 → 2 / 3", () => {
    expect(segmentProgressAt(queue, 2, seg)).toEqual({ done: 2, total: 3 });
  });

  it("走到别段的卡上，本段全结清 → 满", () => {
    expect(segmentProgressAt(queue, 3, seg)).toEqual({ done: 3, total: 3 });
  });

  it("答错回插 → pending 按词去重，刚错的那个词不记完成", () => {
    // a 答错回插到队尾（round=1）：pos=1 往后 a 还会出现 → 不算完成，即便它 pos 前出现过
    const requeued: QueueEntry[] = [entry("w:a"), entry("w:b"), entry("w:c"), entry("w:x"), entry("w:a", 1)];
    expect(segmentProgressAt(requeued, 1, seg)).toEqual({ done: 0, total: 3 });
  });

  it("回插的词最后答对 → 进度补上", () => {
    // 同一条队列走到 pos=5（收工）：a 的回插卡也答对了 → 段内全清
    const requeued: QueueEntry[] = [entry("w:a"), entry("w:b"), entry("w:c"), entry("w:x"), entry("w:a", 1)];
    expect(segmentProgressAt(requeued, 5, seg)).toEqual({ done: 3, total: 3 });
  });

  it("装载时已结清的词不在队列里 → 它的完成自动入账（与首页今日进度同一机制）", () => {
    // buildQueue 滤掉已结清的 w:a，队列只剩 b/c/x：pos=0 时 a 也算完成
    const preSettled: QueueEntry[] = [entry("w:b"), entry("w:c"), entry("w:x")];
    expect(segmentProgressAt(preSettled, 0, seg)).toEqual({ done: 1, total: 3 });
  });

  it("pos 越界（收工时刻）→ 段内全完成", () => {
    expect(segmentProgressAt([], 99, seg)).toEqual({ done: 3, total: 3 });
  });

  it("段内词 id 异常重复 → 按 Set 口径收口，分母不重复计", () => {
    const weird = { kind: "warmup" as const, label: "热身", wordIds: ["w:a", "w:a", "w:b"] };
    const q = [entry("w:a"), entry("w:b")];
    expect(segmentProgressAt(q, 2, weird)).toEqual({ done: 2, total: 2 });
  });
});

describe("transitionNoteFor / 段切换的一行文案", () => {
  it("攻坚段说出它的身份（这些词之前错过）", () => {
    expect(transitionNoteFor("siege")).toBe("这些词之前错过，回来算账");
  });

  it("新词段同样", () => {
    expect(transitionNoteFor("fresh")).toBe("硬仗打完，见几个新面孔");
  });

  it("热身没有进入文案 —— 开场就是它，再打招呼是噪音", () => {
    expect(transitionNoteFor("warmup")).toBeNull();
  });
});
