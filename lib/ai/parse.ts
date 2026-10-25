/**
 * 模型输出的解析 —— 纯函数，可单测
 *
 * 为什么值得单独一个文件：**模型不会老老实实只输出 JSON**。
 * 实测常见的三种跑偏：
 *   ① 包在 markdown 代码块里：```json { ... } ```
 *   ② 前面加一句"好的，这是你要的句子："
 *   ③ 输出 JSON 但字段名写歪了（"sentences" / "translation"）
 *
 * 这三种的处理方式不一样，必须区分：
 *   ①② 是"格式噪声"，剥掉外壳就能用 —— 不该为它浪费一次重试（一次调用也是钱）；
 *   ③ 是"内容不合格"，重试一次通常能修好。
 * 所以解析函数返回**结构化的失败原因**，让上层决定要不要重试，而不是一律当失败。
 */
import { aiClozePayloadSchema, aiExamplePayloadSchema, type AiClozePayload, type AiExamplePayload } from "./contract";

export type ParseFailure = "no_json" | "schema_mismatch";

export type ParseResult =
  | { ok: true; payload: AiExamplePayload }
  | { ok: false; reason: ParseFailure };

/**
 * 从一段自由文本里抠出第一个**平衡**的 JSON 对象。
 *
 * 为什么不用"取第一个 { 到最后一个 }"：模型有时会在 JSON 后面再补一句解释，
 * 那样最后一个 `}` 就不属于这个对象，截出来的字符串解析必然失败。
 * 所以按括号配平扫描（并且正确处理字符串里的花括号与转义）。
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null; // 括号没配平 = 模型输出被截断了
}

/** 剥掉 markdown 代码块外壳。没包外壳时原样返回（不能无脑 replace，会误伤内容里的反引号） */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline < 0) return trimmed;

  const body = trimmed.slice(firstNewline + 1);
  const end = body.lastIndexOf("```");
  return (end >= 0 ? body.slice(0, end) : body).trim();
}

/**
 * 解析成 `{ sentence, gloss }`。
 *
 * 注意这里**不做任何"修补"** —— 比如 sentence 太长就截断、gloss 缺了就拿 sentence 顶上。
 * 修补出来的内容会以"AI 给你写的例句"的身份出现在界面上，而它其实是残缺的。
 * 宁可判失败去重试，重试也不成就如实降到模板句。
 */
export function parseExamplePayload(raw: string): ParseResult {
  const text = stripCodeFence(raw);
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: "no_json" };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, reason: "no_json" };
  }

  const parsed = aiExamplePayloadSchema.safeParse(value);
  if (!parsed.success) {
    // 这里**刻意不做"能救就救"**：比如模型只给了 sentence 没给 gloss 时，
    // 顺手拿 sentence 顶替 gloss 是能跑，但那句中文是我编的，
    // 却会以"AI 给你写的例句"的身份出现在界面上。
    // 判失败 → 上层重试一次 → 还不行就如实降到模板句并标注。这条路更慢，但每句话都是真的。
    return { ok: false, reason: "schema_mismatch" };
  }

  return { ok: true, payload: parsed.data };
}

/** 完形填空的解析结果。返回形状与例句那个同构，上层执行器才能共用一条链 */
export type ClozeParseResult =
  | { ok: true; payload: AiClozePayload }
  | { ok: false; reason: ParseFailure };

/**
 * 解析成 `{ title, passage, blanks[] }`。
 *
 * ── 与例句解析共用的两件事 ──────────────────────────────────
 * `stripCodeFence` 与 `extractJsonObject` 都直接用，不另写一套：
 * 它们解决的是"模型爱包 markdown 壳""后面爱补一句解释"这两个**通用**毛病，
 * 跟任务无关。各任务各写一遍，迟早出现"例句能解析、完形不能"的诡异差异。
 *
 * ── 这里**只做格式转换**，不做业务校验 ────────────────────────
 * 空数对不对、选项重不重复、挖空词在不在词表里 —— 全部交给
 * `lib/study/cloze.ts` 那三道审核。分开的好处：
 *   · zod 的报错是"expected array, received string"这种，排查时看不出人话；
 *     审核给的是「第 3 空考的是 butterfly，它不在本单元词表里」；
 *   · 审核要跑两遍（生成后 + 从缓存读出来），解析只跑一遍。
 *
 * ⚠️ `extractJsonObject` 是按**括号配平**扫描的，而 passage 里有 `{{1}}` 这种
 * 双花括号 —— 它之所以不会算错，是因为扫描器在字符串内部会跳过所有括号
 * （`inString` 分支）。改动那个函数时务必保住这条。
 */
export function parseClozePayload(raw: string): ClozeParseResult {
  const text = stripCodeFence(raw);
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: "no_json" };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, reason: "no_json" };
  }

  const parsed = aiClozePayloadSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "schema_mismatch" };

  return { ok: true, payload: parsed.data };
}
