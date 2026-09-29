import { describe, expect, it } from "vitest";

import { MAX_OUTPUT_TOKENS, resolveModelChain } from "./config";
import { buildRequestBody } from "./provider";

/**
 * 为什么专门给"拼请求体"写一组测试：
 *
 * 2026-09-29 的事故复盘里最险的一步，是把 DeepSeek 的「关闭思考」写成了
 * `reasoning_effort: "none"` —— 那是个**不存在的取值**（官方参数表里
 * `reasoning_effort` 只有 low/high/max，`none` 属于另一套接口格式）。
 *
 * 这类错误的可怕之处在于：**类型检查、lint、本地跑都不会说一个字**，
 * 只有线上真发出去才知道 —— 而那时症状是"这一档失败"，
 * 从日志上看和"模型抽风"长得一模一样，根本查不出是参数写错了。
 *
 * 所以这里把"每家该发哪个字段"钉死。
 */

const MESSAGES = [
  { role: "system" as const, content: "只回 JSON" },
  { role: "user" as const, content: "用 accordion 写一句" },
];

function bodyFor(provider: "deepseek" | "glm"): Record<string, unknown> {
  const chain = resolveModelChain("cheap", { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" });
  const spec = chain.find((c) => c.provider === provider);
  if (!spec) throw new Error(`链路里没有 ${provider}`);
  return buildRequestBody(spec, MESSAGES, { timeoutMs: 12_000 });
}

describe("buildRequestBody：按档拼请求体", () => {
  it("DeepSeek 关思考走 `thinking:{type:disabled}`，且**不许**出现 reasoning_effort", () => {
    const body = bodyFor("deepseek");
    expect(body.thinking).toEqual({ type: "disabled" });
    // 回归钉子：`reasoning_effort: "none"` 是非法值，会被 400 拒收、整档打废。
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("GLM-5.3 关不掉思考，只能 `reasoning_effort: low`，且**不许**出现 thinking", () => {
    // 官方文档：GLM-5.3 系列的 thinking.type 只认 enabled，传 disabled 直接报错。
    const body = bodyFor("glm");
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("thinking");
  });

  it("输出预算按档带下来：关得掉思考的 180 就够，关不掉的必须放宽（否则正文返回空）", () => {
    expect(bodyFor("deepseek").max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(bodyFor("glm").max_tokens).toBeGreaterThan(MAX_OUTPUT_TOKENS * 5);
  });

  it("其余字段照旧：模型名 / JSON 模式 / 不流式 / 默认温度", () => {
    const body = bodyFor("deepseek");
    expect(body.model).toBe("deepseek-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.7);
  });

  it("调用处显式传了 maxTokens / temperature 时以它为准（覆盖逻辑别写丢）", () => {
    const chain = resolveModelChain("cheap", { DEEPSEEK_API_KEY: "d" });
    const body = buildRequestBody(chain[0], MESSAGES, {
      timeoutMs: 12_000,
      maxTokens: 64,
      temperature: 0.2,
    });
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.2);
  });
});
