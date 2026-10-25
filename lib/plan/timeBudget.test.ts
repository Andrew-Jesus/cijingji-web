import { describe, expect, it } from "vitest";

import {
  BUDGET_TIER_MINUTES,
  CUSTOM_MINUTE_MAX,
  CUSTOM_MINUTE_MIN,
  budgetLabel,
  clampMinutes,
  isTierMinutes,
  nearestTier,
  parseStoredBudget,
  serializeBudget,
  suggestMinutes,
} from "@/lib/plan/timeBudget";

describe("clampMinutes —— 任何脏输入都得收成能用的分钟数", () => {
  it("正常值原样返回，小数四舍五入", () => {
    expect(clampMinutes(12)).toBe(12);
    expect(clampMinutes(12.4)).toBe(12);
    expect(clampMinutes(12.6)).toBe(13);
  });

  it("越界收回区间两端", () => {
    expect(clampMinutes(0)).toBe(CUSTOM_MINUTE_MIN);
    expect(clampMinutes(-5)).toBe(CUSTOM_MINUTE_MIN);
    expect(clampMinutes(999)).toBe(CUSTOM_MINUTE_MAX);
  });

  it("★ 非数字兜底 10 分钟 —— 不是 1：把用户按在最低档，他会以为软件坏了", () => {
    expect(clampMinutes(Number.NaN)).toBe(10);
    expect(clampMinutes(Number.POSITIVE_INFINITY)).toBe(10);
  });
});

describe("isTierMinutes —— 界面靠它决定高亮哪个挡位", () => {
  it("四个预设挡位都认出来", () => {
    for (const m of BUDGET_TIER_MINUTES) expect(isTierMinutes(m)).toBe(true);
  });

  it("自定义值不算挡位", () => {
    expect(isTierMinutes(7)).toBe(false);
    expect(isTierMinutes(0)).toBe(false);
  });
});

describe("nearestTier —— 画像分钟数落到哪个挡位", () => {
  it("正好等于挡位时原样返回", () => {
    expect(nearestTier(3)).toBe(3);
    expect(nearestTier(10)).toBe(10);
    expect(nearestTier(20)).toBe(20);
  });

  it("取最近的", () => {
    expect(nearestTier(7)).toBe(5); // |7-5|=2 < |7-10|=3
    expect(nearestTier(8)).toBe(10); // |8-10|=2 < |8-5|=3
    expect(nearestTier(30)).toBe(20);
    expect(nearestTier(2)).toBe(3);
  });

  it("★ 距离相同取更小的 —— 少给几个词他会自己点大一档，多给会让他练到一半退出", () => {
    expect(nearestTier(4)).toBe(3); // 与 5 同距
  });

  it("0 / 负数 / 非数字 → 10 分钟那一档", () => {
    expect(nearestTier(0)).toBe(10);
    expect(nearestTier(-3)).toBe(10);
    expect(nearestTier(Number.NaN)).toBe(10);
  });
});

describe("suggestMinutes —— 打开就用，永不阻塞", () => {
  const base = { profileMinutes: 10 };

  it("★ 上次选过的永远优先（不因为换了时段就偷偷改掉用户的设置）", () => {
    expect(suggestMinutes({ ...base, lastUsed: 20 })).toBe(20);
    expect(suggestMinutes({ ...base, lastUsed: 3 })).toBe(3);
    expect(suggestMinutes({ ...base, lastUsed: 15 })).toBe(15);
  });

  it("上次的值是脏数据 → 当作没选过，回落到画像", () => {
    expect(suggestMinutes({ ...base, lastUsed: 0 })).toBe(10);
    expect(suggestMinutes({ ...base, lastUsed: -3 })).toBe(10);
    expect(suggestMinutes({ ...base, lastUsed: Number.NaN })).toBe(10);
  });

  it("★ 从没选过 → 用他引导里答的分钟数，落到最近的挡位", () => {
    expect(suggestMinutes({ profileMinutes: 10, lastUsed: null })).toBe(10);
    expect(suggestMinutes({ profileMinutes: 30, lastUsed: null })).toBe(20);
    expect(suggestMinutes({ profileMinutes: 2, lastUsed: null })).toBe(3);
  });

  it("★ 不做时段推断 —— 否则首页会和「引导结果页刚说的每天多少」当场打架", () => {
    // 同一个画像，不管什么时候问，答案必须一样（这个函数现在根本收不到钟点）
    const once = suggestMinutes({ profileMinutes: 10, lastUsed: null });
    expect(once).toBe(10);
  });

  it("★ 任何输入都落在合法区间里（不会因为脏画像给出 0 分钟 → 排 0 个词）", () => {
    for (const profileMinutes of [0, -1, 999, Number.NaN]) {
      for (const lastUsed of [null, 0, Number.NaN, 200]) {
        const m = suggestMinutes({ profileMinutes, lastUsed });
        expect(m).toBeGreaterThanOrEqual(CUSTOM_MINUTE_MIN);
        expect(m).toBeLessThanOrEqual(CUSTOM_MINUTE_MAX);
      }
    }
  });
});

describe("parseStoredBudget —— 读盘失败的兜底（最容易被漏测的一段）", () => {
  it("没存过 → null（走建议值）", () => {
    expect(parseStoredBudget(null)).toBeNull();
    expect(parseStoredBudget("")).toBeNull();
  });

  it("不是 JSON / 不是对象 / 字段类型不对 → null", () => {
    expect(parseStoredBudget("not json")).toBeNull();
    expect(parseStoredBudget("123")).toBeNull();
    expect(parseStoredBudget("[1,2]")).toBeNull();
    expect(parseStoredBudget('"x"')).toBeNull();
    expect(parseStoredBudget('{"minutes":"12"}')).toBeNull();
    expect(parseStoredBudget("{}")).toBeNull();
  });

  it("★ 存了 0 或负数 → 当没选过（不是夹到 1 分钟）", () => {
    expect(parseStoredBudget('{"minutes":0}')).toBeNull();
    expect(parseStoredBudget('{"minutes":-5}')).toBeNull();
  });

  it("正常值读回来", () => {
    expect(parseStoredBudget('{"minutes":12}')).toBe(12);
  });

  it("超过上限 → 夹到上限（不当作没选过）", () => {
    expect(parseStoredBudget('{"minutes":999}')).toBe(CUSTOM_MINUTE_MAX);
  });
});

describe("serializeBudget 与 parseStoredBudget 必须成对", () => {
  it("★ 写进去再读出来是同一个数（一边改一边不改 = 用户的设置静默丢失）", () => {
    for (const m of [...BUDGET_TIER_MINUTES, 1, 7, 13, 60]) {
      expect(parseStoredBudget(serializeBudget(m))).toBe(m);
    }
  });

  it("写入前也会夹一次，不会把脏值落盘", () => {
    expect(parseStoredBudget(serializeBudget(999))).toBe(CUSTOM_MINUTE_MAX);
    expect(parseStoredBudget(serializeBudget(Number.NaN))).toBe(10);
  });
});

describe("budgetLabel", () => {
  it("界面叫法统一", () => {
    expect(budgetLabel(10)).toBe("10 分钟");
  });
});
