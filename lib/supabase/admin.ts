/**
 * 服务端专用的 Supabase 客户端 —— **整把 secret key 只在这个文件里出现一次**
 *
 * ── 它凭什么危险 ──────────────────────────────────────────────
 * 这把 key（新名字 `sb_secret_…`，旧名字 service_role）**绕过全部 RLS**，
 * 等于数据库的万能钥匙：拿着它读谁的行都行、写谁的行都行。
 * 所以它的边界只有三条，少一条就等于没有：
 *
 *   ① **绝不加 `NEXT_PUBLIC_` 前缀。** 加了会被 Next 在打包时替换进浏览器代码，
 *      等于把万能钥匙印在传单上发出去。没加前缀时，客户端那边拿到的是 `undefined`。
 *   ② **绝不出现在 `"use client"` 文件里**，也不许被它们间接 import
 *      —— 见 `lib/supabase/secretBoundary.test.ts`：它顺着 import 关系往回找，
 *      只要有客户端模块能摸到这个文件就当场失败。
 *   ③ **每批交付都要拿产物核对一次**（这是 V3 闸门，构建之后才跑）：
 *      ```
 *      npm run build
 *      grep -rl "<这把 key 的前 20 个字符>" .next/static   # 必须没有任何输出
 *      ```
 *
 * ── 为什么不用 `import "server-only"` ─────────────────────────
 * 那是官方推荐的写法，也确实能在构建期拦住误引用。这里不用它的唯一理由是
 * **本项目的测试跑在 vitest 里**，而 vitest 的 Node 环境解析不到 `server-only`
 * 这个包（Next 只在它自己的打包器里把它 alias 成内置空模块）。
 * 为了它专门去装一个包、或在 vitest 里再配一条 alias，代价大于收益。
 *
 * 换成"静态闸门测试 + 构建后 grep 产物"这两道，覆盖的是同一件事，
 * 而且其中一道验的是**真实产物里到底有没有**，比任何静态检查都接近事实。
 *
 * ── 没配 key 会怎样 ──────────────────────────────────────────
 * `getSupabaseAdmin()` 返回 `null` —— **不抛错**。理由和全站其它地方一致：
 * 少一把钥匙只该让"记账上云"这件事不发生，不该让 AI 例句跟着失败。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabaseUrl } from "./env";

/**
 * 读 secret key。**只在本文件里读**，别在别处再写一遍 `process.env.SUPABASE_SECRET_KEY`
 * —— 散在多处的话，将来改名会漏掉某一处，症状是"配了但不生效"，且不报错。
 */
export function supabaseSecretKey(): string {
  return (process.env.SUPABASE_SECRET_KEY ?? "").trim();
}

/** 记账上云这件事到底能不能做 */
export function isAdminConfigured(): boolean {
  return supabaseUrl().length > 0 && supabaseSecretKey().length > 0;
}

let cached: SupabaseClient | null = null;

/**
 * 拿服务端客户端。**这里缓存是安全的**，和 `lib/supabase/session.ts` 里
 * "绝对不许缓存"的那份不是一回事：那份绑着"某一次请求的 cookie"，
 * 缓存就会串到别人头上；这份是万能钥匙本身，不带任何用户身份，谁用都一样。
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isAdminConfigured()) return null;
  if (cached) return cached;

  cached = createClient(supabaseUrl(), supabaseSecretKey(), {
    auth: {
      // 服务端没有"登录状态"这回事，三个都关掉：
      // 留着会自动开定时器刷 token，在一个无状态的函数里纯属浪费
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
