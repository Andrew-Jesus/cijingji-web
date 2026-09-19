import { describe, expect, it } from "vitest";

import {
  GOAL_OPTIONS,
  INTEREST_OPTIONS,
  MAX_INTERESTS,
  MINUTE_OPTIONS,
  findGoal,
  interestLabel,
  isGoalSupported,
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
