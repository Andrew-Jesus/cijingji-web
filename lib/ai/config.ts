/**
 * AI 网关配置 —— **全项目唯一允许出现模型名的地方**
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 * 硬约束：业务代码里**不得出现任何模型名、也不得出现"用哪一档"**，
 * 一律走 `ai.generate(task, input)`。理由不是洁癖：
 *   · 换模型（DeepSeek 改价、下线、想换 GLM 主力）时只改一处；
 *   · 「AI 边界」这条产品规矩要靠它守 —— 词表/音标/义项这些**查出来的东西**
 *     绝不能被模型改写，而换个模型就悄悄改变事实的风险，正是从"到处写模型名"开始的。
 *
 * ── 分档路由（2026-09-25 定案）────────────────────────────────
 * 不是一个固定的"主 → 兜底"，而是**按任务分量分档**：
 *
 *   · `cheap` 档 —— 例句这种"短、量大、写不好也不致命"的活：
 *     **智谱 GLM 免费档打头，DeepSeek 垫底**。
 *     理由：这类活 GLM 完全够用，先走免费的能把 DeepSeek 的调用量压下来（省钱），
 *     付费的退到后面当保险。
 *   · `standard` 档 —— 归因、计划这类"要动脑子"的活：
 *     **DeepSeek 打头，GLM 兜底**。
 *
 * 哪一档排谁在前，**只写在本文件的两张表里**（`TIER_ORDER` 与 `AI_TASK_TIER`）。
 * 想加第三家：往 `PROVIDERS` 加一项 + 在 `TIER_ORDER` 里排个位置，业务代码一行不用动。
 *
 * ── Key 的边界（硬约束，踩过坑）──────────────────────────────
 * 这个文件只在**服务端**被 import（`app/api/ai/route.ts` 那条链路）。
 * 前端组件、客户端组件、`NEXT_PUBLIC_*` 里永远不许引用它 —— 一旦被前端引用，
 * Key 就会进浏览器包，反编译即得。交付前要全仓搜一遍 `API_KEY` 确认。
 *
 * ── 没有 Key 时会怎样 ────────────────────────────────────────
 * **不报错、不崩**。环境变量缺失 = 这一档不可用 → 直接跳到下一档，
 * 最终落到模板句。学习页永远拿得到一句例句（这是"永不因 AI 失败而卡住"的底）。
 */

/** 阶段 0 唯一的 AI 任务。以后新增任务 = 往这里加一项 + 在 prompt.ts 加它的提示词 */
export const AI_TASKS = ["example_personalized"] as const;
export type AiTaskId = (typeof AI_TASKS)[number];

/* ══════════════════════════ 档位 ══════════════════════════ */

/**
 * 任务档位 —— 决定"这条链上谁排前面"。
 *
 * 现在只有两档。**高档暂时没有单独一档**：等真的出现"要长链推理"的任务
 * （比如周计划、学习路径规划）时再加一档 `deep`，
 * 那时要动的只是 `TIER_ORDER` 里多一行 + 这里多一个字面量，别的地方不受影响。
 */
export type AiTaskTier = "cheap" | "standard";

export type ProviderId = "deepseek" | "glm";

export interface ProviderDef {
  id: ProviderId;
  /** 人话名字，只用于日志与排查，**不参与任何判断**（判断只认 id） */
  label: string;
  /** 读 Key 的环境变量名。空 = 这一档没配 → 跳过（不抛错） */
  keyEnv: string;
  /** 覆盖模型名的环境变量名 */
  modelEnv: string;
  /** 覆盖端点地址的环境变量名 */
  baseEnv: string;
  /** 模型名默认值 —— 全项目只此一处（`.env.example` 里那份是给人看的说明） */
  defaultModel: string;
  defaultBase: string;
  /**
   * 免费档标记。**它标记的是"这一档有什么脾气"，不是"要不要用它"**：
   * 免费档通常并发只有 1、速度不稳 —— 所以撞上限流（429）时
   * 应该痛快换下一档，而不是在同一档上硬碰。
   */
  free: boolean;
}

/**
 * 供应商登记表。**加第三家就在这里加一项**（前提：对方提供 OpenAI 兼容的
 * `/chat/completions`，否则 `provider.ts` 那份调用代码要改）。
 *
 * 模型名的来历：
 *   · DeepSeek 在 2026 年 9 月把 Flash 的规范名换成了 `deepseek-flash`，
 *     旧名 `deepseek-v4-flash` 仍被接受（同名模型承接、按 Flash 价计费）。
 *   · 智谱 `glm-4.7-flash` 长期免费，但**并发 1**。真要提稳定性，
 *     把 `AI_MODEL_GLM` 换成 `glm-4.7-flashX`（同模型、解除并发限制、单价极低）即可，
 *     一行环境变量的事，代码不用改。
 */
