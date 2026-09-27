"use client";

/**
 * 同步器 —— 把「本地工作台」和「云端总账」对齐（实施方案 §7）
 *
 * ── 为什么同步要放在浏览器里做，而不是服务端 ──────────────────
 * 因为**本地那份数据就在浏览器里**（IndexedDB）。要让服务端来同步，
 * 就得把整库先搬到服务端、算完再搬回来 —— 那还不如直接在浏览器里算。
 * 而且断网时浏览器版照样能跑（它压根不需要网络就能做完"合并"这一步，
 * 只有推/拉那两下需要网），这正是验收 V2 要的性质。
 *
 * ── 每次同步干四件事，顺序不能换 ───────────────────────────
 *   ① **认领**：把本机挂着 `"local"` 的旧数据改成真实 uuid
 *      （不先做这步，推上去会被 RLS 拒，报的还是看不太懂的权限错）
 *   ② **拉**：把云端该用户的四张表整份取回来
 *   ③ **合**：逐表按规则合并（§7.3，规则都在 mergePlan / mergeProfile 里）
 *   ④ **写回**：合并结果同时落到本地与云端 —— 两边才真的对齐
 *
 * ⚠️ ②③ 必须在 ④ 之前。**先推后拉是错的**：那样推上去的本地值会盖掉云端
 * 更新的一份，等下一次拉回来时，云端那份已经没了 —— 用户的改动就这样静默消失。
 *
 * ── 三条不变的脾气 ────────────────────────────────────────────
 *   · **绝不抛错给界面**：同步是后台的事。在学习页做题时弹一条"同步失败"，
 *     只会让人以为自己的进度丢了（§7.5）。
 *   · **不做增量**：每次全量拉该用户的四张表。理由见 §7.4 ——
 *     增量要记"上次同步到几点"，而那是**本机时钟**，手机时间不准就会永久漏一段记录。
 *   · **并发安全**：同一时刻只允许跑一次，后来的调用复用同一个 Promise。
 *     首页加载与 online 事件很容易同时触发，不锁就会两份流程互相踩。
 */
import { db } from "@/lib/db/local";
import type { DailyPlan, Profile, ReviewLog, UserExample } from "@/lib/db/types";
import {
  getSupabaseBrowserClient,
  readLocalSession,
  type BrowserSupabaseClient,
} from "@/lib/supabase/client";

import { claimLocalData } from "./claim";
import { pickPlan } from "./mergePlan";
import { pickProfile } from "./mergeProfile";

/** 什么时候trigger的同步。只为排查用（"到底哪个时机把它跑起来的"） */
export type SyncReason = "login" | "home" | "session-end" | "online" | "manual";

export interface SyncResult {
  status: "ok" | "skipped" | "failed";
  reason: SyncReason;
  /** 本次认领了多少行旧数据 */
  claimed: number;
  /** 本次往云端写了多少行 */
  pushed: number;
  /** 本次从云端取回本地多少行 */
  pulled: number;
  error?: string;
}

/**
 * 每次推送的分批大小。
 * Supabase 的请求体有上限，一把推几千行会被直接拒掉 ——
 * 而"被拒"在我们这里是静默的（不弹错），所以**宁可小一点、多跑几趟**。
 */
const PUSH_CHUNK = 500;

const SKIPPED = (reason: SyncReason): SyncResult => ({
  status: "skipped",
  reason,
  claimed: 0,
  pushed: 0,
  pulled: 0,
});

let inFlight: Promise<SyncResult> | null = null;

/**
 * 跑一次同步。**调用方通常不 await 它**（`void syncNow("home")`）：
 * 界面的节奏不该等网络。
 */
export function syncNow(reason: SyncReason): Promise<SyncResult> {
  if (inFlight) return inFlight;

  const running = runSync(reason).finally(() => {
    // 用 `===` 确认清掉的是自己这一次 —— 否则会把后来者的锁误删
    if (inFlight === running) inFlight = null;
  });

  inFlight = running;
  return running;
}

/** 现在有没有同步在跑（给开发者模式看） */
export function isSyncing(): boolean {
  return inFlight !== null;
}

