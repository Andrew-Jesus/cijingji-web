"use client";

/**
 * 浏览器端的 Supabase 客户端（单例）。
 *
 * ── 为什么必须是单例 ──────────────────────────────────────────
 * 每次 `createBrowserClient()` 都会新开一套"自动刷新 token"的定时器与监听。
 * 页面里多建几个，就会有几个定时器同时在刷同一个 token → 相互踩掉，
 * 控制台还会刷 `Multiple GoTrueClient instances detected` 的警告。
 *
 * ── 为什么用 @supabase/ssr 而不是 supabase-js 原版 ─────────────
 * 这个包的浏览器版把登录凭据写进 **cookie**（原版写 localStorage）。
 * 只有写成 cookie，服务器那边的 `proxy.ts` 才读得到、才能续期 ——
 * 这就是"装两个包"的原因，不是重复依赖。
 *
 * ── 关于 `getSession()` 与断网 ────────────────────────────────
 * `getSession()` 正常情况只读本地 cookie，**不联网**，断网也读得到。
 * 唯一例外：本地那张票**已过期**时，它会顺手去刷一次（那一步要联网）。
 * 所以下面用一个很短的预算把它兜住 —— 见 `readLocalSession`。
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { withTimeout } from "@/lib/util/timeout";
import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from "./env";

/**
 * ⚠️ **别改成 `ReturnType<typeof createBrowserClient>`**（2026-09-26 实测踩到）。
 *
 * 那个工厂是**泛型 + 重载**的，第二个泛型的默认值还是个条件类型：
 * `<Database = any, SchemaName extends … = "public" extends keyof … ? "public" : …>`。
 * 用 `ReturnType<>` 去取，泛型会在默认值上退化，
 * **整个客户端的类型静默塌成 `any`** —— 不报错、不再有类型保护
 * （`.from("拼错的表名")` 这种也能过），而你只会在很远的地方看到
 * 一句莫名其妙的 `… does not exist on type 'unknown'`（因为 `any` 传进泛型函数
 * 会被推成 `unknown`，见 lib/util/timeout.ts 的 `withTimeout`）。
 *
 * 类型保护是"拼错表名当场报错"的那道闸门，不能让它悄悄关掉。
 * 所以这里写死官方那个类型 —— 它跟着包升级走，不会漂。
 */
export type BrowserSupabaseClient = SupabaseClient;

let cached: BrowserSupabaseClient | null = null;

/**
 * 拿浏览器端客户端。**账号系统没配上时返回 `null`**，不是抛错
 * —— 调用方据此走"纯本地模式"，这是全站的降级约定。
 */
export function getSupabaseBrowserClient(): BrowserSupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (cached) return cached;
  cached = createBrowserClient(supabaseUrl(), supabasePublishableKey());
  return cached;
}

/**
 * 读本地凭据的等待上限。
 *
 * 2500 毫秒是"够一次正常的 token 刷新、又不至于让人干等"的量级。
 * 超了就当"读不出来"（`unknown`）—— 那种情况下门卫会**放行**，
 * 见 lib/auth/guard.ts 里那段"失败方向"的说明。
 */
export const SESSION_READ_BUDGET_MS = 2500;

export type LocalSession = {
  status: "session";
  email: string | null;
  /** 用户 id（uuid）。阶段 1 之后它就是本地数据要挂上去的那个"主人" */
  userId: string;
};

export type LocalSessionRead = LocalSession | { status: "none" } | { status: "unknown" };

/**
 * 看这台设备上有没有登录凭据。
 *
 * **只读本地，正常情况下不联网** —— 这是"断网也能接着背单词"的那一环。
 * 三种结果的含义与门卫怎么用见 lib/auth/guard.ts。
 */
export async function readLocalSession(): Promise<LocalSessionRead> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { status: "none" };

  try {
    const { data } = await withTimeout(supabase.auth.getSession(), SESSION_READ_BUDGET_MS);
    if (!data.session) return { status: "none" };
    return {
      status: "session",
      email: data.session.user.email ?? null,
      userId: data.session.user.id,
    };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * 退出登录。
 *
 * 用 `scope: "local"` 是**刻意**的：默认的 `global` 会联网去把服务器上
 * 所有设备的会话都吊销 —— 断网时那一步会失败，结果就是"点了退出还退不出去"。
 * `local` 只清这台设备上的凭据，不联网、必定成功。
 * 对"换个人用这台设备"这个真实场景来说，这才是对的那件事。
 */
export async function signOutLocally(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 退不出去也不该把界面卡住 —— 上层照样把人送回登录页
  }
}
