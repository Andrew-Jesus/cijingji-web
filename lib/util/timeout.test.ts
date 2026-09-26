import { describe, expect, it } from "vitest";

import { withTimeout } from "./timeout";

/**
 * 这个函数只有一个职责：**别让人无限等下去**。
 * 所以断言的重点不是"它成功时返回什么"，而是"它失败时到底会不会回来"。
 */
describe("withTimeout", () => {
  it("没超时就照原样拿到结果", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("超时就 reject，并说清等了多少毫秒", async () => {
    // 一个永远不落地的 Promise —— 现实里就是"断网了，请求静静挂着"
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10)).rejects.toThrow("10");
  });

  it("原来的 Promise 先失败就照原样抛出那个错，不要被改写成超时", async () => {
    await expect(withTimeout(Promise.reject(new Error("连不上")), 1000)).rejects.toThrow("连不上");
  });

  it("预算是 0 或负数 = 不设上限，直接透传（不要立刻炸）", async () => {
    const never = new Promise<string>(() => {});
    const winner = await Promise.race([
      withTimeout(never, 0).then(
        () => "settled",
        () => "settled",
      ),
      Promise.resolve("still-pending"),
    ]);
    // 同一个 tick 里它必须还没动静 —— 说明没被装上"立刻触发"的定时器
    expect(winner).toBe("still-pending");
  });
});