export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "AI_MODEL_DEEPSEEK",
    baseEnv: "AI_BASE_DEEPSEEK",
    defaultModel: "deepseek-flash",
    defaultBase: "https://api.deepseek.com",
    free: false,
  },
  glm: {
    id: "glm",
    label: "智谱 GLM",
    keyEnv: "GLM_API_KEY",
    modelEnv: "AI_MODEL_GLM",
    baseEnv: "AI_BASE_GLM",
    defaultModel: "glm-4.7-flash",
    defaultBase: "https://open.bigmodel.cn/api/paas/v4",
    free: true,
  },
};

/**
 * **档位 → 供应商优先级**。数组顺序就是尝试顺序，第一个是"首选"。
 *
 * 改这张表 = 改掉整个产品的成本结构与质量上限，请连着 `cost.ts` 一起看。
 */
export const TIER_ORDER: Record<AiTaskTier, readonly ProviderId[]> = {
  // 例句：GLM 免费档打头（够用 + 不要钱），DeepSeek 垫底当保险
  cheap: ["glm", "deepseek"],
  // 需要动脑子的活：DeepSeek 打头，GLM 兜底
  standard: ["deepseek", "glm"],
};

/** 任务 → 档位。**新增任务必须在这里落一次户**，否则拿不到档位 */
export const AI_TASK_TIER: Record<AiTaskId, AiTaskTier> = {
  example_personalized: "cheap",
};

/* ══════════════════════════ 超时与预算 ══════════════════════════ */

/**
 * 单次请求超时。定 12 秒的依据：
 *   例句只有 1~2 句，正常 1~3 秒；超过 12 秒用户已经在等得不耐烦了，
 *   这时候**换下一档比继续等更快**。宁可降级，不要卡住。
 */
export const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * **整条链的总预算**（从第一次调用算起）。
 *
 * 为什么单有"每档超时"还不够：一档 12 秒 × 两档 × 各重试一次 = 最坏 48 秒，
 * 用户早就关了页面。有了总预算，最坏情况封在 20 秒 —— 超了就直接给模板句，
 * 「永不卡住」这条底线才真正成立。
 */
export const DEFAULT_TOTAL_BUDGET_MS = 20_000;

/**
 * 一次尝试至少要有这么多时间才值得开。
 * 剩余预算比它还少，说明这一试几乎必然超时 —— 不如省下这点时间直接给模板句。
 */
export const MIN_ATTEMPT_MS = 2_500;

/** 生成一句例句的输出上限。给 300 是留足余量：模型偶尔会先想再答 */
export const MAX_OUTPUT_TOKENS = 300;

/* ══════════════════════════ 重试 ══════════════════════════ */

/**
 * **重试前先等多久**。这一个数就是"GLM 每次都失败"那个 bug 的解药。
 *
 * 病灶：免费档并发只有 1。上一次请求"超时"只是**我们这边不等了**，
 * 对方服务器上那次还在跑。立刻重发 = 一头撞上还在占窗口的第一次 → 429。
 *
 * 所以重试前必须等够时间让上一次跑完。默认 1.2 秒是最小值，
 * 实测撞限流还频繁就把 `AI_RETRY_BACKOFF_MS` 调大。
 */
export const DEFAULT_RETRY_BACKOFF_MS = 1_200;

/** 第 n 次重试前等多久（线性递增：第 1 次等 1×，第 2 次等 2×） */
export function backoffMs(attemptIndex: number, base: number): number {
  return Math.max(base, 0) * (attemptIndex + 1);
}

/* ══════════════════════════ 冷却 ══════════════════════════ */

/**
 * **冷却时长**：某一档明确失败后（余额不足 / Key 不对），
 * 这段时间内**直接跳过它**，连试都不试。
 *
 * 为什么值得专门做：线上实测里 DeepSeek 是"余额不足（402）"，
 * 但它每次都先被试一遍才轮到兜底 —— 等于**每一次请求都白等一轮**。
 * 这类失败在几分钟内重试一百次也是同样结果，试它纯属浪费用户的等待时间。
 *
 * ⚠️ **这是"尽力而为"的优化，不是正确性依赖**：它存在进程内存里，
 * 在 Vercel 上每个实例各记各的、实例回收就清空。所以：
 * 哪怕它完全失效，逻辑上也只会退化成"多试一次"，不会出错。
 */
