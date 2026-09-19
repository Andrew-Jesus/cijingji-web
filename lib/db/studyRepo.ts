/**
 * 学习相关的数据读写 —— 唯一一层碰数据库的代码
 *
 * 与 `lib/db/repo.ts` 同思路：**页面与纯函数只认这个接口**，
 * 阶段 1 换 Supabase 时只换这里的实现，页面一行不用改。
 *
 * ── 一条数据卫生原则 ────────────────────────────────────────
 * 读取一律**只读需要的表、返回具体类型**，不做"顺手多查一点"。
 * 阶段 0 数据量小，多查不疼；但这个习惯会在阶段 1 变成真实的查询成本与权限问题
 * （Supabase 上有 RLS，多查的表意味着多一处授权配置）。
 */
import type { AiUsageDraft } from "@/lib/ai/contract";
import { localDayKey } from "@/lib/plan/todayProgress";
import { weakWordIds, type OutcomeLog } from "@/lib/study/history";
import type { ReviewRecord } from "@/lib/study/types";
import { db } from "./local";
import { LOCAL_PROFILE_ID } from "./repo";
import type { AiUsage, DailyPlan, DailyPlanItem, PlanStatus, ReviewLog, UserExample } from "./types";

/** 排计划时最多参考多少个错词。够填满"复习配额"即可，不必把整本错题本都读进来 */
export const WEAK_WORD_LIMIT = 40;

/** 计划 id 由**日期**决定 —— 一天一份，重复进入同一天拿到的是同一份（幂等） */
export function planIdFor(planDate: string): string {
  return `plan:${planDate}`;
}

/** 今天的日期键（本地时区）。学习页的路由段就用它 */
export function todayKey(now: Date): string {
  return localDayKey(now);
}

let seq = 0;
/** 本地 id。阶段 0 不要求全局唯一（没有多端），只要稳定且不撞 */
function localId(prefix: string, at: Date): string {
  seq += 1;
  return `${prefix}-${at.getTime().toString(36)}-${seq}`;
}

// ------------------------------------------------------------------ 今日任务单

export interface SavePlanInput {
  planDate: string;
  items: DailyPlanItem[];
  brief: string;
  estimatedMinutes: number;
  now: Date;
}

/**
 * 保存（或覆盖）某一天的任务单。
 * **已存在的状态保留** —— 覆盖时如果把 `status` 重置回 `pending`，
 * 用户"学了一半退出再进来"就会看到进度被抹平。
 */
export async function saveDailyPlan(input: SavePlanInput): Promise<DailyPlan> {
  const id = planIdFor(input.planDate);
  const existing = await db.daily_plans.get(id);

  const next: DailyPlan = {
    id,
    user_id: LOCAL_PROFILE_ID,
    plan_date: input.planDate,
    status: existing?.status ?? "pending",
    items: input.items,
    brief: input.brief,
    estimated_minutes: input.estimatedMinutes,
    generated_at: existing?.generated_at ?? input.now.toISOString(),
  };

  await db.daily_plans.put(next);
  return next;
}

export async function loadDailyPlan(planDate: string): Promise<DailyPlan | null> {
  return (await db.daily_plans.get(planIdFor(planDate))) ?? null;
}

export async function setPlanStatus(planDate: string, status: PlanStatus): Promise<void> {
  await db.daily_plans.update(planIdFor(planDate), { status });
}

// ------------------------------------------------------------------ 作答记录

/**
 * 某一天的全部作答记录。
 *
 * 为什么直接 `toArray()` 不用索引范围：`created_at` 存的是 UTC 的 ISO 串，
 * 而"今天"是**用户本地时区**的今天。用字符串范围去切本地日界，在时区不是 0 的时候
 * 一定会切错（东八区晚上 8 点之后就被切成明天）。所以老老实实全取再按本地日过滤。
 * 阶段 0 单人单机，一天最多百来条，这个代价可以忽略；
 * 阶段 1 有了服务端，这件事应该在 SQL 里按时区做（那时也不该在前端做）。
 */
export async function loadReviewLogs(): Promise<ReviewLog[]> {
  return db.review_logs.toArray();
}

export async function loadReviewLogsForDay(now: Date): Promise<ReviewLog[]> {
  const key = localDayKey(now);
  const all = await db.review_logs.toArray();
  return all.filter((log) => {
    const at = new Date(log.created_at);
    return !Number.isNaN(at.getTime()) && localDayKey(at) === key;
  });
}

/**
 * 落一条作答明细。
 *
 * 硬约束 19 要求记全：`latency_ms` / `hesitation_count` / `error_type` / `rating`。
 * 这四个字段是整张表的价值所在 —— 只记对错的话，这张表就只是一堆 0/1，
 * 做不了错因归因，也解释不了"为什么今天答得慢"。
 */
