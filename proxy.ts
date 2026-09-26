/**
 * Next.js 的请求前置层（Next 16 里叫 `proxy`，旧名字是 `middleware`）。
 *
 * ── ⚠️ 文件名与函数名都必须是 `proxy` ────────────────────────
 * Next.js 16 把 `middleware.ts` 改名成 `proxy.ts`、导出的函数从 `middleware`
 * 改成 `proxy`。**旧的 `middleware.ts` 在 16 里被静默忽略** ——
 * 不报错、不警告、构建照绿，只是里面的代码永远不跑。
 * 这类"看着全对但没生效"的问题最难查，所以这里写死新名字。
 *
 * ── 它只干一件事 ──────────────────────────────────────────────
 * 给登录凭据续期。**不做任何跳转、不拦任何人** —— 原因见
 * `lib/supabase/session.ts` 顶部那段。门卫在客户端。
 *
 * ── matcher 为什么必须排除这些 ────────────────────────────────
 * 这个函数**每个请求都会跑一次**，跑一次就是一次函数调用（Vercel 上要计费）。
 * 排查掉的三类：
 *   · `_next/static`、`_next/image`、`favicon.ico` 与各种图片 ——
 *     页面上的每个图标都跑一遍 Auth 纯属浪费，也会拖慢首屏。
 *   · `api` —— 最要紧的一条。`/api/ai` 是我们花真钱、且刚刚优化过响应时间
 *     的路径，在这里多一次"Vercel → Supabase"的往返毫无必要。
 *     将来 B3 的记账要在服务端读身份，那就在**那条路由内部**自己读 cookie
 *     （`lib/supabase/server.ts`），比让全站都跟着变慢划算。
 */

import type { NextRequest } from "next/server";

import { refreshSession } from "@/lib/supabase/session";

export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
