/**
 * 服务端：只做一件事 —— **给登录凭据续期**，绝不拦人。
 *
 * 由根目录的 `proxy.ts` 调用。它在每个页面请求进到业务代码之前跑一次。
 *
 * ── 三条硬规则（违反任何一条都会出真问题）──────────────────────
 *
 * ① **不许在这里跳转。** 这里是"刷新票据"的地方，不是门卫。
 *    `getUser()` 是**联网**的（Vercel → Supabase）。它失败的原因很多：
 *    Supabase 抖动、从 Vercel 出去的网络不通、请求根本不是从服务器来的。
 *    任何一种都不等于"用户没登录"。在这里 `redirect('/login')` 的后果是
 *    **网络抖一下就把人踢出去**，而他的数据全在本地、根本不需要网。
 *    真正的门卫在客户端（`components/auth/AuthGate.tsx`），它只读本地 cookie。
 *
 * ② **不许把 client 提到模块级缓存。** 它绑着"这一次请求"的 cookie，
 *    缓存住就会串到别人的请求上（Vercel 上的函数实例是复用的）。
 *
 * ③ **`createServerClient` 和 `auth.getUser()` 之间不许插别的代码。**
 *    这是 Supabase 官方文档特别警告的一点：中间插了逻辑，
 *    会出现"用户被随机登出"这种极难查的现象。
 *
 * ── 为什么非要有它不可 ────────────────────────────────────────
 * 浏览器端虽然也会自己续期，但**服务端渲染时读 cookie 拿到的是"上一刻"的那张**。
 * 少了这一环，长期不关页面的用户会遇到"服务端认为他没登录、客户端认为他登录了"
 * 的分裂状态。（我们这版界面守卫在客户端，所以现在还不疼，
 * 但 B2 的同步、B3 的记账都在服务端读身份，那时候就疼了。）
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from "./env";

export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  // 账号系统没配上：原样放行。**这一步必须最先做** ——
  // 用空字符串调 createServerClient 会抛错，而这个错发生在每个请求上
  if (!isSupabaseConfigured()) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // 两边都要写：request 上是给"同一次请求里后面的代码"看的，
          // response 上是给"浏览器存下来"用的。少写一边就是"刷新了但没存住"
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    // 这一句是**唯一**的目的：让它有机会把过期的票换新。
    // 返回的用户信息我们不看 —— 门卫在客户端，这里不判断。
    await supabase.auth.getUser();
  } catch {
    // 故意吞掉。刷新失败 ≠ 没登录，绝不能因此拦人（见文件头 ①）
  }

  return response;
}