export const DEFAULT_COOLDOWN_MS = 300_000;

/**
 * 误用的**响亮失败**。
 *
 * 这里没有用 `server-only` 包（没装依赖，不想为它多装一个包）。
 * 但 Next 本身还有一层兜底：只有 `NEXT_PUBLIC_*` 的环境变量会被内联进前端包，
 * 其余在浏览器里一律是 `undefined` —— 所以就算真被前端引用，Key 也漏不出去。
 * 这个断言的价值在于：**让"漏出去"变成一个当场报错，而不是一个安静的 undefined**
 * （安静的 undefined 会表现成"AI 老是降级到模板句"，排查起来很绕）。
 */
function assertServerSide(where: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `[ai/config] ${where} 只能在服务端调用 —— 前端引用它意味着 Key 有进浏览器包的风险。`,
    );
  }
}

/**
 * 环境变量的**宽读**类型。
 *
 * 为什么不用 `NodeJS.ProcessEnv`：它的 `NODE_ENV` 在 Next 的类型声明里是**必填**的，
 * 于是"传一个字面量对象进来"这种最自然的单测写法会被类型系统挡住，
 * 逼得测试里凭空造一个 `NODE_ENV` —— 那是为了迁就类型而写的假数据，不是真实约束。
 * 这里只需要"按键读字符串"这一件事，`Record` 已经够了，`process.env` 也能直接传入。
 */
export type EnvLike = Record<string, string | undefined>;

export interface ModelSpec {
  /** 哪一家（冷却表、日志、排查都认它） */
  provider: ProviderId;
  /** 模型名。**唯一来源是环境变量 / `PROVIDERS` 里的默认值** */
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 免费额度模型：有并发限制、速度不稳，界面上要如实区分 */
  free: boolean;
}

function readEnv(env: EnvLike, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

/**
 * 按档位拼出这一档要走的链。
 *
 * **缺 Key 的一档直接跳过（不抛错）** —— 所以开发机上没配 Key 也能跑通全流程（落到模板句）；
 * 也所以"只配了 GLM"时，GLM 就是这条链的首选（不会被误标成降级）。
 */
export function resolveModelChain(
  tier: AiTaskTier = "cheap",
  env: EnvLike = process.env,
): ModelSpec[] {
  assertServerSide("resolveModelChain");

  const chain: ModelSpec[] = [];
  for (const id of TIER_ORDER[tier]) {
    const def = PROVIDERS[id];
    const apiKey = readEnv(env, def.keyEnv);
    if (!apiKey) continue; // 没配就跳过，不报错

    chain.push({
      provider: def.id,
      model: readEnv(env, def.modelEnv) ?? def.defaultModel,
      baseUrl: (readEnv(env, def.baseEnv) ?? def.defaultBase).replace(/\/+$/, ""),
      apiKey,
      free: def.free,
    });
  }
  return chain;
}

/** 按任务拿它的链路。业务代码只调这一个 —— 不自己判断该用哪档 */
export function resolveModelChainForTask(task: AiTaskId, env: EnvLike = process.env): ModelSpec[] {
  return resolveModelChain(AI_TASK_TIER[task], env);
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.round(n), max);
}

export function resolveTimeoutMs(env: EnvLike = process.env): number {
  // 上限 60 秒：比这更长的话，用户早就走了，等待没有意义
  return readPositiveInt(readEnv(env, "AI_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 60_000);
}

/** 整条链的总预算。**不得小于单档超时** —— 否则第一档都开不了 */
export function resolveTotalBudgetMs(env: EnvLike = process.env): number {
  const t = resolveTimeoutMs(env);
  const budget = readPositiveInt(
    readEnv(env, "AI_TOTAL_BUDGET_MS"),
    DEFAULT_TOTAL_BUDGET_MS,
    120_000,
  );
  return Math.max(budget, t);
}

export function resolveRetryBackoffMs(env: EnvLike = process.env): number {
  return readPositiveInt(readEnv(env, "AI_RETRY_BACKOFF_MS"), DEFAULT_RETRY_BACKOFF_MS, 5_000);
}

export function resolveCooldownMs(env: EnvLike = process.env): number {
  return readPositiveInt(readEnv(env, "AI_COOLDOWN_MS"), DEFAULT_COOLDOWN_MS, 3_600_000);
}

/** 有没有配任何一档。开发者模式里用它如实说明"AI 没接上"的原因 */
export function hasAnyProvider(env: EnvLike = process.env): boolean {
  return resolveModelChain("cheap", env).length > 0 || resolveModelChain("standard", env).length > 0;
}
