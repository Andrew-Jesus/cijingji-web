import { describe, expect, it } from "vitest";

import { DEFAULT_COOLDOWN_MS, DEFAULT_RETRY_BACKOFF_MS, type EnvLike } from "./config";
import type { WordFacts } from "./prompt";
import { ProviderError } from "./provider";
import { createCooldownStore } from "./retry";
import { generateExample, type ChatCaller } from "./run";

/**
 * 这一组测的是**整条链怎么走**：谁先上、失败之后换档还是重试、退避等多久、
 * 什么时候打冷却、记账记了几笔。
 *
 * 为什么值得写这么多：这些分支在真机上极难复现（要刚好撞上"上一次还在跑"），
 * 但一旦写错，症状就是我们真踩过的那个 —— **兜底档每次都失败**，
 * 而且不报任何错，只表现为"AI 老是给模板句"。
 *
 * 手法：把"真实调用""等待""时钟"都注入成假的，于是整条链可以在毫秒内跑完，
 * 而且"总共花了多久"完全可控（否则"预算耗尽"那条分支根本测不出来）。
 */
const facts: WordFacts = {
  lemma: "ancient",
  phonetic: "/ˈeɪnʃənt/",
  pos: "adj.",
  meaning_zh: "古代的；古老的",
};

/** 闲时时刻，避开高峰计价，让成本断言稳定 */
const OFF_PEAK = new Date("2026-09-25T00:00:00Z");

/** 两家都配：这是线上真实的样子，也是"顺序"唯一能看出效果的前提 */
const BOTH: EnvLike = { DEEPSEEK_API_KEY: "d", GLM_API_KEY: "g" };

const GOOD = JSON.stringify({
  sentence: "Basketball fans still argue about the rules of that ancient game.",
  gloss: "篮球迷至今还在争论那项古老运动的规则。",
});

type Step = { kind: "ok"; text?: string } | { kind: "err"; err: unknown };

/** 假调用：按脚本依次"回话"，并把每次调用记下来供断言 */
function makeCaller(script: Step[]) {
  const calls: { provider: string; model: string; timeoutMs: number }[] = [];
  const call: ChatCaller = async (spec, _messages, opts) => {
    calls.push({ provider: spec.provider, model: spec.model, timeoutMs: opts.timeoutMs });
    const step = script[calls.length - 1];
    if (!step) {
      throw new Error(`脚本只准备了 ${script.length} 次调用，却又来了第 ${calls.length} 次`);
    }
    if (step.kind === "err") throw step.err;
    return {
      text: step.text ?? GOOD,
      usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 0 },
    };
  };
  return { call, calls };
}

/**
 * 假时钟：从 0 开始，"等待"会真的推进它。
 * 这样"退避等掉多少预算"就能精确断言，而且整组测试仍然在毫秒内跑完。
 */
function makeClock() {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    clock: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

const http = (status: number) => new ProviderError("http", `HTTP ${status}`, status);
const timeout = () => new ProviderError("timeout", "请求超时（>12000ms）", null);
const offline = () => new ProviderError("network", "连不上模型服务", null);

async function run(
  script: Step[],
  over: { env?: EnvLike; cooldown?: ReturnType<typeof createCooldownStore> } = {},
) {
  const { call, calls } = makeCaller(script);
  const { clock, sleep, waits } = makeClock();
  const cooldown = over.cooldown ?? createCooldownStore();
  const out = await generateExample({
    wordId: "w:ancient",
    interestTag: "basketball",
    facts,
    env: over.env ?? BOTH,
    now: OFF_PEAK,
    clock,
    log: () => undefined,
    call,
    sleep,
    cooldown,
  });
  return { out, calls, waits, cooldown };
}

describe("链路顺序：例句先走 DeepSeek", () => {
  it("首选是 DeepSeek；它写出来就不算降级（它本来就是这条链的正主）", async () => {
    const { out, calls } = await run([{ kind: "ok" }]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek"]);
    expect(out.source).toBe("ai");
    expect(out.model).toBe("deepseek-flash");
    expect(out.degraded).toBe(false);
    expect(out.notes).toEqual([]);
  });

  it("首选档写了但格式不合格 → 同一档立刻再问一次（不退避，因为它刚正常回过话）", async () => {
    const { out, calls, waits } = await run([{ kind: "ok", text: "这不是 JSON" }, { kind: "ok" }]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "deepseek"]);
    expect(waits).toEqual([]);
    expect(out.source).toBe("ai");
    expect(out.model).toBe("deepseek-flash");
  });

  it("首选档挂了 → 兜底的 GLM 顶上，并如实标成降级", async () => {
    const { out, calls } = await run([
      { kind: "err", err: http(500) },
      { kind: "err", err: http(500) },
      { kind: "ok" },
    ]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "deepseek", "glm"]);
    expect(out.model).toBe("glm-4.7-flash");
    expect(out.degraded).toBe(true);
    expect(out.notes[0]).toContain("首选档没成");
  });
});

