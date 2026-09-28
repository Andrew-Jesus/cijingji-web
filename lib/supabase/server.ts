/**
 * 服务端：**从请求里读出"现在是谁"** —— 只给 `/api/ai` 的记账用
 *
 * ── 为什么这件事不交给 `proxy.ts` ─────────────────────────────
 * `proxy.ts` 的 matcher 刻意把 `/api` 排除掉了（实施方案 §9.4）：
 * `/api/ai` 是花真钱、又要抢响应时间的一条路，
 * 在这里多一次"Vercel → Supabase"的往返毫无必要。
 * 所以身份要读就在**那条路由内部**自己读。
 *
 * ── 为什么允许它联网（`getUser`）─────────────────────────────
 * 因为记账发生在 **`after()` 里**，那时代码已经在响应发出之后了
 * —— 这一趟网络**不影响用户等多久**。
 * 换来的是"这个 id 是 Supabase 亲口说的"，而不是我们自己从 cookie 里
 * 拆出来的一串字符。拆 cookie 不验签的话，谁都能伪造一个别人的 id
 * 把账挂到别人名下（危害是数据污染，不是泄漏，但没有理由不防）。
 *
 * ── 读不出来怎么办 ───────────────────────────────────────────
 * 一律返回 `null`，**绝不抛错**。调用方据此走"这笔账不上云"，
 * 而学习页那边早就拿到例句了 —— 用户全程无感。
 */

import { createServerClient } from "@supabase/ssr";

import { withTimeout } from "@/lib/util/timeout";
import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from "./env";

/** 从 Route Handler 里 `(await cookies()).getAll()` 拿到的快照 */
export interface CookiePair {
  name: string;
  value: string;
}

/**
 * 验身份的等待上限。
 *
 * 比 `client.ts` 里的 2500 毫秒更宽松：那边挡的是"用户正盯着屏幕"的路径，
 * 这里已经是响应之后了，稍微多等一会儿换一个确定的答案更划算。
 */
export const SERVER_USER_BUDGET_MS = 5000;

/**
 * 把 cookie 快照换成用户 id；没登录、验不过、超时、没配账号系统 —— 全部返回 `null`。
 *
 * ⚠️ **必须传快照（数组），不许传 `cookies()` 本身。**
 * 调用点在 `after()` 里，那时请求上下文已经收摊了；
 * 而 cookie 快照是普通数组，拿在手里就不会失效。
 */
export async function readServerUserId(cookies: readonly CookiePair[]): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
      cookies: {
        getAll: () => [...cookies],
        // 响应早就发出去了，这里再写 Set-Cookie 没有任何意义。
        // 官方文档对这个位置的写法就是"能忽略就忽略"（Server Component 场景同理）。
        setAll: () => undefined,
      },
    });

    const { data } = await withTimeout(supabase.auth.getUser(), SERVER_USER_BUDGET_MS);
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}
