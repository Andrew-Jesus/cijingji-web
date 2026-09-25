/**
 * 模型调用 —— **服务端专属**
 *
 * 两家（DeepSeek / 智谱）都提供 OpenAI 兼容的 `/chat/completions`，
 * 所以这里只有**一份**调用代码。加第三家只要它兼容，就不用改这里。
 *
 * 三条刻意的实现选择：
 *   ① **不装 SDK，直接 fetch。** 目的很实在：SDK 会隐藏"到底发了什么请求、
 *      用了多少 token"这些细节，而本项目的硬约束恰恰是"每次调用必须记账、
 *      缓存命中要看得见"。看得见 raw response 比少写十行代码重要。
 *   ② **必须超时。** 例句只有一两句话，正常 1~3 秒。等 30 秒不如直接降级去写模板句 ——
 *      用户的耐心比模型的面子值钱。
 *   ③ **错误分三类**（网络 / 超时 / HTTP），因为**要不要重试取决于类别**：
 *      超时和网络抖动值得重试一次；401/400 这种重试一百次也一样，还白花钱。
 */
import { MAX_OUTPUT_TOKENS, type ModelSpec } from "./config";

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface ChatCallResult {
  text: string;
  usage: ChatUsage;
}

export type ProviderErrorKind = "network" | "timeout" | "http" | "malformed";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;

  constructor(kind: ProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

/** 只有这三类值得再试一次。HTTP 4xx 是"请求本身不对"，重试是浪费钱 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (err.kind === "network" || err.kind === "timeout") return true;
    // 5xx / 429 是对方的临时问题，值得再试
    if (err.kind === "http") return err.status !== null && (err.status >= 500 || err.status === 429);
    return false; // malformed = 模型没写出合格 JSON，交给上层按 schema 失败处理
  }
  return true; // 未知异常，给一次机会
}

/**
 * 撞限流（429）。
 *
 * 为什么单独认它：免费档**并发只有 1**，429 的常见成因不是"我们请求太多"，
 * 而是"上一次还在跑"。所以它的对策和别的错误不一样 ——
 * **优先换下一档**，换不了才退避重试（见 `retry.ts`）。
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ProviderError && err.kind === "http" && err.status === 429;
}

/**
 * 这一档"账号本身有问题"的失败：Key 不对（401/403）、余额不足（402）。
 *
 * 判它的目的只有一个：**给这一档打个冷却标记**。
 * 实测里 DeepSeek 是余额不足，但它每次请求都先被试一遍、白等一轮才轮到兜底 ——
 * 这类失败在几分钟内重试一百次结果完全一样，唯一的正解是**先别试它**。
 */
export function isFatalProviderConfig(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.kind !== "http" || err.status === null) return false;
  return err.status === 401 || err.status === 402 || err.status === 403;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 从 usage 里取缓存命中的输入 tokens。
 * 两家的字段名不一样，所以两个都认：
 *   · DeepSeek：`prompt_cache_hit_tokens`（顶层）
 *   · OpenAI 系（智谱部分模型）：`prompt_tokens_details.cached_tokens`
 * 取不到就记 0 —— **这是如实记 0，不是"没缓存"的结论**，
 * 界面上因此要把"没有缓存数据"和"命中率 0%"区分开（见 usageStats）。
 */
function readCachedTokens(usage: Record<string, unknown>): number {
  const direct = num(usage.prompt_cache_hit_tokens);
  if (direct > 0) return direct;
  const details = asRecord(usage.prompt_tokens_details);
  return details ? num(details.cached_tokens) : 0;
}

export interface CallOptions {
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
}

export async function callChatCompletion(
  spec: ModelSpec,
  messages: { role: "system" | "user"; content: string }[],
  opts: CallOptions,
): Promise<ChatCallResult> {
  const body = {
    model: spec.model,
    messages,
    // JSON 模式：两家都支持，能挡掉"前面先写一句客气话"这类格式噪声
    response_format: { type: "json_object" },
    // 0.7：例句需要一点变化（同一个词两次别写出同一句），但不能飘到跑题
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(`${spec.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${spec.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    // AbortSignal.timeout 触发时抛的是 TimeoutError（name 可能因运行时不同而不同），
    // 所以按名字和消息双判，避免把超时误报成"网络不可达"
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(msg)) {
      throw new ProviderError("timeout", `请求超时（>${opts.timeoutMs}ms）`, null);
    }
    throw new ProviderError("network", `连不上模型服务：${msg}`, null);
  }

  if (!res.ok) {
    // 错误体可能很长，截断后记进日志 —— 但**不把 Key 回显出去**
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      detail = "(读不到错误详情)";
    }
    throw new ProviderError("http", `HTTP ${res.status}：${detail}`, res.status);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ProviderError("malformed", "响应不是合法 JSON", null);
  }

  const root = asRecord(payload);
  const choices = root ? root.choices : null;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = first ? asRecord(first.message) : null;
  const content = message ? message.content : null;

  if (typeof content !== "string" || content.trim() === "") {
    throw new ProviderError("malformed", "响应里没有可用的文本内容", null);
  }

  const usageRaw = root ? asRecord(root.usage) : null;
  const usage: ChatUsage = usageRaw
    ? {
        input_tokens: num(usageRaw.prompt_tokens),
        output_tokens: num(usageRaw.completion_tokens),
        cached_tokens: readCachedTokens(usageRaw),
      }
    : { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

  return { text: content, usage };
}