describe("退避重试：那个「兜底档每次都失败」的坑", () => {
  it("超时之后**先等再试**（不等就是自己撞上还在跑的上一次 → 429）", async () => {
    const { out, calls, waits } = await run([{ kind: "err", err: timeout() }, { kind: "ok" }]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "deepseek"]);
    expect(waits).toEqual([DEFAULT_RETRY_BACKOFF_MS]);
    expect(out.model).toBe("deepseek-flash");
  });

  it("撞限流（429）时还有别的档 → 直接换档，不在同一档上硬碰", async () => {
    const { out, calls, waits } = await run([{ kind: "err", err: http(429) }, { kind: "ok" }]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "glm"]);
    expect(waits).toEqual([]); // 换档不需要等
    expect(out.model).toBe("glm-4.7-flash");
  });

  it("已经是最后一档还撞限流 → 退避后再试一次（总不能把这一句直接丢了）", async () => {
    const { out, calls, waits } = await run([{ kind: "err", err: http(429) }, { kind: "ok" }], {
      env: { GLM_API_KEY: "g" }, // 只有免费档一条
    });

    expect(calls.map((c) => c.provider)).toEqual(["glm", "glm"]);
    expect(waits).toEqual([DEFAULT_RETRY_BACKOFF_MS]);
    expect(out.source).toBe("ai");
  });

  it("每档最多试 2 次 —— 不许无限重试烧钱", async () => {
    const { calls } = await run([
      { kind: "err", err: http(500) },
      { kind: "err", err: http(500) },
      { kind: "err", err: http(500) },
      { kind: "err", err: http(500) },
    ]);

    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "deepseek", "glm", "glm"]);
  });
});

describe("冷却：别在已经死掉的档上白等", () => {
  it("余额不足（402）→ 换档，并且把这一档冻上", async () => {
    const { calls, cooldown } = await run([
      { kind: "err", err: http(402) },
      { kind: "err", err: http(402) },
    ]);

    // 402 不重试：两档各试一次就够，不该有第三次
    expect(calls.map((c) => c.provider)).toEqual(["deepseek", "glm"]);
    expect(cooldown.until("deepseek")).toBe(DEFAULT_COOLDOWN_MS);
    expect(cooldown.isCooling("deepseek", 0)).toBe(true);
    expect(cooldown.isCooling("glm", 0)).toBe(true);
  });

  it("被冻住的档**连试都不试**，直接跳到下一档（省掉一次白等）", async () => {
    const cooldown = createCooldownStore();
    // 第一次：DeepSeek 余额不足（被冻），GLM 只是临时故障（不该被冻）
    await run(
      [
        { kind: "err", err: http(402) },
        { kind: "err", err: http(500) },
        { kind: "err", err: http(500) },
      ],
      { cooldown },
    );
    expect(cooldown.isCooling("deepseek", 0)).toBe(true);
    expect(cooldown.isCooling("glm", 0)).toBe(false);

    const second = await run([{ kind: "ok" }], { cooldown });

    expect(second.calls.map((c) => c.provider)).toEqual(["glm"]);
    expect(second.out.model).toBe("glm-4.7-flash");
    expect(second.out.attempts[0].error).toContain("冷却中");
  });

  it("被冻住的档不产生账目 —— 没发生调用就没花钱", async () => {
    const cooldown = createCooldownStore();
    await run([{ kind: "err", err: http(402) }, { kind: "ok" }], { cooldown });

    const second = await run([{ kind: "ok" }], { cooldown });

    expect(second.calls).toHaveLength(1);
    expect(second.out.usages).toHaveLength(1);
    expect(second.out.usages[0].model).toBe("glm-4.7-flash");
  });
});

