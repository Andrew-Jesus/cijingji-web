import { describe, expect, it } from "vitest";

import {
  AGAIN_GAP,
  MAX_ATTEMPTS_PER_WORD,
  advance,
  buildQueue,
  formatElapsed,
  progressAt,
  settledWordIds,
  summarize,
  type QueueEntry,
} from "./session";
import type { StudyCard } from "./types";

function card(id: string): StudyCard {
  return {
    word_id: id,
    mode: "recognize",
    lemma: id.replace("w:", ""),
    phonetic_uk: null,
    pos: null,
    meaning_zh: `意思-${id}`,
    unit_code: "Unit 1",
    confidence: 1,
  };
}

function queue(ids: string[]): QueueEntry[] {
  return ids.map((id) => ({ card: card(id), round: 0 }));
}

describe("buildQueue", () => {
  it("去掉今天已经结清的词", () => {
    const q = buildQueue([card("w:a"), card("w:b"), card("w:c")], new Set(["w:b"]));
    expect(q.map((e) => e.card.word_id)).toEqual(["w:a", "w:c"]);
  });

  it("保持任务单给的顺序（它已经是确定性排序，别在这里再排一次）", () => {
    const q = buildQueue([card("w:z"), card("w:a"), card("w:m")], new Set());
    expect(q.map((e) => e.card.word_id)).toEqual(["w:z", "w:a", "w:m"]);
  });

  it("全部结清 → 空队列（界面据此直接给终态）", () => {
    expect(buildQueue([card("w:a")], new Set(["w:a"]))).toEqual([]);
  });

  it("初始 round 都是 0", () => {
    expect(buildQueue([card("w:a")], new Set())[0].round).toBe(0);
  });
});

