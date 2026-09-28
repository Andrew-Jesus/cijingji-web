/**
 * 记账上云 —— 把 `generateExample` 产出的账目写进 Supabase 的 `ai_usage` 表
 *
 * ── 和本地那份的关系：**双写，不是同步** ─────────────────────
 * /api/ai 每次调用会产出两种账：
 *   · **云端这份**（本文件）：权威账。谁都能被它统计，换设备也看得到。
 *   · **本地那份**（`lib/db/studyRepo.ts` 的 `recordAiUsage`）：给开发者模式
 *     在**断网时**还能看见自己的账，仅此而已。
 *
 * 本地那份**刻意不参与同步**（见 `lib/sync/claim.ts` 里"ai_usage 不认领"那段）：
 * 两边都推的话，同一笔调用会在云端存成两行，成本直接翻倍 ——
 * 一份记账表开始重复计算，它就再也算不准了。
 *
 * ── 为什么两边的行 id 不一样也没关系 ─────────────────────────
 * 任务单和例句的 id 必须两边一致，因为它们是**同一个对象**（要 upsert 幂等）。
 * 账目不是：本地一条、云端一条，是两笔独立的记录，没有谁去认领谁。
 * 所以云端这份 id 直接随机生成，不跟本地对齐 —— 也免得"看起来像同一条、
 * 其实要靠 id 去重"这种错觉。
 *
 * ── 什么时候不写 ─────────────────────────────────────────────
 *   · 没配 secret key（`getSupabaseAdmin()` 返回 null）
 *   · 没登录（读不出用户 id）
 *   · 一次调用都没真的发生（`usages` 为空：比如所有档都在冷却中被跳过）
 * 三种都**静默**，只留一行结构化日志。记账失败的后果应该是"少一条账"，
 * 而不是"用户看到报错"。
 */

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { readServerUserId, type CookiePair } from "@/lib/supabase/server";

import type { AiUsageDraft } from "./contract";

/** 与 `supabase/migrations/0001_stage1_user_tables.sql` 里的 `ai_usage` 逐列对应 */
export interface AiUsageRow {
  id: string;
  user_id: string;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_cny: number;
  priced: boolean;
  peak: boolean;
  latency_ms: number;
  ok: boolean;
  created_at: string;
}

export interface BuildRowsInput {
  usages: readonly AiUsageDraft[];
  /** 已经有身份了才走到这一步，所以这里是 `string` 而不是 `string | null` */
  userId: string;
  /** 这一批账记在哪个时刻。同一次调用的几条（含失败的）共用它，便于按批核对 */
  at: Date;
  /** id 生成器。抽出来是为了单测能断言 id 长什么样（不然每次都变） */
  newId?: () => string;
}

/**
 * 纯函数：账目草稿 → 可入库的行。
 *
 * **每条草稿一行**，包括失败的尝试。这是硬约束「每次调用必须记账（失败也记）」
 * 落到云端这一侧的写法，也是"云端条数 = 本地条数"这个核对项能成立的前提
 * —— 两边要是聚合口径不同（一边逐次、一边汇总），条数永远对不上，
 * 那个核对项也就废了。
 */
export function buildUsageRows(input: BuildRowsInput): AiUsageRow[] {
  const newId = input.newId ?? (() => `ai:${crypto.randomUUID()}`);
  const createdAt = input.at.toISOString();

  return input.usages.map((u) => ({
    id: newId(),
    user_id: input.userId,
    task: u.task,
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cached_tokens: u.cached_tokens,
    cost_cny: u.cost_cny,
    priced: u.priced,
    peak: u.peak,
    latency_ms: u.latency_ms,
    ok: u.ok,
    created_at: createdAt,
  }));
}

export interface PersistResult {
  written: number;
  /** 没写的原因（写成功时为 null）。给日志用，不抛给上层 */
  skipped: string | null;
}

/**
 * 真正去写库。**放在 `after()` 里调用**，所以它慢一点没关系，但绝不能抛错
 * —— 这里仍然自己兜一层 try/catch，把失败变成一条日志。
 */
export async function persistAiUsage(
  usages: readonly AiUsageDraft[],
  cookies: readonly CookiePair[],
  at: Date = new Date(),
): Promise<PersistResult> {
  if (usages.length === 0) return { written: 0, skipped: "no_call_happened" };

  const admin = getSupabaseAdmin();
  if (!admin) return { written: 0, skipped: "no_secret_key" };

  const userId = await readServerUserId(cookies);
  // 未登录不写：`ai_usage.user_id` 虽然可空（留给将来的共享资产），
  // 但一行谁都读不到的账（RLS 只放行 user_id = 自己的行）等于白记。
  if (!userId) return { written: 0, skipped: "no_user" };

  const rows = buildUsageRows({ usages, userId, at });

  const { error } = await admin.from("ai_usage").insert(rows);
  if (error) return { written: 0, skipped: `insert_failed: ${error.message.slice(0, 160)}` };

  return { written: rows.length, skipped: null };
}