describe("总预算：宁可给模板句，也不让用户干等", () => {
  it("预算用尽就立刻收手，理由是「太慢」而不是「没写好」", async () => {
    const { out, calls } = await run([{ kind: "err", err: timeout() }, { kind: "ok" }], {
      env: { ...BOTH, AI_TIMEOUT_MS: "1000", AI_TOTAL_BUDGET_MS: "3000" },
    });

    // 第一次用掉 1 秒超时 + 1.2 秒退避之后，剩下的时间连一次最短尝试都不够
    expect(calls).toHaveLength(1);
    expect(out.source).toBe("template");
    expect(out.model).toBeNull();
    expect(out.notes.join(" ")).toContain("慢");
  });

  it("单次超时不许超过剩余预算（否则预算形同虚设）", async () => {
    const { calls } = await run(
      [
        { kind: "err", err: http(500) },
        { kind: "err", err: http(500) },
        { kind: "err", err: http(500) },
        { kind: "err", err: http(500) },
      ],
      { env: { ...BOTH, AI_TIMEOUT_MS: "12000", AI_TOTAL_BUDGET_MS: "12000" } },
    );

    for (const c of calls) expect(c.timeoutMs).toBeLessThanOrEqual(12_000);
    // 退避吃掉预算之后，后面的尝试窗口只会越来越短
    expect(calls[calls.length - 1].timeoutMs).toBeLessThan(12_000);
  });
});

describe("记账与兜底", () => {
  it("成功的那笔有 token，失败的那笔记 0 但**必须留下**（失败也花了时间/钱）", async () => {
    const { out } = await run([{ kind: "err", err: http(402) }, { kind: "ok" }]);

    expect(out.usages).toHaveLength(2);
    expect(out.usages[0]).toMatchObject({ model: "deepseek-flash", input_tokens: 0, ok: false });
    expect(out.usages[1]).toMatchObject({ model: "glm-4.7-flash", input_tokens: 100, ok: true });
  });

  it("免费的 GLM 记成 0 元，但标记为**已计价**（0 元是真免费，不是「没查到价」）", async () => {
    const { out } = await run([{ kind: "ok" }], { env: { GLM_API_KEY: "g" } });

    expect(out.usages[0].cost_cny).toBe(0);
    expect(out.usages[0].priced).toBe(true);
  });

  it("两档都不成 → 模板句，并如实说明原因", async () => {
    const { out } = await run([{ kind: "err", err: http(402) }, { kind: "err", err: http(402) }]);

    expect(out.source).toBe("template");
    expect(out.degraded).toBe(true);
    expect(out.model).toBeNull();
    expect(out.payload.sentence).toContain("ancient");
    expect(out.notes.join(" ")).toContain("通用示例");
    expect(out.attempts.map((a) => a.ok)).toEqual([false, false]);
  });

  it("一个 Key 都没配 → 直接给模板句，**一次调用都不发**", async () => {
    const { out, calls } = await run([], { env: {} });

    expect(calls).toHaveLength(0);
    expect(out.usages).toEqual([]);
    expect(out.attempts).toEqual([]);
    expect(out.source).toBe("template");
    expect(out.notes.join(" ")).toContain("API Key");
  });

  it("真连不上时兜底理由写「断网」（而不是含混的「模型没写好」）", async () => {
    const { out } = await run([{ kind: "err", err: offline() }], { env: { GLM_API_KEY: "g" } });

    expect(out.source).toBe("template");
    expect(out.notes.join(" ")).toContain("断网");
  });

  it("只是慢（超时）时兜底理由写「太慢」—— 和「断网」必须分得开", async () => {
    const { out } = await run([{ kind: "err", err: timeout() }, { kind: "err", err: timeout() }], {
      env: { GLM_API_KEY: "g" },
    });

    expect(out.source).toBe("template");
    expect(out.notes.join(" ")).toContain("慢");
    expect(out.notes.join(" ")).not.toContain("断网");
  });
});
