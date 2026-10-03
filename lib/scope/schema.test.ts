import { describe, expect, it } from "vitest";

import type { Unit, Volume } from "@/lib/db/types";
import {
  defaultScope,
  LIMITS,
  scopeForUnit,
  shortVolumeLabel,
  unitDisplayLabel,
  validateScope,
} from "@/lib/scope/schema";

describe("validateScope", () => {
  it("接受冷启动用的默认范围", () => {
    const result = validateScope(defaultScope());
    expect(result.ok).toBe(true);
  });

  it("拒绝 include 为空的范围", () => {
    const result = validateScope({ v: 1, include: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SCOPE");
  });

  it("拒绝白名单之外的 include 类型", () => {
    const result = validateScope({ v: 1, include: [{ type: "magic_scope" }] });
    expect(result.ok).toBe(false);
  });

  it("拒绝未知版本号", () => {
    const result = validateScope({ v: 99, include: [{ type: "curriculum_unit", units: ["u1"] }] });
    expect(result.ok).toBe(false);
  });

  it("limit / daily_cap 有硬上限（防止把全库导出来）", () => {
    const tooMany = validateScope({
      v: 1,
      include: [{ type: "curriculum_unit", units: ["u1"] }],
      limit: LIMITS.limit + 1,
    });
    const tooManyDaily = validateScope({
      v: 1,
      include: [{ type: "curriculum_unit", units: ["u1"] }],
      daily_cap: LIMITS.daily_cap + 1,
    });
    expect(tooMany.ok).toBe(false);
    expect(tooManyDaily.ok).toBe(false);
  });

  it("非法范围返回的是结构化错误，而不是抛异常", () => {
    const result = validateScope(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("选我的单元：单元 → 显示名 / 范围描述", () => {
  const volume: Volume = {
    id: "wys_2024:8A",
    curriculum_id: "wys_2024",
    grade_label: "八年级上册",
    grade_num: 8,
    term: "上",
    word_count: 244,
    status: "active",
  };
  const unit: Unit = {
    id: "wys_2024:8A:U1",
    volume_id: "wys_2024:8A",
    unit_no: 1,
    unit_code: "Unit 1",
    title_en: "This is me",
    title_zh: null,
    theme_tags: [],
    sort_order: 1,
    is_verified: true,
  };

  it("教材简称 = 中文数字 + 上下册（课本封面用的就是这个叫法）", () => {
    expect(shortVolumeLabel(volume)).toBe("八上");
    expect(shortVolumeLabel({ grade_num: 7, term: "下" })).toBe("七下");
  });

  it("单元显示名带上课本目录里印的英文标题（用户是照它找单元的）", () => {
    expect(unitDisplayLabel(volume, unit)).toBe("八上 Unit 1 · This is me");
  });

  it("没有英文标题时不留悬空的间隔号", () => {
    expect(unitDisplayLabel(volume, { unit_code: "Unit 2", title_en: "" })).toBe("八上 Unit 2");
  });

  it("scopeForUnit 产出的范围能通过校验，且 id 全部取自记录本身（不写死字面量）", () => {
    const scope = scopeForUnit(volume, unit);
    expect(validateScope(scope).ok).toBe(true);
    expect(scope.include[0]).toEqual({
      type: "curriculum_unit",
      curriculum: "wys_2024",
      volume: "wys_2024:8A",
      units: ["wys_2024:8A:U1"],
    });
  });

  it("默认单元走两条路要得到同一个范围（否则新用户会看到两套默认）", () => {
    // 这条是防漂移：defaultScope() 是种子 meta 的镜像，scopeForUnit() 由记录生成。
    // 换教材时两处必须一起改 —— 这个断言红了就是在提醒这件事。
    const viaUnit = scopeForUnit(volume, unit);
    const fallback = defaultScope();
    expect(viaUnit.label).toBe(fallback.label);
    expect(viaUnit.include[0]?.units).toEqual(fallback.include[0]?.units);
    expect(viaUnit.daily_cap).toBe(fallback.daily_cap);
  });
});
