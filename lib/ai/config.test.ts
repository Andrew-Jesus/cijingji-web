import { describe, expect, it } from "vitest";

import {
  AI_TASK_TIER,
  AI_TASKS,
  backoffMs,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  MIN_ATTEMPT_MS,
  PROVIDERS,
  resolveCooldownMs,
  resolveModelChain,
  resolveModelChainForTask,
  resolveRetryBackoffMs,
  resolveTimeoutMs,
  resolveTotalBudgetMs,
  TIER_ORDER,
  hasAnyProvider,
} from "./config";

/**
 * 这些测试钉住的是**降级链的形状与分档规则**，不是具体是哪家模型：
 * 换供应商、换模型名都不该让它们变红，但下面两条必须一直是绿的 ——
 *   ① "缺 Key 应该跳过而不是抛错"；
 *   ② "例句这种轻活走免费档打头"（2026-09-25 的成本决策，别被悄悄改回去）。
 */
describe("resolveModelChain / 缺 Key 就跳过，不抛错", () => {
  it("一个 Key 都没配 → 空链（开发机上不配 Key 也该能跑通全流程）", () => {
    expect(resolveModelChain("cheap", {})).toEqual([]);
    expect(hasAnyProvider({})).toBe(false);
  });

  it("只配了免费的 GLM → 只有一档，且它就是这条链的首选", () => {
    const chain = resolveModelChain("cheap", { GLM_API_KEY: "glm-test" });
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe("glm");
    expect(chain[0].model).toBe(PROVIDERS.glm.defaultModel);
    expect(chain[0].baseUrl).toBe(PROVIDERS.glm.defaultBase);
    expect(chain[0].free).toBe(true);
  });

  it("只配了 DeepSeek → 只有一档（这时它才是首选，不该被标成降级）", () => {
    const chain = resolveModelChain("cheap", { DEEPSEEK_API_KEY: "sk-test" });
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe("deepseek");
    expect(chain[0].model).toBe(PROVIDERS.deepseek.defaultModel);
    expect(chain[0].free).toBe(false);
  });

  it("空白 Key（填了但没值）也算没配 —— 避免「配了却一直降级」这种假象", () => {
    expect(resolveModelChain("cheap", { DEEPSEEK_API_KEY: "   " })).toEqual([]);
    expect(resolveModelChain("cheap", { GLM_API_KEY: "" })).toEqual([]);
  });

  it("模型名与端点可以由环境变量覆盖（代码里不写死模型名）", () => {
    const chain = resolveModelChain("cheap", {
      GLM_API_KEY: "g",
      AI_MODEL_GLM: "glm-4.7-flashX",
      AI_BASE_GLM: "https://example.com/v1/",
    });
    expect(chain[0].model).toBe("glm-4.7-flashX");
    // 末尾斜杠要去掉，否则拼出来是 //chat/completions
    expect(chain[0].baseUrl).toBe("https://example.com/v1");
  });

  it("没覆盖时用登记表里的默认端点", () => {
    expect(resolveModelChain("standard", { DEEPSEEK_API_KEY: "d" })[0].baseUrl).toBe(
      PROVIDERS.deepseek.defaultBase,
    );
  });
});

describe("分档路由 / 谁排前面是产品决策，必须钉住", () => {
  const both = { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" };

  it("cheap 档：**免费档打头，付费的垫底**（例句就属于这一档）", () => {
    expect(resolveModelChain("cheap", both).map((c) => c.provider)).toEqual(["glm", "deepseek"]);
  });

  it("standard 档：付费的 DeepSeek 打头，GLM 兜底", () => {
    expect(resolveModelChain("standard", both).map((c) => c.provider)).toEqual([
      "deepseek",
      "glm",
    ]);
  });

  it("例句任务落在 cheap 档 —— 这条挂了就说明成本结构被改动了，先来看这张表再改测试", () => {
    expect(AI_TASK_TIER.example_personalized).toBe("cheap");
    expect(resolveModelChainForTask("example_personalized", both).map((c) => c.provider)).toEqual([
      "glm",
      "deepseek",
    ]);
  });

  it("每个任务都有档位（新增任务忘了登记会在这里报错）", () => {
    for (const t of AI_TASKS) {
      expect(TIER_ORDER[AI_TASK_TIER[t]]).toBeDefined();
    }
  });

  it("档位表里引用的每一家都真的登记过（防手滑写错 id）", () => {
    for (const order of Object.values(TIER_ORDER)) {
      for (const id of order) {
        expect(PROVIDERS[id]).toBeDefined();
      }
    }
  });

  it("每一档都至少排了一家，且不重复（同一家在一档里出现两次没有意义）", () => {
    for (const order of Object.values(TIER_ORDER)) {
      expect(order.length).toBeGreaterThan(0);
      expect(new Set(order).size).toBe(order.length);
    }
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

describe("resolveTotalBudgetMs / 整条链的总预算", () => {
  it("默认 20 秒（没有它，最坏情况是 2 档 × 2 次 × 12 秒 = 48 秒）", () => {
    expect(resolveTotalBudgetMs({})).toBe(DEFAULT_TOTAL_BUDGET_MS);
  });

  it("预算不得小于单档超时 —— 否则第一档都开不了", () => {
    expect(resolveTotalBudgetMs({ AI_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  it("乱填回落默认，且上限封在 120 秒", () => {
    expect(resolveTotalBudgetMs({ AI_TOTAL_BUDGET_MS: "abc" })).toBe(DEFAULT_TOTAL_BUDGET_MS);
    expect(resolveTotalBudgetMs({ AI_TOTAL_BUDGET_MS: "999999999" })).toBe(120_000);
  });

  it("最短一次尝试的门槛比默认单档超时小（否则预算永远拦不住任何一次尝试）", () => {
    expect(MIN_ATTEMPT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
  });
});

describe("退避与冷却的参数", () => {
  it("退避默认 1.2 秒，可覆盖", () => {
    expect(resolveRetryBackoffMs({})).toBe(DEFAULT_RETRY_BACKOFF_MS);
    expect(resolveRetryBackoffMs({ AI_RETRY_BACKOFF_MS: "2500" })).toBe(2500);
  });

  it("冷却默认 5 分钟，可覆盖；乱填回落默认", () => {
    expect(resolveCooldownMs({})).toBe(DEFAULT_COOLDOWN_MS);
    expect(resolveCooldownMs({ AI_COOLDOWN_MS: "1000" })).toBe(1000);
    expect(resolveCooldownMs({ AI_COOLDOWN_MS: "0" })).toBe(DEFAULT_COOLDOWN_MS);
  });

  it("退避线性递增：第 1 次等 1 倍，第 2 次等 2 倍", () => {
    expect(backoffMs(0, 1200)).toBe(1200);
    expect(backoffMs(1, 1200)).toBe(2400);
  });

  it("退避基数填成负数不会等出负数（负数 setTimeout 会变成立刻执行，很隐蔽）", () => {
    expect(backoffMs(0, -5)).toBe(0);
  });
});
