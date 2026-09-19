/**
 * AI 网关配置 —— **全项目唯一允许出现模型名的地方**
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────
 * 硬约束：业务代码里**不得出现任何模型名**，一律走 `ai.generate(task, input)`。
 * 理由不是洁癖：
 *   · 换模型（DeepSeek 改价、下线、想换 GLM 主力）时只改一处；
 *   · 「AI 边界」这条产品规矩要靠它守 —— 词表/音标/义项这些**查出来的东西**
 *     绝不能被模型改写，而换个模型就悄悄改变事实的风险，正是从"到处写模型名"开始的。
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

/**
 * 模型名默认值 —— **只有这一处**。
 * `.env.example` 里写的是同一份，改的时候两边一起改（那边只是给人看的说明）。
 *
 * 关于名字：DeepSeek 在 2026 年 9 月把 Flash 的规范名换成了 `deepseek-flash`，
 * 旧名 `deepseek-v4-flash` 仍被接受（请求由同名模型承接、按 Flash 价计费）。
 * 这里用规范名，旧的写在 `.env.example` 注释里备查。
 */
export const DEFAULT_MODEL_PRIMARY = "deepseek-flash";
export const DEFAULT_MODEL_FALLBACK = "glm-4.7-flash";

/** OpenAI 兼容端点。两家都提供 `/chat/completions`，所以调用代码只有一份 */
export const DEFAULT_BASE_PRIMARY = "https://api.deepseek.com";
export const DEFAULT_BASE_FALLBACK = "https://open.bigmodel.cn/api/paas/v4";

/**
 * 单次请求超时。定 12 秒的依据：
 *   例句只有 1~2 句，正常 1~3 秒；超过 12 秒用户已经在等得不耐烦了，
 *   这时候**换下一档比继续等更快**。宁可降级，不要卡住。
 */
export const DEFAULT_TIMEOUT_MS = 12_000;

/** 生成一句例句的输出上限。给 300 是留足余量：模型偶尔会先想再答 */
export const MAX_OUTPUT_TOKENS = 300;

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
  /** 模型名。**唯一来源是环境变量 / 上面那两个默认值** */
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 免费额度模型：用来在界面上如实区分"降级到了免费兜底" */
  free: boolean;
}

/**
 * 按环境变量拼出"主 → 兜底"这条链。
 * 缺 Key 的一档直接跳过（不抛错），所以开发机上没配 Key 也能跑通全流程（落到模板句）。
 */
export function resolveModelChain(env: EnvLike = process.env): ModelSpec[] {
  assertServerSide("resolveModelChain");
  const chain: ModelSpec[] = [];

  const primaryKey = env.DEEPSEEK_API_KEY?.trim();
  if (primaryKey) {
    chain.push({
      model: env.AI_MODEL_PRIMARY?.trim() || DEFAULT_MODEL_PRIMARY,
      baseUrl: (env.AI_BASE_PRIMARY?.trim() || DEFAULT_BASE_PRIMARY).replace(/\/+$/, ""),
      apiKey: primaryKey,
      free: false,
    });
  }

  const fallbackKey = env.GLM_API_KEY?.trim();
  if (fallbackKey) {
    chain.push({
      model: env.AI_MODEL_FALLBACK?.trim() || DEFAULT_MODEL_FALLBACK,
      baseUrl: (env.AI_BASE_FALLBACK?.trim() || DEFAULT_BASE_FALLBACK).replace(/\/+$/, ""),
      apiKey: fallbackKey,
      free: true,
    });
  }

  return chain;
}

export function resolveTimeoutMs(env: EnvLike = process.env): number {
  const raw = Number(env.AI_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  // 上限 60 秒：比这更长的话，用户早就走了，等待没有意义
  return Math.min(Math.round(raw), 60_000);
}

/** 有没有配任何一档。开发者模式里用它如实说明"AI 没接上"的原因 */
export function hasAnyProvider(env: EnvLike = process.env): boolean {
  return resolveModelChain(env).length > 0;
}
