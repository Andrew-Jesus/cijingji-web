import { describe, expect, it } from "vitest";

import { EXAMPLE_MIN_SHOW_MS, examplePacingDelayMs } from "./examplePacing";

/**
 * 例句的展示节拍。
 *
 * 这一组断言守的是一件**体验产品决策**，不是算术：
 * "提前写"让例句常常 0 毫秒就绪，直接端上去会一闪而过、显得敷衍。
 * 所以这里钉住"不管多快，都至少演满 1 秒"。
 */
describe("examplePacingDelayMs / 例句的最短演出", () => {
  it("缓存命中（几乎没花时间）→ 补足到最短时长", () => {
    expect(examplePacingDelayMs(5)).toBe(EXAMPLE_MIN_SHOW_MS - 5);
  });

  it("真实耗时已经超过下限 → 不再额外等（下限是保底，不是加法）", () => {
    // 这条最容易被写错成 minShow + elapsed —— 那会让慢的请求更慢
    expect(examplePacingDelayMs(2600)).toBe(0);
    expect(examplePacingDelayMs(EXAMPLE_MIN_SHOW_MS + 1)).toBe(0);
  });

  it("正好等于下限 → 不多等一毫秒", () => {
    expect(examplePacingDelayMs(EXAMPLE_MIN_SHOW_MS)).toBe(0);
  });

  it("下限就是 1 秒 —— 动这个数之前先想清楚为什么", () => {
    // 它决定"AI 写句子"这件事看起来有多认真：
    //   改成 0     → 句子一闪而过，用户觉得根本没在写
    //   改成 3000+ → 就变成真的在浪费用户时间了
    expect(EXAMPLE_MIN_SHOW_MS).toBe(1000);
  });

  it("脏输入一律按「不用等」处理 —— 失败方向必须是不拖慢用户", () => {
    expect(examplePacingDelayMs(Number.NaN)).toBe(0);
    expect(examplePacingDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(examplePacingDelayMs(-100)).toBe(0);
    expect(examplePacingDelayMs(10, Number.NaN)).toBe(0);
  });

  it("下限可以传更小的值（测试或特殊场景留的口子）", () => {
    expect(examplePacingDelayMs(200, 400)).toBe(200);
    expect(examplePacingDelayMs(500, 400)).toBe(0);
  });
});
