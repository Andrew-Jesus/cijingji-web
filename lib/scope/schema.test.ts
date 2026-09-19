import { describe, expect, it } from "vitest";

import { defaultScope, validateScope, LIMITS } from "@/lib/scope/schema";

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
