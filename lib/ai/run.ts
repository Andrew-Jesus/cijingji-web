/**
 * AI 编排 —— 分档路由 + 降级链 + 退避重试 + 冷却 + 记账
 *
 * ── 链的形状（2026-09-25 定案）───────────────────────────────
 * **所有任务一律 `DeepSeek → GLM → 模板句`**；谁排前面由 `config.ts` 的档位表决定，
 * 这里只负责按那张表的顺序走，自己不判断"该用谁"。
 * （曾把例句这类轻活排成"GLM 免费档打头"想省钱，被当天的线上实测推翻 —— 见 `config.ts` 头部。）
 *
 * 最后那一档是**确定性兜底**：不依赖网络、不依赖 Key、不可能失败。
 * 有了它，「学习页永不因 AI 失败而卡住」这句话才是真的，而不是一句愿望。
 *
 * ── 三道防线（每一道都是踩过坑加上的）───────────────────────
 *   ① **每档最多试 2 次**，但重试前**先退避**（默认 1.2 秒）。
 *      不加退避就是这个项目真实踩过的坑：免费档并发 1，超时后立刻重发，
 *      一头撞上还在跑的上一次 → 429，于是**兜底档每次都失败**。
 *   ①′ **超时按档算**：免费档 4 秒、付费档 12 秒（`config.ts` 的 `resolveTimeoutMsFor`）。
 *      共用一个数会让免费档被限流时**白等满 12 秒**才换档 —— 另一个真实踩过的坑。
 *   ② **整条链有总预算**（默认 20 秒）。没有它，2 档 × 2 次 × 12 秒 = 最坏 48 秒。
 *   ③ **冷却表**：某一档明确"死"了（余额不足 / Key 错），几分钟内直接跳过 ——
 *      否则每次请求都要在它身上白等一轮。
 *
 * ── 记账 ────────────────────────────────────────────────────
 * 每一次**真实发生的 API 调用**都产出一条 `AiUsageDraft`，
 * 包括失败的那几次（tokens 取不到就记 0，并且 `ok:false`）。
 * 被冷却跳过、被预算砍掉的那些**不算调用**，所以不产生账目 —— 它们没花钱。
 * 服务端同时打一行结构化日志 —— 服务端是唯一可信来源，
 * 本地的 `ai_usage` 是"给用户看得见"的副本，两者字段同构。
 */
import {
  AI_TASK_TIER,
  backoffMs,
  MIN_ATTEMPT_MS,
  resolveCooldownMs,
  resolveModelChainForTask,
  resolveRetryBackoffMs,
  resolveTotalBudgetMs,
  type AiTaskId,
  type EnvLike,
  type ModelSpec,
} from "./config";
import type { AiAttempt, AiExamplePayload, AiUsageDraft } from "./contract";
import { estimateCost } from "./cost";
import { fallbackNote, templateExample, type FallbackReason } from "./fallback";
import { parseExamplePayload } from "./parse";
import { buildPrompt, type WordFacts } from "./prompt";
import { callChatCompletion, ProviderError } from "./provider";
import {
  decideAfterFailure,
  providerCooldown,
  realSleep,
  type CooldownStore,
} from "./retry";

/** 每个模型最多试几次（含首次）。写成常量是为了让它显式可改，而不是散在循环里 */
export const ATTEMPTS_PER_MODEL = 2;

/** 调用的函数形状。抽出来是为了单测能塞一个"假的模型"进去，走完整条链 */
export type ChatCaller = typeof callChatCompletion;

export interface GenerateExampleInput {
  wordId: string;
  interestTag: string;
  facts: WordFacts;
  /**
   * 任务 id。**档位是从它推出来的**，不是写死在函数名里 ——
   * 以后 `generateExample` 拆成通用入口时，这里不用改。
   */
  task?: AiTaskId;
  /**
   * 环境变量。用 `EnvLike`（宽读）而不是 `NodeJS.ProcessEnv`：
   * 后者的 `NODE_ENV` 在 Next 的类型声明里是**必填**，会逼着调用方
   * （尤其是单测）凭空造一个 `NODE_ENV` 出来 —— 那是为迁就类型写的假数据。
   */
  env?: EnvLike;
  /** 记账用的时刻（决定峰谷价）。与 `clock` 分开：一个答"现在几点"，一个答"跑了多久" */
  now?: Date;
  /**
   * 计时用的毫秒表。默认就是真实时间。
   * 抽出来是为了单测能**控制时间流逝** —— 否则"总预算耗尽"这条分支根本测不出来
   * （真实等待 1.2 秒既慢又不可靠）。
   */
  clock?: () => number;
  /** 注入日志出口，便于测试断言"有没有记账/有没有打日志" */
  log?: (record: Record<string, unknown>) => void;
  /** 注入点（单测用）：真实调用 / 等待 / 冷却表 */
  call?: ChatCaller;
  sleep?: (ms: number) => Promise<void>;
  cooldown?: CooldownStore;
}