async function runSync(reason: SyncReason): Promise<SyncResult> {
  // 没接账号系统 → 纯本地模式，本来就没有"云端"这回事
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return SKIPPED(reason);

  // 没登录（或读不出来）→ 不同步。**不报错**：
  // 未登录也能正常背单词，只是进度留在本机而已。
  const session = await readLocalSession();
  if (session.status !== "session") return SKIPPED(reason);
  const userId = session.userId;

  let claimed = 0;
  let pushed = 0;
  let pulled = 0;

  try {
    // ① 认领（幂等，每次跑一遍也不亏）
    claimed = (await claimLocalData(userId)).total;

    // ② 拉
    const remote = await pullAll(supabase, userId);

    // ③④ 逐表合并并双向写回
    const profileDelta = await syncProfiles(supabase, userId, remote.profiles);
    pushed += profileDelta.pushed;
    pulled += profileDelta.pulled;

    const planDelta = await syncPlans(
      supabase,
      ownedBy(await db.daily_plans.toArray(), userId),
      remote.plans,
    );
    pushed += planDelta.pushed;
    pulled += planDelta.pulled;

    // 只推属于这个人的行 —— 本机可能还留着上一个人的记录（登出不清库），
    // 一起推上去会被 RLS 整批拒掉，连累整次同步。见 ownedBy 的注释。
    const logDelta = await syncAppendOnly(
      supabase,
      "review_logs",
      ownedBy(await db.review_logs.toArray(), userId),
      remote.logs,
    );
    pushed += logDelta.pushed;
    pulled += logDelta.pulled;

    const exampleDelta = await syncAppendOnly(
      supabase,
      "user_examples",
      ownedBy(await db.user_examples.toArray(), userId),
      remote.examples,
    );
    pushed += exampleDelta.pushed;
    pulled += exampleDelta.pulled;

    return { status: "ok", reason, claimed, pushed, pulled };
  } catch (error) {
    // 静默失败：界面不显示、不打断用户。下一轮同步会再试一次（全量，天然可重试）。
    return {
      status: "failed",
      reason,
      claimed,
      pushed,
      pulled,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ------------------------------------------------------------------ 拉

interface RemoteSnapshot {
  profiles: Profile[];
  plans: DailyPlan[];
  logs: ReviewLog[];
  examples: UserExample[];
}

/**
 * 拉云端全量。
 *
 * `profiles` 按 `id` 过滤，其余按 `user_id` —— 别抄错，
 * 前者的主键就是 `auth.users.id`（见建表 SQL 的注释）。
 *
 * 其实 RLS 已经保证读不到别人的行了，这里再显式写一遍过滤条件是**为了走索引**：
 * 没有 `where` 的话，Postgres 要先把策略套到全表上再说。
 */
async function pullAll(
  supabase: BrowserSupabaseClient,
  userId: string,
): Promise<RemoteSnapshot> {
  const [profiles, plans, logs, examples] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId),
    supabase.from("daily_plans").select("*").eq("user_id", userId),
    supabase.from("review_logs").select("*").eq("user_id", userId),
    supabase.from("user_examples").select("*").eq("user_id", userId),
  ]);

  const failure = profiles.error ?? plans.error ?? logs.error ?? examples.error;
  if (failure) throw new Error(`拉取云端数据失败：${failure.message}`);

  return {
    profiles: (profiles.data ?? []) as Profile[],
    plans: (plans.data ?? []) as DailyPlan[],
    logs: (logs.data ?? []) as ReviewLog[],
    examples: (examples.data ?? []) as UserExample[],
  };
}

// ------------------------------------------------------------------ 写

/**
 * 只留**属于这个人**的行。
 *
 * ── 为什么非要有这一层（这是"换个人登录"这条路上的致命一刀）──────
 * 登出**不清库** —— 这是有意的（同一个人重新登录时，本机数据还在，
 * 断网也能接着背）。但代价是：本机可能同时躺着**两个人的记录**。
 *
 * 若不过滤，就会把上一个人的行当成"我要推上去的"，而它挂的是上一个人的 uuid：
 *   `with check (auth.uid() = user_id)` 不过 → 整批 upsert 被 RLS 拒 →
 *   **整次同步失败**。注意 `syncAppendOnly` 是先推后拉，
 *   所以连"这个人自己的数据"也拉不下来 —— 表现是"换设备后什么都没同步"。
 *
 * 更糟的是它**不报错**（同步按设计静默，见本文件头部第三条脾气），
 * 用户只会觉得"这破同步根本没生效"，而日志里什么都没有。
 */
function ownedBy<T extends { user_id: string }>(rows: readonly T[], userId: string): T[] {
  return rows.filter((row) => row.user_id === userId);
}

