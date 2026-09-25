import { describe, expect, it } from "vitest";

import { ProviderError } from "./provider";
import { createCooldownStore, decideAfterFailure, type FailureContext } from "./retry";

/**
 * 这里钉的是**"GLM 每次都失败"那个 bug 的修法**。
 *
 * 复盘一遍病灶，免得以后有人把退避"优化"掉：
 *   免费档并发只有 1；我们超时后**立刻重发**，而对方服务器上第一次还在跑
 *   → 第二次一出门就被 429 拒掉。所以下面两条必须一直是绿的：
 *   ① 撞限流（429）时，**只要还有别的档就换档**，不要在同一档上硬碰；
 *   ② 余额不足 / Key 错这类死症，要**打冷却**（否则每次请求都白等一轮）。
 */
const ctx = (over: Partial<FailureContext> = {}): FailureContext => ({
  attemptIndex: 0,
  attemptsPerModel: 2,
  hasNextProvider: true,
  ...over,
});

const httpError = (status: number) => new ProviderError("http", `HTTP ${status}`, status);

describe("decideAfterFailure / 换档还是重试", () => {
  it("撞限流（429）且还有下一档 → 换档，不在同一档上硬碰", () => {
    expect(decideAfterFailure(httpError(429), ctx())).toEqual({
      action: "next_provider",
      coolDown: false,
    });
  });

  it("撞限流但它已经是最后一档 → 退避后再试一次（否则这一句就彻底丢了）", () => {
    expect(decideAfterFailure(httpError(429), ctx({ hasNextProvider: false }))).toEqual({
      action: "retry_same",
      coolDown: false,
    });
  });

  it("最后一档撞限流且次数已用尽 → 只能换档（也就是认了，走兜底）", () => {
    expect(
      decideAfterFailure(httpError(429), ctx({ hasNextProvider: false, attemptIndex: 1 })),
    ).toEqual({ action: "next_provider", coolDown: false });
  });

  it("余额不足（402）→ 换档 + **打冷却**（几分钟内试一百次也一样，别白等）", () => {
    expect(decideAfterFailure(httpError(402), ctx())).toEqual({
      action: "next_provider",
      coolDown: true,
    });
  });

  it("Key 不对（401/403）→ 同样换档 + 打冷却", () => {
    for (const s of [401, 403]) {
      expect(decideAfterFailure(httpError(s), ctx())).toEqual({
        action: "next_provider",
        coolDown: true,
      });
    }
  });

  it("超时/断网 → 还有次数就退避重试（这是最常见的临时故障）", () => {
    for (const err of [
      new ProviderError("timeout", "请求超时", null),
      new ProviderError("network", "连不上", null),
    ]) {
      expect(decideAfterFailure(err, ctx())).toEqual({ action: "retry_same", coolDown: false });
    }
  });

  it("上游 5xx → 退避重试", () => {
    expect(decideAfterFailure(httpError(503), ctx())).toEqual({
      action: "retry_same",
      coolDown: false,
    });
  });

  it("次数用尽 → 换档（不许无限重试烧钱）", () => {
    expect(decideAfterFailure(httpError(503), ctx({ attemptIndex: 1 }))).toEqual({
      action: "next_provider",
      coolDown: false,
    });
  });

  it("请求本身不合法（400）→ 换档且不冷却（换个模型有可能能成功）", () => {
    expect(decideAfterFailure(httpError(400), ctx())).toEqual({
      action: "next_provider",
      coolDown: false,
    });
  });

  it("不认识的异常 → 当成临时故障，还有次数就再试一次", () => {
    expect(decideAfterFailure(new Error("说不清"), ctx())).toEqual({
      action: "retry_same",
      coolDown: false,
    });
  });

  it("冷却只给「死症」，不给限流和超时 —— 给临时故障打冷却会误伤", () => {
    for (const err of [
      httpError(429),
      httpError(500),
      new ProviderError("timeout", "超时", null),
      new ProviderError("network", "断网", null),
      new ProviderError("malformed", "不是 JSON", null),
    ]) {
      expect(decideAfterFailure(err, ctx()).coolDown).toBe(false);
    }
  });
});

describe("冷却表", () => {
  it("没冻过 → 不冷却", () => {
    expect(createCooldownStore().isCooling("glm", 1000)).toBe(false);
  });

  it("冻上之后 → 在期间内冷却，过了就自动解冻", () => {
    const store = createCooldownStore();
    store.cool("glm", 5000, 1000);
    expect(store.isCooling("glm", 1000)).toBe(true);
    expect(store.isCooling("glm", 5999)).toBe(true);
    expect(store.isCooling("glm", 6000)).toBe(false);
  });

  it("解冻之后能查到「已经解冻」（别让这张表只涨不消）", () => {
    const store = createCooldownStore();
    store.cool("glm", 1000, 0);
    expect(store.isCooling("glm", 5000)).toBe(false);
    expect(store.until("glm")).toBeNull();
  });

  it("各档互不干扰 —— GLM 冻了不该连累 DeepSeek", () => {
    const store = createCooldownStore();
    store.cool("glm", 5000, 0);
    expect(store.isCooling("glm", 100)).toBe(true);
    expect(store.isCooling("deepseek", 100)).toBe(false);
  });

  it("reset / clear 能立刻恢复（测试之间要靠它隔离）", () => {
    const store = createCooldownStore();
    store.cool("glm", 5000, 0);
    store.clear("glm");
    expect(store.isCooling("glm", 0)).toBe(false);
    store.cool("glm", 5000, 0);
    store.reset();
    expect(store.isCooling("glm", 0)).toBe(false);
  });
});
