"use client";

/**
 * 门卫：受保护页面（`/`、`/study/…`）的入口检查。
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

import { decideGuard } from "@/lib/auth/guard";
import { readLocalSession } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";

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
