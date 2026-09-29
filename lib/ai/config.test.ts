import { describe, expect, it } from "vitest";

import {
  AI_TASK_TIER,
  AI_TASKS,
  backoffMs,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  FREE_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MIN_ATTEMPT_MS,
  PROVIDERS,
  resolveCooldownMs,
  resolveModelChain,
  resolveModelChainForTask,
  resolveRetryBackoffMs,
  resolveTimeoutMs,
  resolveTimeoutMsFor,
  resolveTotalBudgetMs,
  TIER_ORDER,
  hasAnyProvider,
} from "./config";

/**
 * 这些测试钉住的是**降级链的形状与顺序规则**，不是具体是哪家模型：
 * 换供应商、换模型名都不该让它们变红，但下面两条必须一直是绿的 ——
 *   ① "缺 Key 应该跳过而不是抛错"；
 *   ② "DeepSeek 打头、GLM 兜底"（2026-09-25 的可用性决策，别被悄悄改回去）。
 */
describe("resolveModelChain / 缺 Key 就跳过，不抛错", () => {
  it("一个 Key 都没配 → 空链（开发机上不配 Key 也该能跑通全流程）", () => {
    expect(resolveModelChain("cheap", {})).toEqual([]);
    expect(hasAnyProvider({})).toBe(false);
  });

  it("只配了 GLM → 只有一档，且它就是这条链的首选（不该被误标成降级）", () => {
    const chain = resolveModelChain("cheap", { GLM_API_KEY: "glm-test" });
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe("glm");
    expect(chain[0].model).toBe(PROVIDERS.glm.defaultModel);
    expect(chain[0].baseUrl).toBe(PROVIDERS.glm.defaultBase);
    // 2026-09-29 起 GLM 走付费档（免费档并发 1，线上 14 次尝试 0 次成功）
    expect(chain[0].free).toBe(false);
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
      AI_MODEL_GLM: "glm-5.3-flash",
      AI_BASE_GLM: "https://example.com/v1/",
    });
    expect(chain[0].model).toBe("glm-5.3-flash");
    // 末尾斜杠要去掉，否则拼出来是 //chat/completions
    expect(chain[0].baseUrl).toBe("https://example.com/v1");
  });

  it("没覆盖时用登记表里的默认端点", () => {
    expect(resolveModelChain("standard", { DEEPSEEK_API_KEY: "d" })[0].baseUrl).toBe(
      PROVIDERS.deepseek.defaultBase,
    );
  });
});

