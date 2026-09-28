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
 *   · 一次调用都没真的发生（`usages` 为空：比如所有档都在冷却中被跳过）
 *
 * **只有这两条。** 尤其注意：**没登录也要写** —— 理由见下。
 *
 * ── 为什么"没登录"不在上面那张清单里（2026-09-28 修，洞八）──────
 * 这里原先写的是 `if (!userId) return { skipped: "no_user" }`，理由是
 * "user_id 为空的行谁都读不到（RLS 只放行 user_id = 自己的行），等于白记"。
 * **那个理由是错的，而且错得不容易发现** —— 它让记账看起来"正常工作"，
 * 只是悄悄少了一部分行，没有任何报错。
 *
 * 一次真实的调用**已经花掉真钱了**，和请求方是谁无关。跳过记账 =
 * 这笔成本从账面上消失 = 你看到的账单比实际花掉的低。
 * 而"匿名 / 未登录"恰恰是最容易失控的那部分流量（有人拿脚本刷接口，
 * 烧的全是你的钱），把它的账抹掉，等于把警报器拆了。
 *
 * 至于"普通用户读不到 user_id 为空的行" —— 那不是缺陷，**是设计**：
 * 那几行本来就不属于任何用户，**项目所有者**（拿 secret key 在 Supabase
 * 后台看，或将来做成本告警）才需要它们。RLS 挡的是别的用户，不是我们自己。
 *
 * 这条在实施方案 §8.3 里是写死的硬约束（"没有用户也要记"）。
 * 现在有一道单测专门盯着它（`usageCloud.test.ts` 的"没登录也必须写"），
 * 想再把它改回去，测试会先红。
 */

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { readServerUserId, type CookiePair } from "@/lib/supabase/server";

import type { AiUsageDraft } from "./contract";

/** 与 `supabase/migrations/0001_stage1_user_tables.sql` 里的 `ai_usage` 逐列对应 */
export interface AiUsageRow {
  id: string;
  /**
   * **允许为 null**，而且不是"待补"的占位 —— 它表示"这笔账没有主人"。
   * 建表 SQL 写的是 `user_id uuid references auth.users(id) on delete set null`，
   * 两处口径必须一致：这里若收紧成 `string`，未登录那条分支就只剩"不写"一条路
   * （这正是洞八当初发生的方式 —— 类型把人逼到了错误的那边）。
   */
  user_id: string | null;
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
  /** 读不出身份时传 `null`（这笔账记在"无主"名下），**它不是"跳过记账"的信号** */
  userId: string | null;
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
  /**
   * 这一批里有几行是"无主"的（没读出身份）。
   * 正常情况是 0；但**出现 > 0 不是错误**，那是"有人没登录也在用 AI"的如实记录。
   * 单独拎出来只是为了让人在日志里一眼看见它，而不是被"写成功"三个字盖过去。
   */
  ownerless: number;
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
  if (usages.length === 0) return { written: 0, ownerless: 0, skipped: "no_call_happened" };

  const admin = getSupabaseAdmin();
  if (!admin) return { written: 0, ownerless: 0, skipped: "no_secret_key" };

  // 读不出身份**不跳过**：这笔钱已经花了，账面上必须留着（见文件头"洞八"那段）。
  // 这里唯一正确的做法就是把 null 一路传到 user_id 上。
  const userId = await readServerUserId(cookies);
  const rows = buildUsageRows({ usages, userId, at });

  const { error } = await admin.from("ai_usage").insert(rows);
  if (error) {
    return { written: 0, ownerless: 0, skipped: `insert_failed: ${error.message.slice(0, 160)}` };
  }

  return { written: rows.length, ownerless: userId ? 0 : rows.length, skipped: null };
}
