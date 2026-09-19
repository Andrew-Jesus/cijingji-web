/**
 * AI 编排 —— 降级链 + 重试 + 记账
 *
 * ── 三级降级链（方案 §8）────────────────────────────────────
 *   DeepSeek Flash  →  智谱 GLM-Flash（免费兜底）  →  模板句
 *
 * 前两档是"模型和模型的区别"，第三档是**确定性兜底**：
 * 它不依赖网络、不依赖 Key、不可能失败。有了它，
 * 「学习页永不因 AI 失败而卡住」这句话才是真的，而不是一句愿望。
 *
 * ── 重试策略（省钱的地方，值得写清楚）────────────────────────
 * **每个模型最多试 2 次（首次 + 重试 1 次）**，但重试是有条件的：
 *   · 超时 / 网络抖动 / 5xx / 429  → 重试（多半是临时的）
 *   · 401 / 400 这类 4xx          → **不重试**（请求本身不对，试一百次也一样，纯烧钱）
 *   · 模型返回了内容但 JSON 不合格 → 重试（这类通常第二次就对了，
 *     而且**这次调用的 token 照样要记账** —— 失败也花了钱，不记就是假账）
 *
 * ── 记账 ────────────────────────────────────────────────────
 * 每一次**真实发生的 API 调用**都产出一条 `AiUsageDraft`，
 * 包括失败的那几次（tokens 取不到就记 0，并且 `ok:false`）。
 * 服务端同时打一行结构化日志 —— 服务端是唯一可信来源，
 * 本地的 `ai_usage` 是"给用户看得见"的副本，两者字段同构。
 */
import {
  DEFAULT_TIMEOUT_MS,
  resolveModelChain,
  resolveTimeoutMs,
  type ModelSpec,
} from "./config";
import type { AiAttempt, AiExamplePayload, AiUsageDraft } from "./contract";
import { estimateCost } from "./cost";
import { fallbackNote, templateExample, type FallbackReason } from "./fallback";
import { parseExamplePayload } from "./parse";
import { buildPrompt, type WordFacts } from "./prompt";
import { callChatCompletion, ProviderError, isRetryable } from "./provider";

/** 每个模型最多试几次（含首次）。写成常量是为了让它显式可改，而不是散在循环里 */
export const ATTEMPTS_PER_MODEL = 2;

export interface GenerateExampleInput {
  wordId: string;
  interestTag: string;
  facts: WordFacts;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** 注入日志出口，便于测试断言"有没有记账/有没有打日志" */
  log?: (record: Record<string, unknown>) => void;
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
  spec: ModelSpec,
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  latency: number,
  ok: boolean,
  at: Date,
): AiUsageDraft {
  const cost = estimateCost(spec.model, usage, at);
  return {
    task: "example_personalized",
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

/**
 * 失败后判断该不该再试一次。
 * 这是本地判据（"这次的错误类型值得重试吗"），与 `provider.isRetryable` 的分工是：
 * 后者只认错误类型，前者还要看"这是第几次"。
 */
function shouldRetry(attemptIndex: number, err: unknown): boolean {
  if (attemptIndex >= ATTEMPTS_PER_MODEL - 1) return false;
  return isRetryable(err);
}

export async function generateExample(input: GenerateExampleInput): Promise<GenerateExampleOutput> {
  const now = input.now ?? new Date();
  const timeoutMs = resolveTimeoutMs(input.env);
  const chain = resolveModelChain(input.env);
  const log = input.log ?? ((record) => console.log(JSON.stringify({ scope: "ai", ...record })));

  const attempts: AiAttempt[] = [];
  const usages: AiUsageDraft[] = [];
  const notes: string[] = [];
  let sawNetworkIssue = false;

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

  const prompt = buildPrompt("example_personalized", {
    facts: input.facts,
    interestTag: input.interestTag,
  });
  const messages = [
    { role: "system" as const, content: prompt.fixed },
    { role: "user" as const, content: prompt.variable },
  ];

  for (const spec of chain) {
    for (let i = 0; i < ATTEMPTS_PER_MODEL; i++) {
      const startedAt = Date.now();
      try {
        const res = await callChatCompletion(spec, messages, { timeoutMs });
        const latency = Date.now() - startedAt;

        // 先记账再看内容 —— 一次调用只要发生了就产生了费用，
        // 和它有没有写出合格 JSON 无关。
        const draft = usageDraft(spec, res.usage, latency, true, now);
        usages.push(draft);

        const parsed = parseExamplePayload(res.text);
        if (parsed.ok) {
          attempts.push(attemptOf(spec, true, latency));
          log({
            event: "generated",
            word_id: input.wordId,
            interest_tag: input.interestTag,
            model: spec.model,
            input_tokens: draft.input_tokens,
            output_tokens: draft.output_tokens,
            cached_tokens: draft.cached_tokens,
            cache_hit: draft.input_tokens > 0 ? draft.cached_tokens / draft.input_tokens : 0,
            cost_cny: draft.cost_cny,
            priced: draft.priced,
            latency_ms: latency,
          });

          const degraded = spec.model !== chain[0].model;
          if (degraded) notes.push(`主模型没成，这一句是「${spec.model}」写的。`);

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

        // 内容不合格：这次调用已经记账了，只是标成"没产出可用结果"由 attempts 反映
        attempts.push(attemptOf(spec, false, latency, `模型输出不合格（${parsed.reason}）`));
        log({
          event: "parse_failed",
          word_id: input.wordId,
          model: spec.model,
          reason: parsed.reason,
          cost_cny: draft.cost_cny,
          latency_ms: latency,
        });

        if (i < ATTEMPTS_PER_MODEL - 1) continue; // 内容问题值得再试一次
        break;
      } catch (e) {
        const latency = Date.now() - startedAt;
        const kind = e instanceof ProviderError ? e.kind : "unknown";
        const message = e instanceof Error ? e.message : String(e);
        if (kind === "timeout" || kind === "network") sawNetworkIssue = true;

        attempts.push(attemptOf(spec, false, latency, message));
        // 失败也记账：拿不到 tokens 就记 0，但**这一笔发生过**这件事必须留下
        usages.push({
          task: "example_personalized",
          model: spec.model,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cost_cny: 0,
          priced: true,
          peak: false,
          latency_ms: latency,
          ok: false,
        });
        log({
          event: "call_failed",
          word_id: input.wordId,
          model: spec.model,
          kind,
          error: message.slice(0, 200),
          will_retry: shouldRetry(i, e),
          latency_ms: latency,
        });

        if (shouldRetry(i, e)) continue;
        break;
      }
    }
  }

  const reason: FallbackReason = sawNetworkIssue ? "network" : "model_failed";
  notes.push(fallbackNote(reason));
  log({
    event: "fell_back_to_template",
    word_id: input.wordId,
    interest_tag: input.interestTag,
    reason,
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

export { DEFAULT_TIMEOUT_MS };