/** 往云端写。返回真正写成功的行数。 */
async function pushRows(
  supabase: BrowserSupabaseClient,
  table: string,
  rows: readonly unknown[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let sent = 0;
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    const batch = rows.slice(i, i + PUSH_CHUNK);
    const { error } = await supabase.from(table).upsert(batch);
    if (error) throw new Error(`写入 ${table} 失败：${error.message}`);
    sent += batch.length;
  }
  return sent;
}

interface Delta {
  pushed: number;
  pulled: number;
}

// ------------------------------------------------------------------ 画像

/**
 * 一个人只有一份画像 —— 所以是"选一份"，不是"并起来"（§7.3）。
 * 规则本身在 `pickProfile` 里，这里只负责把结论落到两边。
 */
async function syncProfiles(
  supabase: BrowserSupabaseClient,
  userId: string,
  remoteRows: Profile[],
): Promise<Delta> {
  const local = (await db.profiles.get(userId)) ?? null;
  const remote = remoteRows[0] ?? null;
  const winner = pickProfile(local, remote);

  // 云端赢（也覆盖"本地压根还没有"）→ 落到本地
  if (remote && winner === remote) {
    await db.profiles.put(remote);
    return { pushed: 0, pulled: 1 };
  }

  // 本地赢，或者两边打平 → 推上去。
  // 平手也推是有意的：让云端跟眼前这台保持一致，比留着一份说不清先后的差异要好。
  if (local) {
    return { pushed: await pushRows(supabase, "profiles", [local]), pulled: 0 };
  }

  return { pushed: 0, pulled: 0 };
}

// ------------------------------------------------------------------ 任务单

/**
 * 按天对齐。**这是整套同步里唯一会真正冲突的地方**（§7.3）。
 * 判定规则在 `pickPlan` 里，这里只管落库。
 *
 * `localRows` 由调用方**先按主人筛过**再传进来（见 `ownedBy`）：
 * 上一个人的任务单不能被当成"待推"，否则 RLS 会整批拒掉。
 */
async function syncPlans(
  supabase: BrowserSupabaseClient,
  localRows: DailyPlan[],
  remoteRows: DailyPlan[],
): Promise<Delta> {
  const localById = new Map(localRows.map((row) => [row.id, row]));
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

  const toPush: DailyPlan[] = [];
  let pulled = 0;

  for (const id of allIds) {
    const local = localById.get(id) ?? null;
    const remote = remoteById.get(id) ?? null;
    const winner = pickPlan(local, remote);
    if (!winner) continue;

    if (remote && winner === remote) {
      // 云端那份进度更靠前 → 落到本地（覆盖本地那份落后的）
      await db.daily_plans.put(remote);
      pulled += 1;
    } else if (local) {
      toPush.push(local);
    }
  }

  return { pushed: await pushRows(supabase, "daily_plans", toPush), pulled };
}

// ------------------------------------------------------------------ 只增不改的两张表

/**
 * `review_logs` 与 `user_examples`：**流水账，只增不改**。
 *
 * 因为从不修改，两台设备的记录并起来就是全集，「谁覆盖谁」这个问题根本不存在 ——
 * 这也是**应该尽量让数据长成这样**的原因：最省事的一类数据。
 *
 * 两张表的主键都由客户端生成（`review_logs` 用随机 id、`user_examples` 用
 * `ex:<user_id>:<词>:<兴趣>` 这种确定性键 —— 主人的位置见 `lib/db/ids.ts`），
 * 所以两边 id 一定对得上，差集就能算准。
 */
async function syncAppendOnly(
  supabase: BrowserSupabaseClient,
  table: "review_logs" | "user_examples",
  localRows: Array<ReviewLog | UserExample>,
  remoteRows: Array<ReviewLog | UserExample>,
): Promise<Delta> {
  const localIds = new Set(localRows.map((row) => row.id));
  const remoteIds = new Set(remoteRows.map((row) => row.id));

  const toPush = localRows.filter((row) => !remoteIds.has(row.id));
  const toPull = remoteRows.filter((row) => !localIds.has(row.id));

  const pushed = await pushRows(supabase, table, toPush);

  if (toPull.length > 0) {
    // 两张表的 id 都是主键，bulkPut 不会写出重复行
    if (table === "review_logs") {
      await db.review_logs.bulkPut(toPull as ReviewLog[]);
    } else {
      await db.user_examples.bulkPut(toPull as UserExample[]);
    }
  }

  return { pushed, pulled: toPull.length };
}
