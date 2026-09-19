/**
 * `POST /api/ai` —— AI 网关（阶段 0 唯一一条真实 AI 通路）
 *
 * ── 这个文件存在的唯一理由：**Key 不能进浏览器** ────────────────
 * 它是同一个 Next.js 工程里的服务端代码（Route Handler），
 * 不需要额外部署任何服务，也不算"接了后端"。
 * 浏览器只发一个 `{ task, wordId, interestTag }`，Key 从头到尾待在服务端。
 *
 * ── 三条边界，改这个文件前先读 ─────────────────────────────────
 *   ① **请求体只带 id，不带词的内容。** 词头/音标/词性/义项由服务端
 *      从种子数据里查（见 groundTruth.ts）—— 否则"事实可信"就取决于请求方了。
 *   ② **永远返回 200 + 一句能用的例句**，只要能给。
 *      只有"请求本身不合法"才回 4xx。理由：学习页把例句当固定环节，
 *      因为 AI 的问题让整页报错，是本末倒置。
 *   ③ **错误信息不包含 Key，也不回显上游的原始响应体全文**（截断 400 字且已脱敏处理）。
 */
import { NextResponse } from "next/server";

import {
  aiRequestSchema,
  type AiErrorResponse,
  type AiSuccessResponse,
} from "@/lib/ai/contract";
import { lookupWordFacts } from "@/lib/ai/groundTruth";
import { generateExample } from "@/lib/ai/run";

/** 明确跑在 Node 运行时：要读 process.env（Key）与用 fetch/AbortSignal.timeout */
export const runtime = "nodejs";

function fail(
  code: AiErrorResponse["code"],
  message: string,
  status: number,
): NextResponse<AiErrorResponse> {
  return NextResponse.json<AiErrorResponse>({ ok: false, code, message }, { status });
}

export async function POST(req: Request): Promise<NextResponse<AiSuccessResponse | AiErrorResponse>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("INVALID_REQUEST", "请求体不是合法 JSON", 400);
  }

  const parsed = aiRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return fail("INVALID_REQUEST", `请求不合法：${issues.join("；")}`, 400);
  }

  const { task, wordId, interestTag } = parsed.data;

  // 查不到就如实报错。**不猜词义、不编一个词出来** —— 这是「AI 边界」的底线。
  const facts = lookupWordFacts(wordId);
  if (!facts) {
    return fail("WORD_NOT_FOUND", `本地词库里没有 ${wordId} 这个词的义项，无法为它写例句`, 404);
  }

  try {
    const out = await generateExample({ wordId, interestTag, facts });

    return NextResponse.json<AiSuccessResponse>({
      ok: true,
      task,
      word_id: wordId,
      interest_tag: interestTag,
      source: out.source,
      is_ai_generated: out.source === "ai",
      degraded: out.degraded,
      model: out.model,
      payload: out.payload,
      usages: out.usages,
      attempts: out.attempts,
      notes: out.notes,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    // 走到这里说明降级链本身出了意外（不该发生 —— 最后一档是纯函数）。
    // 宁可给前端一个明确的 500，让前端自己用本地模板句兜住，也不要假装成功。
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ scope: "ai", event: "unhandled", word_id: wordId, error: message }));
    return fail("INTERNAL", `生成例句时发生意外：${message.slice(0, 200)}`, 500);
  }
}
