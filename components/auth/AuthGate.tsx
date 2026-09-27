"use client";

/**
 * 门卫：受保护页面（`/`、`/study/…`、`/onboarding/…`）的入口检查。
 *
 * 它还兼着两件事（B2）—— 都必须在**放行之前**做完：
 *   ① **认人**：把"现在是谁"定下来、把本机旧数据认领到位。
 *      缺了这一步，页面一渲染就会按错误的 id 去读数据，
 *      用户看到的会是"我的进度没了"。详见下面那段注释。
 *   ② **没有被画像时，先给同步一次机会**：否则新设备上登录已有账号，
 *      会被当成新用户推去重做一遍引导（而云端数据其实正在下来的路上）。
 *      详见 `shouldWaitForFirstSync` 那段。
 *
 * ── 为什么门卫在**客户端**，不在服务器 ────────────────────────
 * 见 lib/auth/guard.ts 顶部。一句话：服务器那边要联网才知道你登没登录，
 * 一断网就答不上来、只能把人踢走；而他的进度全在本地，本来不需要网。
 * 客户端这边只读本地 cookie，**不联网**，断网照样答得出来。
 *
 * 安全不靠这里 —— 靠数据库的 RLS。伪造 cookie 的人进来看到的还是空数据。
 *
 * ── 三种结果怎么处理 ──────────────────────────────────────────
 * 规则收在 `decideGuard` 里（纯函数、有单测），本组件只读结论、执行动作。
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { decideGuard, FIRST_SYNC_BUDGET_MS, shouldWaitForFirstSync } from "@/lib/auth/guard";
import { setActiveUserId } from "@/lib/db/identity";
import { getProfile } from "@/lib/db/repo";
import { claimLocalData } from "@/lib/sync/claim";
import { syncNow } from "@/lib/sync/sync";
import { readLocalSession } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { withTimeout } from "@/lib/util/timeout";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();

  // 没接账号系统 → 一上来就算"就绪"，连"正在确认"那一帧都不要有
  // （纯本地模式下这一帧纯属多余，还会让人以为在联网）
  const [ready, setReady] = useState(() => !isSupabaseConfigured());

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    let cancelled = false;
    void (async () => {
      const read = await readLocalSession();
      if (cancelled) return;

      if (decideGuard(true, read.status) === "to-login") {
        router.replace("/login");
        return;
      }

      // ── 认人：必须赶在放行**之前**做完（B2）─────────────────────
      // 页面一渲染就会去读画像和任务单，那时候"现在是谁"得已经定下来了。
      //
      //   ① `setActiveUserId` —— 决定**新写入**的行挂谁的 id。
      //      不设的话，登录之后答的题还挂着 "local"；等换个人登录，
      //      他那一轮认领会把前一个人的记录一并抢走（串号，而且用户完全看不出来）。
      //   ② `claimLocalData` —— 把**本机已有**的旧数据（挂 "local" 的那些）
      //      认到这个人名下。不做的话，页面按 uuid 查不到画像 → 被当成新用户
      //      送去引导页重做一遍 20 题自测，而他的进度其实好端端躺在库里。
      //
      // 两件都是**纯本地**操作（IndexedDB，毫秒级），不联网，所以不会拖慢首屏。
      if (read.status === "session") {
        setActiveUserId(read.userId);
        try {
          await claimLocalData(read.userId);
        } catch {
          // 认领失败**不能拦住人**。`getProfile` 那边留了"读不到就回落 local"的兜底，
          // 下一轮同步还会再认一次（认领是幂等的），这里放手即可。
        }

        // ── ③ 本机连画像都没有时，先给同步一次机会（B2，2026-09-27 补）─────
        //
        // **不补这一步会发生什么**（实测抓到的，不是推理）：
        // 在新设备上登录一个已有账号 → 首页读到"本机没画像"，
        // 1 毫秒就判"这是新用户，去引导页"→ 人被推去做 3 步问答 + 20 题自测。
        // 而同一时刻同步器正把云端画像搬下来，慢几百毫秒，但**已经晚了**。
        //
        // 数据其实没丢（实证：落点是 `/onboarding`，十几秒后本机的画像 /
        // 任务单 / 答题记录 / 例句一样不少全在）。**丢的是"他来过"这件事**。
        // 更要命的是后半步：他真做完那 20 题，`completeOnboarding` 会把
        // `updated_at` 刷成最新 → 下一次同步反过来把他云端原有的画像覆盖掉。
        //
        // 所以：**只在本机没有画像时**多等一次（首屏不等网络那条硬要求，
        // 靠"本机有画像就不等"守住）。超时/失败一律放行，理由与 `decideGuard`
        // 的失败方向一致 —— 宁可这一次判错，也不能把人卡在"正在确认"上。
        const existing = await getProfile();
        if (shouldWaitForFirstSync(existing != null)) {
          try {
            await withTimeout(syncNow("login"), FIRST_SYNC_BUDGET_MS);
          } catch {
            // 超时或失败：照常放行。下一轮同步（进页面时 / 网络恢复时）还会再试。
          }
          if (cancelled) return;
        }
      } else {
        // "读不出来"（断网 / 超时）：门卫放行，但身份保持在"本机"这一档 ——
        // 宁可这一次不同步，也不能把数据写到一个猜出来的 id 上（那才会真的串号）。
        setActiveUserId(null);
      }

      if (cancelled) return;
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
        <p className="text-secondary py-16 text-center text-sm">正在确认登录状态…</p>
      </main>
    );
  }

  // 就绪时**不加任何包裹元素** —— 页面自己有 <main>，多套一层会把布局挤变形
  return <>{children}</>;
}
