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
import { getActiveUserId } from "./identity";
import { exampleIdFor, planIdFor } from "./ids";
import { db } from "./local";
import type { AiUsage, DailyPlan, DailyPlanItem, PlanStatus, ReviewLog, UserExample } from "./types";

// 编号规则住在 `./ids.ts`（升级事务也要用同一份，放这里会跟 local.ts 绕成环）。
// 从这里转出去，调用方 import 哪个都行。
export { exampleIdFor, planIdFor };

/** 排计划时最多参考多少个错词。够填满"复习配额"即可，不必把整本错题本都读进来 */
export const WEAK_WORD_LIMIT = 40;

/** 今天的日期键（本地时区）。学习页的路由段就用它 */
export function todayKey(now: Date): string {
  return localDayKey(now);
}

let seq = 0;
/**
 * 本地 id。
 *
 * ⚠️ 它**不是** uuid —— 建表 SQL 里那句"客户端生成的 uuid，跨设备不撞"是错的，
 * 已一并更正。原来是「毫秒时间戳 + 每次页面加载从 1 开始的序号」：
 * **同一个浏览器开两个标签页时，这两个数会一模一样**。
 * 后果不是"重一条"，是**互相覆盖**：本地表 `id` 是主键，后写的那条顶掉先写的；
 * 推上云还会撞云端主键（同样是主键）→ 整批 upsert 被拒 → 一次同步白跑。
 * 补一段随机尾巴，把"偶尔撞"变成"不会撞"。
 */
function localId(prefix: string, at: Date): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${at.getTime().toString(36)}-${seq}-${rand}`;
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
  const userId = getActiveUserId();
  const id = planIdFor(input.planDate, userId);
  const existing = await db.daily_plans.get(id);

  const next: DailyPlan = {
    id,
    user_id: userId,
    plan_date: input.planDate,
    status: existing?.status ?? "pending",
    items: input.items,
    brief: input.brief,
    estimated_minutes: input.estimatedMinutes,
    generated_at: existing?.generated_at ?? input.now.toISOString(),
    // 覆盖保存也是一次改动 —— 云端那一列要有值，本地也就跟着记。
    // 它不参与"同一天两份谁赢"的判定（那个看进度，见 types.ts 的说明）。
    updated_at: input.now.toISOString(),
  };

  await db.daily_plans.put(next);
  return next;
}

export async function loadDailyPlan(planDate: string): Promise<DailyPlan | null> {
  return (await db.daily_plans.get(planIdFor(planDate, getActiveUserId()))) ?? null;
}

export async function setPlanStatus(planDate: string, status: PlanStatus): Promise<void> {
  await db.daily_plans.update(planIdFor(planDate, getActiveUserId()), { status });
}

// ------------------------------------------------------------------ 作答记录

/**
 * 只取**属于当前用户**的作答记录。
 *
 * 为什么读取侧也要过一层：**同一台设备换个人登录**时，上一个人的行还留在本机
 * （登出不清库，见 identity.ts 的说明）。不过滤的话，新登录的人会在
 * "今日已练 / 错词本"里看到上一个人的记录 —— 比起丢数据，**串号更难被发现**：
 * 数字看着都正常，只是那些词他从来没错过。
 *
 * 量级说明：一天最多百来条，全取再筛的代价可以忽略（同步器也是这么读的）。
 * 阶段 1 有了服务端，这件事该在 SQL 里按 `user_id` 做（那时也不该在前端做）。
 */
async function ownReviewLogs(): Promise<ReviewLog[]> {
  const userId = getActiveUserId();
  return (await db.review_logs.toArray()).filter((log) => log.user_id === userId);
}

/**
 * 某一天的全部作答记录。
 *
 * 为什么直接 `toArray()` 不用索引范围：`created_at` 存的是 UTC 的 ISO 串，
 * 而"今天"是**用户本地时区**的今天。用字符串范围去切本地日界，在时区不是 0 的时候
 * 一定会切错（东八区晚上 8 点之后就被切成明天）。所以老老实实全取再按本地日过滤。
 */
export async function loadReviewLogs(): Promise<ReviewLog[]> {
  return ownReviewLogs();
}

export async function loadReviewLogsForDay(now: Date): Promise<ReviewLog[]> {
  const key = localDayKey(now);
  const all = await ownReviewLogs();
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
    user_id: getActiveUserId(),
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
  const logs = await ownReviewLogs();
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

  const userId = getActiveUserId();
  const rows = await db.user_examples.where("word_id").anyOf([...wordIds]).toArray();
  for (const row of rows) {
    // 别人的例句不算缓存命中 —— 否则会拿上一个人生成的句子给这个人看
    if (row.user_id !== userId) continue;
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
  const userId = getActiveUserId();
  const row: UserExample = {
    // id 直接用键（含主人）：同一个人同一个词同一个兴趣只存一条（表上还有唯一索引兜底）。
    // 主人必须在里面 —— 见 `exampleIdFor` 的说明。
    id: exampleIdFor(input.wordId, input.interestTag, userId),
    user_id: userId,
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
    user_id: getActiveUserId(),
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
 *
 * 按当前用户筛：换了个人登录还显示上一个人的账，会让人以为"我没用 AI 怎么花了钱"。
 */
export async function loadRecentAiUsage(limit = 200): Promise<AiUsage[]> {
  const userId = getActiveUserId();
  const all = (await db.ai_usage.toArray()).filter((row) => row.user_id === userId);
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
