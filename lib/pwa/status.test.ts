import { describe, expect, it } from "vitest";

import type { OfflineSnapshot } from "@/lib/console/probe";
import { offlineLabel } from "@/lib/pwa/status";

const snapshot = (patch: Partial<OfflineSnapshot>): OfflineSnapshot => ({
  supported: true,
  registered: true,
  controlled: true,
  cacheVersion: "1a2b3c4",
  ...patch,
});

describe("门房状态 → 人话", () => {
  it("还没读到就说还在读，别先报一个假的", () => {
    expect(offlineLabel(null)).toBe("检测中…");
    expect(offlineLabel(undefined)).toBe("检测中…");
  });

  it("浏览器不支持时直说 —— 这不是故障，是这类浏览器没有这个能力", () => {
    expect(offlineLabel(snapshot({ supported: false }))).toBe("浏览器不支持");
  });

  it("登记失败 / 开发环境（不注册）都显示「未启用」", () => {
    expect(offlineLabel(snapshot({ registered: false }))).toBe("未启用");
  });

  it("★ 登记了但还没接管 —— 必须说清「再打开一次就好」，否则会被当成坏了", () => {
    expect(offlineLabel(snapshot({ controlled: false }))).toBe(
      "已登记 · 再打开一次即可接管",
    );
  });

  it("已接管时显示正在用的缓存版本（排查时就靠它认「是不是新那一版」）", () => {
    expect(offlineLabel(snapshot({}))).toBe("已接管 · 1a2b3c4");
  });

  it("接管了但缓存名读不出来（非安全上下文）—— 别显示「已接管 · null」", () => {
    expect(offlineLabel(snapshot({ cacheVersion: null }))).toBe("已接管 · 暂无缓存");
  });
});
