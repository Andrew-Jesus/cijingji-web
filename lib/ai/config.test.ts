import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_FALLBACK,
  DEFAULT_BASE_PRIMARY,
  DEFAULT_MODEL_FALLBACK,
  DEFAULT_MODEL_PRIMARY,
  DEFAULT_TIMEOUT_MS,
  hasAnyProvider,
  resolveModelChain,
  resolveTimeoutMs,
} from "./config";

/**
 * 这些测试钉住的是**降级链的形状**，不是具体是哪家模型：
 * 换供应商、换模型名都不该让它们变红，但"缺 Key 应该跳过而不是抛错"这条必须一直是绿的。
 */
describe("resolveModelChain / 缺 Key 就跳过，不抛错", () => {
  it("一个 Key 都没配 → 空链（开发机上不配 Key 也该能跑通全流程）", () => {
    expect(resolveModelChain({})).toEqual([]);
    expect(hasAnyProvider({})).toBe(false);
  });

  it("只有主模型的 Key → 只有一档", () => {
    const chain = resolveModelChain({ DEEPSEEK_API_KEY: "sk-test" });
    expect(chain).toHaveLength(1);
    expect(chain[0].model).toBe(DEFAULT_MODEL_PRIMARY);
    expect(chain[0].baseUrl).toBe(DEFAULT_BASE_PRIMARY);
    expect(chain[0].free).toBe(false);
  });

  it("只有兜底的 Key → 只有一档（这时它其实是主档，不该被标成降级）", () => {
    const chain = resolveModelChain({ GLM_API_KEY: "glm-test" });
    expect(chain).toHaveLength(1);
    expect(chain[0].model).toBe(DEFAULT_MODEL_FALLBACK);
    expect(chain[0].free).toBe(true);
  });

  it("两个都配 → 主在前、兜底在后（降级链的顺序就是数组顺序）", () => {
    const chain = resolveModelChain({ DEEPSEEK_API_KEY: "a", GLM_API_KEY: "b" });
    expect(chain.map((c) => c.model)).toEqual([DEFAULT_MODEL_PRIMARY, DEFAULT_MODEL_FALLBACK]);
  });

  it("空白 Key（填了但没值）也算没配 —— 避免「配了却一直降级」这种假象", () => {
    expect(resolveModelChain({ DEEPSEEK_API_KEY: "   " })).toEqual([]);
  });

  it("模型名与端点可以由环境变量覆盖（代码里不写死模型名）", () => {
    const chain = resolveModelChain({
      DEEPSEEK_API_KEY: "a",
      AI_MODEL_PRIMARY: "some-new-flash",
      AI_BASE_PRIMARY: "https://example.com/v1/",
    });
    expect(chain[0].model).toBe("some-new-flash");
    // 末尾斜杠要去掉，否则拼出来是 //chat/completions
    expect(chain[0].baseUrl).toBe("https://example.com/v1");
  });

  it("兜底的端点默认值也能被覆盖", () => {
    const chain = resolveModelChain({ GLM_API_KEY: "b", AI_BASE_FALLBACK: "https://x.test/api" });
    expect(chain[0].baseUrl).toBe("https://x.test/api");
  });

  it("没覆盖时用默认端点", () => {
    expect(resolveModelChain({ GLM_API_KEY: "b" })[0].baseUrl).toBe(DEFAULT_BASE_FALLBACK);
  });
});

describe("resolveTimeoutMs", () => {
  it("默认 12 秒", () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("可以用环境变量改", () => {
    expect(resolveTimeoutMs({ AI_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  it("乱填的值回落到默认值（不抛错崩页面）", () => {
    expect(resolveTimeoutMs({ AI_TIMEOUT_MS: "abc" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ AI_TIMEOUT_MS: "-1" })).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("上限 60 秒 —— 更长的等待没有意义，用户早就走了", () => {
    expect(resolveTimeoutMs({ AI_TIMEOUT_MS: "600000" })).toBe(60_000);
  });
});
