import { describe, expect, it } from "vitest";

import { pickProfile, type ProfileLike } from "./mergeProfile";

/** 只需要两个时间字段 —— 合并规则不该关心画像里别的业务字段 */
function profile(updatedAt: string | undefined, createdAt = "2026-01-01T00:00:00.000Z") {
  return { created_at: createdAt, updated_at: updatedAt } satisfies ProfileLike;
}

describe("pickProfile —— 两台设备各有一份画像，留哪一份", () => {
  it("两边都没有：返回 null", () => {
    expect(pickProfile(null, null)).toBeNull();
  });

  it("只有一边有：直接用那一边", () => {
    const remote = profile("2026-09-01T00:00:00.000Z");
    const local = profile("2026-09-02T00:00:00.000Z");
    expect(pickProfile(null, remote)).toBe(remote);
    expect(pickProfile(local, null)).toBe(local);
  });

  it("云端改得更晚：取云端那份", () => {
    const local = profile("2026-09-01T00:00:00.000Z");
    const remote = profile("2026-09-02T00:00:00.000Z");
    expect(pickProfile(local, remote)).toBe(remote);
  });

  it("本地改得更晚：取本地那份（本地的新改动不会被打回去）", () => {
    const local = profile("2026-09-03T00:00:00.000Z");
    const remote = profile("2026-09-02T00:00:00.000Z");
    expect(pickProfile(local, remote)).toBe(local);
  });

  it("时间戳一模一样：保留本地", () => {
    const local = profile("2026-09-02T00:00:00.000Z");
    const remote = profile("2026-09-02T00:00:00.000Z");
    expect(pickProfile(local, remote)).toBe(local);
  });

  it("缺 updated_at（阶段 0 的老画像）：回落到 created_at", () => {
    // 老画像：没有 updated_at，只有建号时间
    const legacy = profile(undefined, "2026-01-01T00:00:00.000Z");
    const edited = profile("2026-09-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(pickProfile(legacy, edited)).toBe(edited);
    expect(pickProfile(edited, legacy)).toBe(edited);
  });

  it("两边都缺 updated_at：比 created_at，不崩", () => {
    const older = profile(undefined, "2026-01-01T00:00:00.000Z");
    const newer = profile(undefined, "2026-06-01T00:00:00.000Z");
    expect(pickProfile(older, newer)).toBe(newer);
  });

  it("★ 不能退回用 created_at 做比较（那正是这个函数要避免的事）", () => {
    // 这份本地的 `created_at` 更早，但它是**后改过的**。
    // 若判据写成 created_at，这里会选云端 —— 用户最新的那次修改就白改了。
    const localEdited = profile("2026-09-09T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const remoteOriginal = profile("2026-02-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    expect(pickProfile(localEdited, remoteOriginal)).toBe(localEdited);
  });

  it("纯函数：不改动传进来的任何一份", () => {
    const local = profile("2026-09-01T00:00:00.000Z");
    const remote = profile("2026-09-05T00:00:00.000Z");
    const before = JSON.stringify({ local, remote });

    pickProfile(local, remote);

    expect(JSON.stringify({ local, remote })).toBe(before);
  });
});