describe("顺序 / 谁排前面是产品决策，必须钉住", () => {
  const both = { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" };

  it("两档都是 **DeepSeek 打头、GLM 兜底** —— 免费档当首选会拖慢每一次请求", () => {
    expect(resolveModelChain("cheap", both).map((c) => c.provider)).toEqual(["deepseek", "glm"]);
    expect(resolveModelChain("standard", both).map((c) => c.provider)).toEqual(["deepseek", "glm"]);
  });

  it("例句任务走 DeepSeek 优先 —— 这条挂了说明顺序被改动了，先来看这张表再改测试", () => {
    expect(AI_TASK_TIER.example_personalized).toBe("cheap");
    expect(resolveModelChainForTask("example_personalized", both).map((c) => c.provider)).toEqual([
      "deepseek",
      "glm",
    ]);
  });

  it("只用免费的 GLM 也排得进链（不因顺序变化被漏掉）", () => {
    expect(resolveModelChain("cheap", { GLM_API_KEY: "g" }).map((c) => c.provider)).toEqual(["glm"]);
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

describe("resolveTimeoutMsFor / 超时按档算", () => {
  it("内置默认：链上两档现在都是付费档 → 都走 12 秒", () => {
    // GLM 在 2026-09-29 从免费档升成付费档（免费档并发 1，线上 14 次尝试 0 次成功）
    expect(resolveTimeoutMsFor("deepseek", {})).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMsFor("glm", {})).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("免费档专属的短超时机制保留 —— 这条不等式就是它的定义", () => {
    // 当前链上两档都是付费档，"免费档 4 秒"暂时没有实例；
    // 但机制不许删（再加免费档时要自动生效），所以锁住这两个关系：
    // 免费档必须**明显短于**付费档（否则"撞限流时白等满 12 秒"那个坑会回来），
    // 也必须**长于**一次尝试的最低门槛（否则它压根开不了）。
    expect(FREE_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
    expect(FREE_TIMEOUT_MS).toBeGreaterThan(MIN_ATTEMPT_MS);
  });

  it("★标了 `free: true` 的档自动拿短超时，且**不许被 AI_TIMEOUT_MS 抬回去**", () => {
    // 当前链上两档都是付费档 → 这条分支没有实例，所以临时把 GLM 标成免费来验它。
    // 跑完**立刻还原**（放在 finally 里），避免污染同一文件里的其它用例。
    const def = PROVIDERS.glm;
    const original = def.free;
    try {
      def.free = true;
      expect(resolveTimeoutMsFor("glm", {})).toBe(FREE_TIMEOUT_MS);
      // 回归钉子：旧环境里普遍填着 AI_TIMEOUT_MS=12000（旧版样例把它当必填）。
      // 一旦让它覆盖免费档，"免费档不再白等 12 秒"这个修复就被一条旧配置悄悄抵消 —— 且不报错。
      expect(resolveTimeoutMsFor("glm", { AI_TIMEOUT_MS: "6000" })).toBe(FREE_TIMEOUT_MS);
    } finally {
      def.free = original;
    }
  });

  it("单档专设最优先：AI_TIMEOUT_GLM_MS 只改 GLM，不动 DeepSeek", () => {
    const env = { AI_TIMEOUT_GLM_MS: "8000" };
    expect(resolveTimeoutMsFor("glm", env)).toBe(8000);
    expect(resolveTimeoutMsFor("deepseek", env)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("`AI_TIMEOUT_MS` 管所有付费档（现在两档都是）", () => {
    const env = { AI_TIMEOUT_MS: "6000" };
    expect(resolveTimeoutMsFor("deepseek", env)).toBe(6000);
    expect(resolveTimeoutMsFor("glm", env)).toBe(6000);
  });

  it("优先级：单档专设 > 一切默认", () => {
    expect(
      resolveTimeoutMsFor("glm", { AI_TIMEOUT_MS: "6000", AI_TIMEOUT_GLM_MS: "8000" }),
    ).toBe(8000);
  });

  it("乱填/零/负数都回落本来该有的默认（不许变成 0 秒这种「立刻超时」的疯值）", () => {
    expect(resolveTimeoutMsFor("glm", { AI_TIMEOUT_GLM_MS: "abc" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMsFor("glm", { AI_TIMEOUT_GLM_MS: "0" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMsFor("glm", { AI_TIMEOUT_GLM_MS: "-1" })).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("链路里每一档都带着自己的超时（调用方不必再查一次环境变量）", () => {
    const chain = resolveModelChain("cheap", { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" });
    expect(chain.map((c) => [c.provider, c.timeoutMs])).toEqual([
      ["deepseek", DEFAULT_TIMEOUT_MS],
      ["glm", DEFAULT_TIMEOUT_MS],
    ]);
  });

  it("每一档都登记了专设变量名（漏登记 = 设了不生效，而且不报错）", () => {
    for (const def of Object.values(PROVIDERS)) {
      expect(def.timeoutEnv).toMatch(/^AI_TIMEOUT_[A-Z_]+_MS$/);
    }
  });
});

describe("resolveTotalBudgetMs / 整条链的总预算", () => {
  it("默认 20 秒（没有它，最坏情况是 2 档 × 2 次 × 12 秒 = 48 秒）", () => {
    expect(resolveTotalBudgetMs({})).toBe(DEFAULT_TOTAL_BUDGET_MS);
  });

  it("预算不得小于单档超时 —— 否则第一档都开不了", () => {
    expect(resolveTotalBudgetMs({ AI_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  it("第一档被设了更长的超时，预算要跟着抬 —— 否则那一档直接被预算砍掉", () => {
    // 只配 GLM（它就是第一档）并给它 30 秒：预算若还按 5 秒算，它永远开不出来
    expect(
      resolveTotalBudgetMs({
        GLM_API_KEY: "g",
        AI_TOTAL_BUDGET_MS: "5000",
        AI_TIMEOUT_GLM_MS: "30000",
      }),
    ).toBe(30_000);
  });

  it("底线只认**第一档** —— 第二档被单独设长，不该把全局等待一起顶上去", () => {
    // GLM 排在第二：它被截断是设计内的（截断就落模板句），
    // 不能因为"给第二档设了 30 秒"就让每个请求都可能多等 30 秒。
    expect(
      resolveTotalBudgetMs({
        DEEPSEEK_API_KEY: "d",
        GLM_API_KEY: "g",
        AI_TOTAL_BUDGET_MS: "20000",
        AI_TIMEOUT_GLM_MS: "30000",
      }),
    ).toBe(20_000);
  });

  it("一档都没配 Key 时，底线退回「这个档位登记的第一家」的默认超时", () => {
    // 开发机上没 Key，但"我把默认超时调长了、预算得跟着抬"这条直觉仍然要成立
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

describe("例句的输出上限（180 只对「关得掉思考」的档成立）", () => {
  it("是 180 —— 两头都要兜住", () => {
    // 定这个数的逻辑（2026-09-25 从 300 收到 180）：
    //   · 太大：模型真的会"先想再答"、多写一段，**输出长度直接就是等待时间**；
    //   · 太小：写超了会被截断，JSON 就不合法 → 反而降级成模板句。
    // 提示词已经把内容框死（sentence 6~16 词、gloss ≤30 字），
    // **关掉思考后**合格输出约 35~45 token（2026-09-29 云端实测），180 绰绰有余。
    // 改它之前先回看这两条。
    expect(MAX_OUTPUT_TOKENS).toBe(180);
  });

  it("比一次合格输出宽裕一倍以上（别手滑调到刚好卡住）", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(150);
  });
});

describe("思考模式：按档配置（2026-09-29 最贵的一课）", () => {
  const both = { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" };
  const chain = resolveModelChain("cheap", both);
  const ds = chain[0];
  const glm = chain[1];

  it("DeepSeek 关得掉思考（走 thinking）；GLM-5.3 关不掉，只能压低（走 reasoning_effort）", () => {
    expect(ds.provider).toBe("deepseek");
    expect(glm.provider).toBe("glm");
    // ⚠️ 两家的参数名是**相反**的，登记值必须区分开；
    // 混用（比如把 DeepSeek 写成 reasoning_effort）在本地不报错，线上会 400 打废整档。
    expect(ds.thinkingControl).toBe("thinking_disabled");
    expect(glm.thinkingControl).toBe("reasoning_effort_low");
  });

  it("DeepSeek 绝不许登记成 `reasoning_effort` 那一种 —— 它的 reasoning_effort 没有 none", () => {
    // 官方参数表：`reasoning_effort` 只认 low/high/max。
    // 2026-09-29 我第一版就写错了这个（写成 reasoning_effort:"none"），
    // 是在给用户步骤前复查官方文档才拦下的 —— 这条测试就是那道闸门。
    expect(PROVIDERS.deepseek.thinkingControl).not.toBe("reasoning_effort_low");
  });

  it("★关不掉思考的档必须配更大的输出预算 —— 否则思考吃光预算、正文返回空", () => {
    // 这是本次事故的正面教训：2026-09-29 之前两档共用一个 180 的预算，
    // 而思考链自己就要吃几百上千 token → 正文静默返回空 → 成功率只剩 53%。
    expect(ds.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(glm.maxOutputTokens).toBeGreaterThan(MAX_OUTPUT_TOKENS * 5);
  });

  it("GLM 已换成付费档（免费档并发 1，线上 14 次尝试 0 次成功）", () => {
    expect(PROVIDERS.glm.defaultModel).toBe("glm-5.3-flash");
    expect(PROVIDERS.glm.free).toBe(false);
  });

  it("每一档都登记了 thinkingControl（漏登记 = 悄悄退回默认思考，且不报错）", () => {
    for (const def of Object.values(PROVIDERS)) {
      expect(["thinking_disabled", "reasoning_effort_low", null]).toContain(def.thinkingControl);
    }
  });
});
