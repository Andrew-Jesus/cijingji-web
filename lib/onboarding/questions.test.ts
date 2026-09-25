import { describe, expect, it } from "vitest";

import {
  GENERIC_INTEREST_LABEL,
  GENERIC_INTEREST_LABEL_EN,
  GENERIC_INTEREST_TAG,
  GOAL_OPTIONS,
  INTEREST_OPTIONS,
  MAX_INTERESTS,
  MINUTE_OPTIONS,
  findGoal,
  interestLabel,
  isGoalSupported,
  resolveInterest,
} from "./questions";

describe("questions / 数据本身的自洽性", () => {
  it("目标 code 不重复（重复会让 find 拿错一项）", () => {
    const codes = GOAL_OPTIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("兴趣 tag 不重复（它是 user_examples 的键的一半）", () => {
    const tags = INTEREST_OPTIONS.map((o) => o.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("兴趣 tag 全是英文（要进 AI 提示词，中文 tag 会污染提示词）", () => {
    for (const o of INTEREST_OPTIONS) {
      expect(o.tag).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("时长选项升序排列（界面直接 map 渲染，顺序错了会显得混乱）", () => {
    const values = MINUTE_OPTIONS.map((o) => o.value);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("每题都有 hint（空白 hint 在界面上是一个空框）", () => {
    for (const o of GOAL_OPTIONS) expect(o.hint.length).toBeGreaterThan(0);
    for (const o of MINUTE_OPTIONS) expect(o.hint.length).toBeGreaterThan(0);
  });
});

describe("findGoal", () => {
  it("查得到 → 返回那一项", () => {
    expect(findGoal("zhongkao")?.label).toBe("中考");
  });

  it("查不到 → null，不抛异常（旧数据里可能有已下线的目标）", () => {
    expect(findGoal("kaoyan")).toBeNull();
  });

  it("null / undefined / 空串 → null（调用方不用先判空）", () => {
    expect(findGoal(null)).toBeNull();
    expect(findGoal(undefined)).toBeNull();
    expect(findGoal("")).toBeNull();
  });
});

describe("isGoalSupported", () => {
  it("阶段 0 只有中考是 supported —— 这是产品约定，改动必须让这个测试红", () => {
    const supported = GOAL_OPTIONS.filter((o) => o.supported).map((o) => o.code);
    expect(supported).toEqual(["zhongkao"]);
  });

  it("中考 → true", () => {
    expect(isGoalSupported("zhongkao")).toBe(true);
  });

  it("未收录的三个目标 → 全部 false（要如实告诉用户，不能假装支持）", () => {
    for (const code of ["gaokao", "cet4", "undecided"]) {
      expect(isGoalSupported(code)).toBe(false);
    }
  });

  it("未知 / 空 → false（默认不假装支持）", () => {
    expect(isGoalSupported("kaoyan")).toBe(false);
    expect(isGoalSupported(null)).toBe(false);
    expect(isGoalSupported(undefined)).toBe(false);
  });
});

describe("interestLabel", () => {
  it("已知 tag → 中文名", () => {
    expect(interestLabel("basketball")).toBe("篮球 / 足球");
  });

  it("未知 tag → 原样返回（不抛异常、不显示空白）", () => {
    expect(interestLabel("calligraphy")).toBe("calligraphy");
  });
});

describe("resolveInterest / 中英文名必须同源", () => {
  it("真实兴趣：中英各拿各的名字，标记为 personalized", () => {
    expect(resolveInterest("basketball")).toEqual({
      label: "篮球 / 足球",
      labelEn: "basketball and football",
      personalized: true,
    });
  });

  it("general（一个都没选）→ 两边都是通用话题，并且**如实标成没有个性**", () => {
    expect(resolveInterest(GENERIC_INTEREST_TAG)).toEqual({
      label: GENERIC_INTEREST_LABEL,
      labelEn: GENERIC_INTEREST_LABEL_EN,
      personalized: false,
    });
  });

  /**
   * 回归测试：这是那个"同一句话中英打架"的坑。
   * 认不出的 tag（老数据里已下线的 tag / 前端漏传）**必须两边一起回落**，
   * 而不是英文回落 everyday life、中文却把原样值印出来。
   */
  it("认不出的 tag → 中英一起回落兜底话题（不许一边回落一边原样）", () => {
    expect(resolveInterest("calligraphy")).toEqual({
      label: GENERIC_INTEREST_LABEL,
      labelEn: GENERIC_INTEREST_LABEL_EN,
      personalized: false,
    });
  });

  it("认得出的 tag 一律中英都取到（任何一个兴趣域都不许只给一半）", () => {
    for (const option of INTEREST_OPTIONS) {
      expect(resolveInterest(option.tag)).toEqual({
        label: option.label,
        labelEn: option.label_en,
        personalized: true,
      });
    }
  });
});

/**
 * 上限值写在这里是为了「改常量时被提醒」——
 * 它同时被界面文案用（"选 1~3 个"），不是随手改的数。
 */
describe("MAX_INTERESTS", () => {
  it("是 3（产品判断：一次只结合一个兴趣域才写得像，选太多等于泛泛而谈）", () => {
    expect(MAX_INTERESTS).toBe(3);
  });

  it("不超过可选项总数（否则上限永远达不到，文案会自相矛盾）", () => {
    expect(MAX_INTERESTS).toBeLessThanOrEqual(INTEREST_OPTIONS.length);
  });
});
