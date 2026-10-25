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

/**
 * 请求体。**只传 id，不传内容** —— 词头/音标/义项、单元词表都由服务端自己查。
 *
 * ── 为什么用 discriminated union 而不是一个宽对象 ──────────────────
 * 两个任务要的参数根本不是一套：例句要"哪个词 + 什么兴趣"，完形要"哪个单元"。
 * 写成 `{ wordId?: string; unitId?: string }` 这种宽对象，就会出现
 * "两样都不传也通过校验"的请求 —— 然后在服务端拿 `undefined` 去查库，
 * 报一个跟真实原因无关的错。
 * 按 `task` 分叉之后，**每种请求只允许出现它自己的字段**（`strictObject`），
 * 传错字段会当场 400，而不是被默默忽略。
 */
export const exampleRequestSchema = z.strictObject({
  task: z.literal("example_personalized"),
  wordId: z.string().min(1).max(120),
  /** 兴趣域 tag；没选兴趣时传 GENERIC_INTEREST_TAG（"general"） */
  interestTag: z.string().min(1).max(40),
});

/**
 * 完形填空的请求。
 *
 * `unitId` 是**单元 id**（如 `wys_2024:8A:U1`），不是 `unit_code`。
 * ⚠️ 这条别搞混：`unit_code`（"Unit 1"）在三册里是重号的，
 * 拿它去分组会把三个单元的题悄悄并成一格，且不报错。
 *
 * `refresh: true` = 不要缓存、重新出一套（用户做完了想换一篇）。
 * 它**不是**"绕过审核"—— 新生成的题照样要过三道审核。
 */
export const clozeRequestSchema = z.strictObject({
  task: z.literal("cloze_generate"),
  unitId: z.string().min(1).max(160),
  refresh: z.boolean().optional(),
});

export const aiRequestSchema = z.discriminatedUnion("task", [
  exampleRequestSchema,
  clozeRequestSchema,
]);

export type AiRequest = z.infer<typeof aiRequestSchema>;

/** 模型被要求输出的 JSON 结构。**强制 zod 校验**：模型偶尔会多写几个字，必须拦住 */
export const aiExamplePayloadSchema = z.strictObject({
  sentence: z.string().min(2).max(240),
  gloss: z.string().min(1).max(120),
});

export type AiExamplePayload = z.infer<typeof aiExamplePayloadSchema>;

/**
 * 完形填空一个空的模型输出结构。
 *
 * 上限都定得比较宽（选项 40 字符、词 40 字符），因为**卡太紧会误伤合格题**：
 * 一个 3 词短语当选项是正常的，而被误判成不合格的代价是"重试一次 + 用户干等"。
 * 真正该卡死的（数量、互不重复、下标范围、挖空词在不在词表里）
 * 交给 `lib/study/cloze.ts` 那三道审核 —— 那里能给出人话原因，比 zod 的报错好排查。
 */
export const clozeBlankPayloadSchema = z.object({
  no: z.number().int().min(1).max(20),
  options: z.array(z.string().min(1).max(40)).length(4),
  answer: z.number().int().min(0).max(3),
  word: z.string().min(1).max(40),
});

/**
 * 完形填空的模型输出结构。
 *
 * ⚠️ 这里用 `z.object`（**剥掉**多余字段）而不是 `z.strictObject`（**拒绝**多余字段），
 * 与例句那边刻意不同。理由：例句只有两个字段，模型多写一个"explanation"说明它在自由发挥，
 * 那种情况该废掉重写；而完形有 10 个嵌套对象，模型多写一个 `"tip"` 或 `"explanation"`
 * 是**很自然且无害**的（我们不用就是了）。为一个用不上的字段废掉一道好题，
 * 换来的只是又一次 25 秒的等待。
 */
export const aiClozePayloadSchema = z.object({
  title: z.string().min(1).max(60),
  /** 短文原文，空位写成 `{{1}}` … `{{10}}` */
  passage: z.string().min(50).max(4000),
  blanks: z.array(clozeBlankPayloadSchema).length(10),
});

export type AiClozePayload = z.infer<typeof aiClozePayloadSchema>;

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
  task: "example_personalized";
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

/**
 * 完形填空的成功响应。
 *
 * 单独一个 interface、不跟例句共用一个宽对象，是因为**两边字段名根本对不上**：
 * 例句有 `word_id` / `interest_tag`，完形有 `unit_id`，两者互不存在。
 * 塞进同一个对象就得把四个字段全标成可选 —— 然后前端读 `data.payload.sentence`
 * 时拿到 `undefined`，而 TS 一声不吭。分成两个，读错字段编译就报错。
 */
export interface AiClozeSuccessResponse {
  ok: true;
  task: "cloze_generate";
  unit_id: string;
  /**
   * 人话的单元名（「外研社版 · 八年级上册 · Unit 1 This is me」）。
   *
   * 为什么要服务端带回来：服务端本来就有（提示词里要用它），
   * 而前端要显示它就得自己 join 三张表（units / volumes / curricula）。
   * 让前端再算一遍 = 两处拼法，迟早一处显示"八年级上册"、一处显示"八上"。
   */
  unit_label: string;
  /**
   * `ai` = 模型写的；`template` = 走了兜底模板。
   *
   * 完形填空的兜底模板是**一篇写死的、内容中性的短文**（见 `fallback.ts`）——
   * 不是"随便凑的 10 个空"。用户做的每一道题都是完整可做的，
   * 只是它跟他的单元词表无关，所以界面**必须**据 `source` 如实标注。
   */
  source: "ai" | "template";
  /** 硬约束 10：AI 生成的内容必须在界面上标出来 */
  is_ai_generated: boolean;
  degraded: boolean;
  model: string | null;
  payload: AiClozePayload;
  usages: AiUsageDraft[];
  attempts: AiAttempt[];
  notes: string[];
  generated_at: string;
}

export interface AiErrorResponse {
  ok: false;
  code: "INVALID_REQUEST" | "WORD_NOT_FOUND" | "UNIT_NOT_FOUND" | "INTERNAL";
  message: string;
}

export type AiResponse = AiSuccessResponse | AiClozeSuccessResponse | AiErrorResponse;

/** 统一到小数点后 4 位展示（0.0003 元这种数，少一位就没了） */
export function formatCny(n: number): string {
  if (n <= 0) return "¥0";
  if (n < 0.0001) return "<¥0.0001";
  return `¥${n.toFixed(4)}`;
}
