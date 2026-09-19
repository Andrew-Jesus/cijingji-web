/**
 * 前端 ↔ `/api/ai` 的接口契约
 *
 * 这个文件**同时被服务端和客户端引用**，所以它里面**不许有任何秘密**
 * （没有 Key、没有模型名、没有端点地址）。客户端只 `import type`，
 * 编译后不会把 zod 打进包里。
 *
 * 为什么把契约单独成文件：请求/响应各写一遍 = 两处真值来源。
 * 服务端改了字段名，前端拿到的还是旧类型，编译不报错、运行时静默 undefined ——
 * 这种 bug 最难查。所以两边共用同一份定义。
 */
import { z } from "zod";

/** 请求体。**只传 id，不传词的内容** —— 词头/音标/义项由服务端自己查种子数据 */
export const aiRequestSchema = z.strictObject({
  task: z.literal("example_personalized"),
  wordId: z.string().min(1).max(120),
  /** 兴趣域 tag；没选兴趣时传 GENERIC_INTEREST_TAG（"general"） */
  interestTag: z.string().min(1).max(40),
});

export type AiRequest = z.infer<typeof aiRequestSchema>;

/** 模型被要求输出的 JSON 结构。**强制 zod 校验**：模型偶尔会多写几个字，必须拦住 */
export const aiExamplePayloadSchema = z.strictObject({
  sentence: z.string().min(2).max(240),
  gloss: z.string().min(1).max(120),
});

export type AiExamplePayload = z.infer<typeof aiExamplePayloadSchema>;

/** 一次 api 调用的记账草稿。客户端拿到后原样写进本地 `ai_usage` 表 */
export interface AiUsageDraft {
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_cny: number;
  /** false = 价格表里没有这个模型，这笔账**没计价**（不是免费的） */
  priced: boolean;
  /** 计价时是不是高峰时段 */
  peak: boolean;
  latency_ms: number;
  ok: boolean;
}

/** 每一次尝试（含失败与重试）—— 给开发者模式看"到底哪一档挂了" */
export interface AiAttempt {
  model: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export interface AiSuccessResponse {
  ok: true;
  task: string;
  word_id: string;
  interest_tag: string;
  /**
   * `ai` = 模型写的；`template` = 走了兜底模板。
   * 界面**必须**据它如实标注，不能把模板句当 AI 例句展示。
   */
  source: "ai" | "template";
  /** 硬约束 10：AI 生成的内容必须在界面上标出来 */
  is_ai_generated: boolean;
  /** true = 主模型没用上（降级过）。界面上不用喊，开发者模式要看得见 */
  degraded: boolean;
  /** 真正写出这句话的模型名；模板句时为 null */
  model: string | null;
  payload: AiExamplePayload;
  usages: AiUsageDraft[];
  attempts: AiAttempt[];
  /** 人话解释为什么降级 —— 别让"降级了"变成一句没人看得懂的黑话 */
  notes: string[];
  generated_at: string;
}

export interface AiErrorResponse {
  ok: false;
  code: "INVALID_REQUEST" | "WORD_NOT_FOUND" | "INTERNAL";
  message: string;
}

export type AiResponse = AiSuccessResponse | AiErrorResponse;

/** 统一到小数点后 4 位展示（0.0003 元这种数，少一位就没了） */
export function formatCny(n: number): string {
  if (n <= 0) return "¥0";
  if (n < 0.0001) return "<¥0.0001";
  return `¥${n.toFixed(4)}`;
}
