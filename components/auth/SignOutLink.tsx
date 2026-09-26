"use client";

/**
 * 「退出」—— 首页右上角的一个小文字链。
 *
 * 为什么 B1 就要有它：没有它，登录页在登录状态下永远进不去，
 * 而"换个人用这台设备"（朋友的场景、你自己测两种账号的场景）都做不了。
 *
 * ── 两条刻意的选择 ────────────────────────────────────────────
 * ① **只在"确定已登录"时才露出来。** 读不出来时不显示 —— 宁可少一个入口，
 *    也不要放一个点了没反应的按钮（那比不放更伤信任，首页注释里写过这条）。
 * ② **退出不联网**（`scope: "local"`，见 lib/supabase/client.ts）。
 *    断网时点退出也必须是"退得出去"的。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { readLocalSession, signOutLocally } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export function SignOutLink() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    let cancelled = false;
    void (async () => {
      const read = await readLocalSession();
      if (cancelled) return;
      if (read.status === "session") setVisible(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          await signOutLocally();
          router.replace("/login");
        })();
      }}
      className="text-tertiary shrink-0 px-2 py-1 text-xs underline-offset-4 hover:underline"
    >
      退出
    </button>
  );
}