export interface GenerateExampleOutput {
  payload: AiExamplePayload;
  source: "ai" | "template";
  model: string | null;
  degraded: boolean;
  attempts: AiAttempt[];
  usages: AiUsageDraft[];
  notes: string[];
}

function attemptOf(spec: ModelSpec, ok: boolean, latency: number, error?: string): AiAttempt {
  return { model: spec.model, ok, latency_ms: latency, ...(error ? { error } : {}) };
}

function usageDraft(
  task: AiTaskId,
  spec: ModelSpec,
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  latency: number,
  ok: boolean,
  at: Date,
): AiUsageDraft {
  const cost = estimateCost(spec.model, usage, at);
  return {
    task,
    model: spec.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens: usage.cached_tokens,
    cost_cny: cost.cost_cny,
    priced: cost.priced,
    peak: cost.peak,
    latency_ms: latency,
    ok,
  };
}

/** 失败也要留下的那笔账：没拿到 tokens 就记 0，但"这次调用发生过"必须留下 */
function failedUsageDraft(task: AiTaskId, spec: ModelSpec, latency: number): AiUsageDraft {
  return {
    task,
    model: spec.model,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cost_cny: 0,
    priced: true,
    peak: false,
    latency_ms: latency,
    ok: false,
  };
}

export async function generateExample(input: GenerateExampleInput): Promise<GenerateExampleOutput> {
  const task: AiTaskId = input.task ?? "example_personalized";
  const now = input.now ?? new Date();
  const budgetMs = resolveTotalBudgetMs(input.env);
  const backoffBase = resolveRetryBackoffMs(input.env);
  const cooldownMs = resolveCooldownMs(input.env);
  const chain = resolveModelChainForTask(task, input.env);

  const log = input.log ?? ((record) => console.log(JSON.stringify({ scope: "ai", ...record })));
  const call = input.call ?? callChatCompletion;
  const sleep = input.sleep ?? realSleep;
  const clock = input.clock ?? Date.now;
  // 冷却表用**全局那一份**：冷却能生效的前提就是"所有请求共用一张表"，
  // 每次调用新建一张等于没做冷却。单测里可以注入自己的那份。
  const cooldown = input.cooldown ?? providerCooldown;

  const attempts: AiAttempt[] = [];
  const usages: AiUsageDraft[] = [];
  const notes: string[] = [];
  let sawNetworkIssue = false;
  let sawTimeout = false;
  let ranOutOfTime = false;

  if (chain.length === 0) {
    notes.push(fallbackNote("no_provider"));
    return {
      payload: templateExample(input.facts, input.interestTag),
      source: "template",
      model: null,
      degraded: true,
      attempts,
      usages,
      notes,
    };
  }

  const prompt = buildPrompt(task, {
    facts: input.facts,
    interestTag: input.interestTag,
  });
  const messages = [
    { role: "system" as const, content: prompt.fixed },
    { role: "user" as const, content: prompt.variable },
  ];

  const startedAt = clock();
  const elapsed = () => clock() - startedAt;

  chainLoop: for (let ci = 0; ci < chain.length; ci++) {
    const spec = chain[ci];
    const hasNextProvider = ci < chain.length - 1;

    // 冷却中：这一档刚刚明确"死"过（余额不足 / Key 错），连试都不试。
    // 不产生账目 —— 没发生调用，就没花钱。
    if (cooldown.isCooling(spec.provider, clock())) {
      attempts.push(
        attemptOf(spec, false, 0, "冷却中：这一档刚才明确失败过（余额或密钥问题），暂时跳过"),
      );
      log({
        event: "provider_cooling_skip",
        word_id: input.wordId,
        provider: spec.provider,
        model: spec.model,
        until: cooldown.until(spec.provider),
      });
      continue;
    }

    for (let i = 0; i < ATTEMPTS_PER_MODEL; i++) {
      // 总预算兜底：剩下的时间连一次最短的尝试都不够，就别开了，
      // 直接去模板句 —— 让用户干等是最差的结果。
      const remaining = budgetMs - elapsed();
      if (remaining < MIN_ATTEMPT_MS) {
        ranOutOfTime = true;
        log({
          event: "budget_exhausted",
          word_id: input.wordId,
          elapsed_ms: elapsed(),
          budget_ms: budgetMs,
        });
        break chainLoop;
      }
      // 单次超时**按档算**（免费档比付费档短，理由见 `config.ts` 的 `FREE_TIMEOUT_MS`），
      // 并且不许超过剩余预算，否则等于把预算当摆设。
      const attemptTimeoutMs = Math.min(spec.timeoutMs, remaining);

      const attemptStarted = clock();
      try {
        const res = await call(spec, messages, { timeoutMs: attemptTimeoutMs });
        const latency = clock() - attemptStarted;

        // 先记账再看内容 —— 一次调用只要发生了就产生了费用，
        // 和它有没有写出合格 JSON 无关。
        const draft = usageDraft(task, spec, res.usage, latency, true, now);
        usages.push(draft);

        const parsed = parseExamplePayload(res.text);
        if (parsed.ok) {
          attempts.push(attemptOf(spec, true, latency));
          log({
            event: "generated",
            word_id: input.wordId,
            interest_tag: input.interestTag,
            provider: spec.provider,
            model: spec.model,
            input_tokens: draft.input_tokens,
            output_tokens: draft.output_tokens,
            cached_tokens: draft.cached_tokens,
            cache_hit: draft.input_tokens > 0 ? draft.cached_tokens / draft.input_tokens : 0,
            cost_cny: draft.cost_cny,
            priced: draft.priced,
            latency_ms: latency,
          });

          // 「降级」= 首选那一档没成，由链上更靠后的档写出来的。
          // 判据是"是不是 chain[0]"，而不是"是不是免费档" ——
          // 这样改顺序时这里不用跟着动，跟着表走就行。
          const degraded = spec.model !== chain[0].model;
          if (degraded) notes.push(`首选档没成，这一句是「${spec.model}」写的。`);

          return {
            payload: parsed.payload,
            source: "ai",
            model: spec.model,
            degraded,
            attempts,
            usages,
            notes,
          };
        }

        // 内容不合格：这次调用已经记账了，只是标成"没产出可用结果"由 attempts 反映。
        // 这里**不退避**：上一次已经正常返回了，窗口是空的，立刻再问一次就行。
        attempts.push(attemptOf(spec, false, latency, `模型输出不合格（${parsed.reason}）`));
        log({
          event: "parse_failed",
          word_id: input.wordId,
          provider: spec.provider,
          model: spec.model,
          reason: parsed.reason,
          cost_cny: draft.cost_cny,
          latency_ms: latency,
        });
        continue;
      } catch (e) {
        const latency = clock() - attemptStarted;
        const kind = e instanceof ProviderError ? e.kind : "unknown";
        const message = e instanceof Error ? e.message : String(e);
        // 「超时」和「连不上」是两件事，别混：
        // 超时多半是模型太慢（换个档/等一等就好），连不上才是网络问题 ——
        // 对用户是两句话，对我也是两条不同的排查线索。
        if (kind === "network") sawNetworkIssue = true;
        if (kind === "timeout") sawTimeout = true;

        attempts.push(attemptOf(spec, false, latency, message));
        usages.push(failedUsageDraft(task, spec, latency));

        const decision = decideAfterFailure(e, {
          attemptIndex: i,
          attemptsPerModel: ATTEMPTS_PER_MODEL,
          hasNextProvider,
        });
        if (decision.coolDown) cooldown.cool(spec.provider, cooldownMs, clock());

        log({
          event: "call_failed",
          word_id: input.wordId,
          provider: spec.provider,
          model: spec.model,
          kind,
          status: e instanceof ProviderError ? e.status : null,
          error: message.slice(0, 200),
          next: decision.action,
          cooled_down: decision.coolDown,
          latency_ms: latency,
        });

        if (decision.action !== "retry_same") break; // 换下一档

        // 退避：等上一次真正跑完，再重试 —— 这是那个"每次都失败"的解药
        const wait = backoffMs(i, backoffBase);
        if (elapsed() + wait >= budgetMs) {
          ranOutOfTime = true;
          log({
            event: "budget_exhausted",
            word_id: input.wordId,
            elapsed_ms: elapsed(),
            budget_ms: budgetMs,
            would_wait_ms: wait,
          });
          break chainLoop;
        }
        await sleep(wait);
      }
    }
  }

  // 为什么落到模板句，要分得清：断网 / 太慢 / 模型没写好，
  // 对用户是三种不同的话，对我排查也是三条不同线索。
  const reason: FallbackReason = sawNetworkIssue
    ? "network"
    : sawTimeout || ranOutOfTime
      ? "too_slow"
      : "model_failed";
  notes.push(fallbackNote(reason));
  log({
    event: "fell_back_to_template",
    word_id: input.wordId,
    interest_tag: input.interestTag,
    reason,
    tier: AI_TASK_TIER[task],
    tried: attempts.map((a) => a.model),
  });

  return {
    payload: templateExample(input.facts, input.interestTag),
    source: "template",
    model: null,
    degraded: true,
    attempts,
    usages,
    notes,
  };
}