describe("advance / 队列推进", () => {
  it("Good：只是往前走一步，队列长度不变", () => {
    const before = queue(["w:a", "w:b", "w:c", "w:d", "w:e"]);
    const r = advance(before, 0, 3);
    expect(r.nextPos).toBe(1);
    expect(r.queue).toHaveLength(5);
    expect(r.finished).toBe(false);
  });

  it("Again：把这张卡放回队列，隔开 AGAIN_GAP 张（不是马上重复，也不是远到忘掉）", () => {
    const r = advance(queue(["w:a", "w:b", "w:c", "w:d", "w:e"]), 0, 1);
    expect(r.queue).toHaveLength(6);
    // 走完一步之后，它出现在「当前位置 + AGAIN_GAP」处 —— 中间正好隔开 AGAIN_GAP-1 张
    const repeatAt = r.nextPos + AGAIN_GAP;
    expect(r.queue[repeatAt].card.word_id).toBe("w:a");
    expect(r.queue[repeatAt].round).toBe(1);
  });

  it("Again 回插的卡 round 递增（界面据此显示「第 2 遍」）", () => {
    const r = advance(queue(["w:a", "w:b", "w:c", "w:d"]), 0, 1);
    const repeat = r.queue.find((e) => e.round === 1);
    expect(repeat?.card.word_id).toBe("w:a");
  });

  it("同一个词练满 MAX_ATTEMPTS_PER_WORD 遍之后，再点 Again 也不回插（否则会被困在这一单里）", () => {
    const q: QueueEntry[] = [{ card: card("w:a"), round: MAX_ATTEMPTS_PER_WORD - 1 }, { card: card("w:b"), round: 0 }];
    const r = advance(q, 0, 1);
    expect(r.queue).toHaveLength(2);
  });

  it("不修改传入的队列（组件里可以直接 setState）", () => {
    const before = queue(["w:a", "w:b"]);
    const snapshot = JSON.stringify(before);
    advance(before, 0, 1);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("走到最后一个词之后 finished 为 true", () => {
    const r = advance(queue(["w:a"]), 0, 3);
    expect(r.finished).toBe(true);
  });

  it("Hard 不回插（一单里不会反复出现同一个「有点难」的词）", () => {
    const r = advance(queue(["w:a", "w:b", "w:c"]), 0, 2);
    expect(r.queue).toHaveLength(3);
  });
});

describe("progressAt", () => {
  it("分母是**当时的**队列长度 —— Again 回插会让总数变大，这是对的", () => {
    expect(progressAt(queue(["w:a", "w:b"]), 1)).toEqual({ done: 1, total: 2 });
    const r = advance(queue(["w:a"]), 0, 1);
    expect(progressAt(r.queue, r.nextPos)).toEqual({ done: 1, total: 2 });
  });

  it("done 不超过 total（进度条不会画过头）", () => {
    expect(progressAt(queue(["w:a"]), 99)).toEqual({ done: 1, total: 1 });
  });
});

describe("summarize / 终态汇总", () => {
  const cards = [card("w:a"), card("w:b"), card("w:c")];

  it("correct 数的是「一次就对」（不是「最后对了几个」）—— 蒙对的不能算成绩", () => {
    const s = summarize(
      [
        { word_id: "w:a", is_correct: true },
        { word_id: "w:b", is_correct: false },
        { word_id: "w:b", is_correct: true },
      ],
      cards,
      1000,
    );
    expect(s.total).toBe(2);
    expect(s.correct).toBe(1);
    expect(s.incorrect).toBe(1);
  });

  it("attempts 是作答次数，与词的个数分开（点了 27 下、练了 20 个词是两个数）", () => {
    const s = summarize(
      [
        { word_id: "w:a", is_correct: true },
        { word_id: "w:a", is_correct: true },
        { word_id: "w:b", is_correct: false },
      ],
      cards,
      0,
    );
    expect(s.total).toBe(2);
    expect(s.attempts).toBe(3);
  });

  it("card 与 incorrect 相加等于 total（界面上两个数不能对不上）", () => {
    const s = summarize([{ word_id: "w:a", is_correct: true }, { word_id: "w:b", is_correct: false }], cards, 0);
    expect(s.correct + s.incorrect).toBe(s.total);
  });

  it("stuck 列出错过次数，多的在前", () => {
    const s = summarize(
      [
        { word_id: "w:a", is_correct: false },
        { word_id: "w:a", is_correct: false },
        { word_id: "w:b", is_correct: false },
      ],
      cards,
      0,
    );
    expect(s.stuck[0]).toMatchObject({ word_id: "w:a", times: 2 });
    expect(s.stuck[1]).toMatchObject({ word_id: "w:b", times: 1 });
  });

  it("stuck 里带 lemma（界面直接显示词，不再回查词库）", () => {
    const s = summarize([{ word_id: "w:a", is_correct: false }], cards, 0);
    expect(s.stuck[0].lemma).toBe("a");
  });

  it("cards 里找不到的词不炸，回落到 word_id 当显示名", () => {
    const s = summarize([{ word_id: "w:nope", is_correct: false }], cards, 0);
    expect(s.stuck[0].lemma).toBe("w:nope");
  });

  it("全对时 stuck 为空（界面显示「一个都没有」）", () => {
    expect(summarize([{ word_id: "w:a", is_correct: true }], cards, 0).stuck).toEqual([]);
  });

  it("同样的记录永远排出同样的列表（次数相同时按字母序）", () => {
    const records = [
      { word_id: "w:b", is_correct: false },
      { word_id: "w:a", is_correct: false },
    ];
    expect(summarize(records, cards, 0).stuck.map((s) => s.lemma)).toEqual(
      summarize(records, cards, 0).stuck.map((s) => s.lemma),
    );
  });

  it("负数用时被夹到 0（时钟回拨之类的脏数据不该显示「-3 秒」）", () => {
    expect(summarize([], cards, -500).elapsed_ms).toBe(0);
  });
});

describe("formatElapsed / 用时的人话", () => {
  it("不到一分钟给秒（能让用户看到「其实只花了 40 秒」，对坚持是正向的）", () => {
    expect(formatElapsed(40_000)).toBe("40 秒");
  });

  it("整分钟不带零秒", () => {
    expect(formatElapsed(120_000)).toBe("2 分钟");
  });

  it("带零头给「X 分 Y 秒」", () => {
    expect(formatElapsed(95_000)).toBe("1 分 35 秒");
  });

  it("0 也不说「0 分钟」", () => {
    expect(formatElapsed(0)).toBe("0 秒");
  });
});

describe("会话模块的重导出", () => {
  it("settledWordIds 从 session 也能拿到（调用方只需要认识一个模块）", () => {
    expect(typeof settledWordIds).toBe("function");
  });
});
