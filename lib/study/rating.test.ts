import { describe, expect, it } from "vitest";

import {
  RATING_FOOTNOTE,
  RATING_OPTIONS,
  defaultRating,
  ratingForKey,
  ratingHint,
  ratingOption,
  shouldRequeue,
  type RatingKey,
} from "./rating";

describe("RATING_OPTIONS / 三档的取值", () => {
  it("rating 就是 1 / 2 / 3，直接写进 review_logs.rating（不要在这里做映射）", () => {
    expect(RATING_OPTIONS.map((o) => o.rating)).toEqual([1, 2, 3]);
  });

  it("顺序是 Again → Hard → Good（界面上从左到右就是由难到易）", () => {
    expect(RATING_OPTIONS.map((o) => o.key)).toEqual(["again", "hard", "good"]);
  });

  it("不开放第 4 档 Easy（起步阶段多一个「太简单」只会把信号搞脏）", () => {
    // 先降成 number[] 再比：`Rating` 是 1|2|3，直接 `o.rating === 4` 会被类型系统
    // 判成笔误。但这条断言守的恰恰是"将来有人偷偷加第 4 档"，它必须能和 4 比较。
    const ratings: number[] = RATING_OPTIONS.map((o) => o.rating);
    expect(ratings.length).toBe(3);
    expect(ratings).not.toContain(4);
  });

  it("每档都有 label 与两种场景的解释（答对答错时用户想的不一样，两句都要有）", () => {
    for (const o of RATING_OPTIONS) {
      expect(o.label.trim().length).toBeGreaterThan(0);
      expect(o.hint_correct.trim().length).toBeGreaterThan(0);
      expect(o.hint_wrong.trim().length).toBeGreaterThan(0);
      expect(o.hint_correct).not.toBe(o.hint_wrong);
    }
  });

  it("key 不重复（重复会让 ratingOption 拿错一档）", () => {
    const keys = RATING_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("defaultRating / 系统预选档", () => {
  it("答对 → Good", () => {
    expect(defaultRating(true)).toBe(3);
  });

  it("答错 → Again", () => {
    expect(defaultRating(false)).toBe(1);
  });
});

describe("ratingHint", () => {
  it("答对时给 hint_correct", () => {
    const good = ratingOption("good");
    expect(ratingHint(good, true)).toBe(good.hint_correct);
  });

  it("答错时给 hint_wrong（例如 Good 在答错时是「明明会，是手滑」）", () => {
    const good = ratingOption("good");
    expect(ratingHint(good, false)).toBe(good.hint_wrong);
  });
});

describe("查表", () => {
  it("ratingOption 按 key 查", () => {
    expect(ratingOption("hard").rating).toBe(2);
  });

  it("未知 key 回落第一档而不是抛异常（一个文案查表不该让整页挂掉）", () => {
    expect(ratingOption("nope" as RatingKey).rating).toBe(1);
  });

  it("ratingForKey 按数值查", () => {
    expect(ratingForKey(3).key).toBe("good");
  });
});

describe("shouldRequeue / Again 才回插队列", () => {
  it("Again → 回插", () => {
    expect(shouldRequeue(1)).toBe(true);
  });

  it("Hard 不回插 —— 否则「有点难」的词会在同一次学习里反复出现，很烦", () => {
    expect(shouldRequeue(2)).toBe(false);
  });

  it("Good 不回插", () => {
    expect(shouldRequeue(3)).toBe(false);
  });
});

describe("RATING_FOOTNOTE / 必须说清的边界", () => {
  /*
    这组测试 2026-11-01 重写过。原来的三条守着的是**一句假话**：

      it("要写明科学复习调度还没接", () => expect(RATING_FOOTNOTE).toContain("阶段 2"));

    可是 FSRS 在 10-24 就接了，`studyRepo.ts` 每次作答都拿 rating 算新排期。
    测试一直绿，界面一直在骗人 —— 因为它守的是"这句话有没有被改掉"，
    而不是"这句话是不是真的"。**断言要对着事实写，不能对着历史文案写。**

    现在的分工：
      · 第 1 条守**必须说的事**（它确实影响复习安排，这个必须让用户知道）
      · 第 2 条守**不许再说的假话**（防回潮 —— 这条是新增的，专门防今天这个问题再发生一次）
      · 第 3 条守**不许越过界**（界面不知道具体隔几天，参数是通用默认值，不许替算法打保票）
  */

  it("必须说清它影响复习安排（不然用户会以为这是个无关紧要的心情按钮）", () => {
    expect(RATING_FOOTNOTE).toContain("下次");
    expect(RATING_FOOTNOTE).toContain("再出现");
  });

  it("不许再说「复习调度还没接」——FSRS 已经接了，这句话现在是假的", () => {
    expect(RATING_FOOTNOTE).not.toContain("还没接");
    expect(RATING_FOOTNOTE).not.toContain("阶段 2");
  });

  it("不许承诺具体天数（间隔由 FSRS 算，参数还是通用默认值，界面不该打保票）", () => {
    expect(RATING_FOOTNOTE).not.toMatch(/\d+\s*天/);
    expect(RATING_FOOTNOTE).not.toContain("天后");
    expect(RATING_FOOTNOTE).not.toContain("固定");
  });
});
