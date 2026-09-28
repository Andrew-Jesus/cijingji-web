"use client";

/**
 * 开发者模式的"今日账"—— **优先看云端，取不到才回落本机**
 *
 * ── 为什么要有"回落"这一半 ────────────────────────────────────
 * 记账是**双写**的：云端一份（权威）、本机一份（离线副本）。
 * 平时该看云端那份 —— 它才是完整的账（换台设备、换个浏览器都在）。
 * 但"看账"这个动作不该被网络决定：
 *   · 断网了
 *   · 还没配 secret key（本地开发常见）
 *   · Supabase 在睡觉（免费档 7 天没活动会被暂停）
 * 这三种情况下如果只认云端，面板会显示"今天还没调过" ——
 * **而人明明刚调过、本机就有记录**。那不是"降级"，那是撒谎。
 *
 * ── 为什么云端成功但为空时仍以云端为准 ────────────────────────
 * 因为"云端空"本身就是个有意义的信号：说明**服务端没把账记上**
 * （没配 secret key / 身份读不出来 / 写库被拒）。
 * 这种时候显示本机那份会把问题盖住，而它正是 B3 要能看见的东西。
 * 所以这里把两边的条数**都**带回去，界面上一句话就能看出没对上
 * —— 那句话由 `usageStats.ts` 的 `usageOriginNote` 生成（纯函数，有单测）。
 *
 * ── 口径 ─────────────────────────────────────────────────────
 * "今天"用 `startOfLocalDay`（本机时区 0 点）划界，与汇总用的
 * `filterToday` / `localDayKey` 同一个口径。三处要是各算各的，
 * 就会出现"面板说 3 次、明细只有 2 条"这种对不上的怪事。
 */

import { loadRecentAiUsage } from "@/lib/db/studyRepo";
import {
  filterToday,
  startOfLocalDay,
  toUsageLike,
  type CloudUsageRowLike,
  type UsageLike,
  type UsageOrigin,
} from "@/lib/ai/usageStats";
import { getSupabaseBrowserClient, readLocalSession } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/util/timeout";

export type { UsageOrigin };

/**
 * 云端一次最多取多少行。
 * 开发者模式只看今天的账，一天几百次调用已经是很重的用量了 ——
 * 这个上限的作用是**别让一个失控的循环把整张表拉进浏览器**。
 */
export const USAGE_QUERY_LIMIT = 500;

/** 本机那份取多少行。与 `loadRecentAiUsage` 的默认值一致，只是写显式 */
export const USAGE_LOCAL_LIMIT = 500;

/**
 * 云端查询的等待上限。
 * 比登录路径（2500 毫秒）宽松：这里没有人在等着输密码，
 * 只是一块"正在读"的占位文字多留一会儿。但也不能不设 ——
 * 断网时 Supabase 客户端会静静地挂到 TCP 超时，那就是几十秒的白等。
 */
export const USAGE_QUERY_BUDGET_MS = 4000;

/** 云端失败原因在界面上最多显示这么长 —— 数据库的报错全文塞进面板只会糊住别的东西 */
const ERROR_TEXT_LIMIT = 120;

export interface TodayUsage {
  rows: UsageLike[];
  origin: UsageOrigin;
  /** 云端请求成功时它的条数；未配置 / 超时 / 报错时为 `null` */
  cloudCount: number | null;
  /** 本机今天的条数（云端成功时也读一份，用来核对两边对不对得上） */
  localCount: number;
  /** 云端没取到的人话原因；成功时为 `null` */
  cloudError: string | null;
}

/** 云端要的列。**逐列点名**，不要 `select("*")`：多取的列都是白传的流量 */
const CLOUD_COLUMNS = [
  "task",
  "model",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "cost_cny",
  "priced",
  "ok",
  "created_at",
].join(",");

/** 云端查询回来的形状。**只声明我们真的会用到的那两个字段** */
interface CloudUsageResult {
  data: CloudUsageRowLike[] | null;
  error: { message: string } | null;
}

/**
 * 把 supabase 的查询器变成一个带类型的 Promise。
 *
 * 为什么要包这一层：那个查询器是"可等待对象"（thenable），
 * 直接 `Promise.resolve(query)` 会让 TS 顺着它自己的 `.then` 重载去推，
 * 推出来的 `data` 元素类型是 `GenericStringError` 这种内部类型
 * —— 于是 `.map(toUsageLike)` 报一个和真实问题毫无关系的类型错。
 * 这里一次性把它收成我们自己的形状，后面就不用再跟库的类型较劲。
 */
async function runCloudQuery(query: PromiseLike<unknown>): Promise<CloudUsageResult> {
  return (await query) as CloudUsageResult;
}

/**
 * 读"今天的账"。**永不抛错** —— 返回结构里那个 `origin` 就说明了一切。
 */
export async function loadTodayUsage(now: Date): Promise<TodayUsage> {
  const localRows = filterToday(await loadRecentAiUsage(USAGE_LOCAL_LIMIT), now);
  const localCount = localRows.length;

  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    return {
      rows: localRows,
      origin: "local",
      cloudCount: null,
      localCount,
      cloudError: "这台设备没接账号系统",
    };
  }

  /**
   * **先看有没有登录，再决定查不查云端。**
   *
   * 这一步不是省流量，是防一次**误报**：未登录时去查云端不会报错，
   * 它会规规矩矩返回**空数组**（RLS 只放行自己的行，而"自己"是空的）。
   * 于是"云端 0 条 · 本机 3 条"看起来就像**双写断了一条链** ——
   * 可实际上未登录本来就不上云，一切正常。
   *
   * 那个警告一共只有三种真实成因（没配 secret key / 身份读不出 / 写库被拒），
   * 加进来一个恒定的假成因，就等于把它的价值稀释掉一半。
   *
   * 这里用 `readLocalSession` 而不是 `getUser()`：它**只读本机 cookie、不联网**，
   * 断网时照样答得出来 —— 而这个函数整个存在的意义就是断网也要能用。
   */
  const session = await readLocalSession();
  if (session.status !== "session") {
    return {
      rows: localRows,
      origin: "local",
      cloudCount: null,
      localCount,
      cloudError: session.status === "none" ? "这台设备上没登录" : "读不出登录状态",
    };
  }

  try {
    const query = supabase
      .from("ai_usage")
      .select(CLOUD_COLUMNS)
      .gte("created_at", startOfLocalDay(now).toISOString())
      .order("created_at", { ascending: false })
      .limit(USAGE_QUERY_LIMIT);

    const { data, error } = await withTimeout(
      runCloudQuery(query),
      USAGE_QUERY_BUDGET_MS,
    );
    if (error) throw new Error(error.message);

    // 边界已经在 SQL 那边划过了，这里再 filterToday 一遍不是多余：
    // 数据库比的是时间戳大小，而"今天"是**本机时区**的概念，
    // 两边的口径只在同一个函数里对齐过一次，就不要再出现第二处判断。
    const rows = filterToday((data ?? []).map(toUsageLike), now);

    return { rows, origin: "cloud", cloudCount: rows.length, localCount, cloudError: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      rows: localRows,
      origin: "local",
      cloudCount: null,
      localCount,
      cloudError: `云端查询失败：${message.slice(0, ERROR_TEXT_LIMIT)}`,
    };
  }
}