export async function appendReviewLog(record: ReviewRecord, now: Date): Promise<void> {
  const row: ReviewLog = {
    id: localId("rl", now),
    user_id: LOCAL_PROFILE_ID,
    word_id: record.word_id,
    session_id: record.session_id,
    mode: record.mode,
    is_correct: record.is_correct,
    latency_ms: Math.max(Math.round(record.latency_ms), 0),
    hesitation_count: Math.max(Math.round(record.hesitation_count), 0),
    error_type: record.error_type,
    rating: record.rating,
    created_at: now.toISOString(),
  };
  await db.review_logs.put(row);
}

/** 还没稳住的词（最近错的排前面）→ 直接喂给 `buildDailyPlan` */
export async function deriveWeakWordIds(limit = WEAK_WORD_LIMIT): Promise<string[]> {
  const logs = await db.review_logs.toArray();
  const rows: OutcomeLog[] = logs.map((l) => ({
    word_id: l.word_id,
    is_correct: l.is_correct,
    created_at: l.created_at,
  }));
  return weakWordIds(rows, limit);
}

// ------------------------------------------------------------------ 兴趣域例句缓存

/** 按 `(word_id, interest_tag)` 取缓存 —— **同一个词同一个兴趣域只生成一次** */
export async function findCachedExample(
  wordId: string,
  interestTag: string,
): Promise<UserExample | null> {
  const hit = await db.user_examples
    .where("[word_id+interest_tag]")
    .equals([wordId, interestTag])
    .first();
  return hit ?? null;
}

/** 批量取（一屏可能同时要好几条），返回 word_id → 例句 */
export async function findCachedExamples(
  wordIds: readonly string[],
  interestTag: string,
): Promise<Map<string, UserExample>> {
  const out = new Map<string, UserExample>();
  if (wordIds.length === 0) return out;

  const rows = await db.user_examples.where("word_id").anyOf([...wordIds]).toArray();
  for (const row of rows) {
    if (row.interest_tag !== interestTag) continue;
    if (!out.has(row.word_id)) out.set(row.word_id, row);
  }
  return out;
}

export interface SaveExampleInput {
  wordId: string;
  interestTag: string;
  sentence: string;
  gloss: string;
  isAiGenerated: boolean;
  now: Date;
}

export async function saveExample(input: SaveExampleInput): Promise<UserExample> {
  const row: UserExample = {
    // id 直接用键，避免"同一个词同一个兴趣"存出两条（表上也有唯一索引兜底）
    id: `ex:${input.wordId}:${input.interestTag}`,
    user_id: LOCAL_PROFILE_ID,
    word_id: input.wordId,
    sentence: input.sentence,
    gloss: input.gloss,
    interest_tag: input.interestTag,
    is_ai_generated: input.isAiGenerated,
  };
  await db.user_examples.put(row);
  return row;
}

// ------------------------------------------------------------------ AI 记账

/**
 * 把服务端回来的记账草稿写进本地表。
 * **失败也写** —— 一次失败的调用同样花了钱/同样值得看见，
 * 只记成功会让"AI 老在失败"这件事从账面上消失。
 */
export async function recordAiUsage(drafts: readonly AiUsageDraft[], now: Date): Promise<number> {
  if (drafts.length === 0) return 0;

  const rows: AiUsage[] = drafts.map((d, i) => ({
    id: `${localId("ai", now)}-${i}`,
    user_id: LOCAL_PROFILE_ID,
    task: d.task,
    model: d.model,
    input_tokens: d.input_tokens,
    output_tokens: d.output_tokens,
    cached_tokens: d.cached_tokens,
    cost_cny: d.cost_cny,
    priced: d.priced,
    peak: d.peak,
    latency_ms: d.latency_ms,
    ok: d.ok,
    created_at: now.toISOString(),
  }));

  await db.ai_usage.bulkPut(rows);
  return rows.length;
}

/**
 * 取最近的记账（默认 200 条）。
 * 开发者模式只看"今天的"汇总，但历史要留够 —— 否则跨天之后的排查没有依据。
 */
export async function loadRecentAiUsage(limit = 200): Promise<AiUsage[]> {
  const all = await db.ai_usage.toArray();
  return all
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(limit, 0));
}

// ------------------------------------------------------------------ 自检

/** 本地库规模，给开发者模式展示 */
export async function countLocalRows(): Promise<{
  words: number;
  review_logs: number;
  user_examples: number;
  ai_usage: number;
}> {
  const [words, review_logs, user_examples, ai_usage] = await Promise.all([
    db.words.count(),
    db.review_logs.count(),
    db.user_examples.count(),
    db.ai_usage.count(),
  ]);
  return { words, review_logs, user_examples, ai_usage };
}
