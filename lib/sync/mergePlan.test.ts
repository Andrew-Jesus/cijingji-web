import { describe, expect, it } from "vitest";

import { pickPlan, type PlanLike } from "./mergePlan";

/** 造一份"像任务单"的东西。只需要 status 与 items —— 合并规则不该关心别的字段。 */
function plan(status: string, wordCount: number, extra: Record<string, unknown> = {}): PlanLike {
  return {
    status,
    items: Array.from({ length: wordCount }, (_, i) => ({ word_id: `w${i}` })),
    ...extra,
  };
}

describe("pickPlan —— 同一天两份任务单，留哪一份", () => {
  it("两边都没有：返回 null", () => {
    expect(pickPlan(null, null)).toBeNull();
  });

  it("只有云端有（新设备第一次登录）：取云端那份", () => {
    const remote = plan("in_progress", 8);
    expect(pickPlan(null, remote)).toBe(remote);
  });

  it("只有本地有（本地新排了一份）：取本地那份", () => {
    const local = plan("pending", 24);
    expect(pickPlan(local, null)).toBe(local);
  });

  it("★ 命门场景：电脑刚排的空单 不该把手机上做到一半的进度打回原点", () => {
    // 真实发生的样子：
    //   手机：`in_progress`，今天排了 20 个词，已经做了 8 个
    //   电脑：刚打开首页顺手续排了一份 `pending`，**词更多（24 个）、时间也更晚**
    // 如果规则写成"取时间更新的那份"，这里就会选电脑那份 ——
    // 用户回到手机上发现自己做到一半的进度没了，看到的是一个还没开始的列表。
    const phone = plan("in_progress", 20);
    const computer = plan("pending", 24, { generated_at: "2099-01-01T00:00:00.000Z" });

    expect(pickPlan(phone, computer)).toBe(phone);
    // 反着传也一样 —— 规则看的是"内容"而不是"谁在左边"
    expect(pickPlan(computer, phone)).toBe(phone);
  });

  it("进度名次：done > in_progress > pending > skipped", () => {
    const done = plan("done", 5);
    const doing = plan("in_progress", 5);
    const pending = plan("pending", 5);
    const skipped = plan("skipped", 5);

    expect(pickPlan(doing, done)).toBe(done);
    expect(pickPlan(pending, doing)).toBe(doing);
    expect(pickPlan(skipped, pending)).toBe(pending);

    // 跳过的也要能反过来被判负，而不是因为它"在后面"就永远输
    expect(pickPlan(skipped, done)).toBe(done);
  });

  it("进度名次更高时，**不需要**词数也更多", () => {
    // 手机上做了 3 个（in_progress、只排了 3 个词），电脑上排了 30 个还没开工（pending）
    const phone = plan("in_progress", 3);
    const computer = plan("pending", 30);
    expect(pickPlan(computer, phone)).toBe(phone);
  });

  it("名次相同时：取词数更多的那份", () => {
    const fewer = plan("in_progress", 5);
    const more = plan("in_progress", 12);
    expect(pickPlan(fewer, more)).toBe(more);
    expect(pickPlan(more, fewer)).toBe(more);
  });

  it("名次、词数都相同时：保留本地（用户此刻正用着这台）", () => {
    const local = plan("pending", 20);
    const remote = plan("pending", 20);
    // 用引用相等来判断"到底返回了哪一个" —— 比逐个字段比更严格
    expect(pickPlan(local, remote)).toBe(local);
  });

  it("没见过的状态值：按最低名次算，输给一切已知状态", () => {
    const weird = plan("reviewing", 50);
    const pending = plan("pending", 1);
    expect(pickPlan(weird, pending)).toBe(pending);
  });

  it("两边都是没见过的状态：退回比词数，不崩", () => {
    const a = plan("weird-a", 3);
    const b = plan("weird-b", 9);
    expect(pickPlan(a, b)).toBe(b);
  });

  it("纯函数：不改动传进来的任何一份", () => {
    const local = plan("pending", 2);
    const remote = plan("done", 1);
    const localSnapshot = JSON.stringify(local);
    const remoteSnapshot = JSON.stringify(remote);

    pickPlan(local, remote);

    expect(JSON.stringify(local)).toBe(localSnapshot);
    expect(JSON.stringify(remote)).toBe(remoteSnapshot);
  });

  it("空词的 pending 单 与 有词的 pending 单：取有词的那份", () => {
    // 电脑上误触生成了空单子（0 个词），手机上有一份正常的
    const empty = plan("pending", 0);
    const normal = plan("pending", 20);
    expect(pickPlan(empty, normal)).toBe(normal);
  });
});
