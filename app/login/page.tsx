"use client";

/**
 * `/login` —— 登录页（规格书 §6.2）
 *
 * 只有两个输入框 + 一个按钮，**故意不放注册入口**（决策 D2：账号由 Andy
 * 在 Supabase 后台统一开通，天然邀请制，零代码、零滥用风险）。
 *
 * ── 为什么是「邮箱 + 密码」而不是「邮箱魔法链接」（决策 D1）────────
 * 免费档的内置邮件服务**每小时只能发 2 封、且只发给项目团队成员的邮箱**，
 * 朋友的地址它会直接拒收 —— 不是慢，是不发。所以全程不发信。
 * 详见实施方案 §6.1。
 *
 * ── 视觉沿用全站口径 ──────────────────────────────────────────
 * 主按钮与首页那颗完全一致（`bg-brand-600 text-on-brand`、`active:scale-[0.99]`），
 * 色只用 design-tokens 里的语义类名。禁 emoji、禁硬编码颜色、禁紫粉渐变、禁 bounce。
 * 动效只用 `data-animated` 那一支（rise-in），微信 UA 下由根 layout 自动降级。
 *
 * ── 三种进入状态 ──────────────────────────────────────────────
 *   ① 账号系统没配上 → 说明现状 + 指回首页（不摆一个登不进去的表单）
 *   ② 已登录         → 直接回首页（规则在 `decideLoginEntry`，纯函数）
 *   ③ 其余           → 表单
 */

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { decideLoginEntry } from "@/lib/auth/guard";
import { describeAuthError } from "@/lib/auth/messages";
import { getSupabaseBrowserClient, readLocalSession } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/** 输入框的统一样式。写一次，两个框共用 —— 省得改一个漏一个 */
const INPUT_CLASS =
  "border-subtle bg-page text-primary placeholder:text-tertiary focus:border-brand-400 mt-2 w-full rounded-md border px-3 py-3 text-sm outline-none transition-colors duration-200";

export default function LoginPage() {
  const router = useRouter();
  const configured = isSupabaseConfigured();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 没配账号系统时不需要"确认中"这一帧
  const [checking, setChecking] = useState(configured);

  useEffect(() => {
    if (!configured) return;

    let cancelled = false;
    void (async () => {
      const read = await readLocalSession();
      if (cancelled) return;

      if (decideLoginEntry(configured, read.status) === "to-home") {
        router.replace("/");
        return;
      }
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [configured, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 连点会撞 Supabase 的限流（免费档默认 30 次/5 分钟），所以按钮置灰之外再挡一道
    if (busy) return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("账号系统还没接上。");
      return;
    }

    setBusy(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError) {
      setError(describeAuthError(authError));
      setBusy(false);
      return;
    }

    // 登录成功后**不解除 busy** —— 马上就要跳走了，解除会闪一下"可以再点"
    router.replace("/");
    router.refresh();
  }

  if (checking) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-8 pb-20">
        <p className="text-secondary py-16 text-center text-sm">正在确认登录状态…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-8 pb-20">
      <header className="mt-4 mb-8 text-center">
        <p className="text-primary text-xl leading-none font-medium">词径记</p>
        <p className="text-tertiary mt-3 text-xs">只给你这一单元的词 · 用适合你的方法</p>
      </header>

      <section className="border-subtle bg-surface rounded-lg border p-6" data-animated>
        {configured ? (
          <form onSubmit={onSubmit} noValidate={false}>
            <label className="block">
              <span className="text-tertiary text-[11px] tracking-[0.08em]">邮箱</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={INPUT_CLASS}
              />
            </label>

            <label className="mt-5 block">
              <span className="text-tertiary text-[11px] tracking-[0.08em]">密码</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                className={INPUT_CLASS}
              />
            </label>

            {error && (
              <p
                role="alert"
                className="border-danger-600/30 bg-danger-50 text-primary mt-4 rounded-md border px-3 py-2 text-xs leading-relaxed"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="bg-brand-600 text-on-brand ease-soft mt-5 w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity duration-200 active:scale-[0.99] disabled:opacity-60"
            >
              {busy ? "正在登录…" : "登录"}
            </button>
          </form>
        ) : (
          <div>
            <p className="text-primary text-sm font-medium">账号系统还没接上</p>
            <p className="text-secondary mt-2 text-xs leading-relaxed">
              现在整站按「纯本地模式」跑：数据存在这台设备上，照常可以背单词。
              账号与跨设备同步在接，接好之后也不影响你现在的记录。
            </p>
            <Link
              href="/"
              className="text-brand-800 mt-4 inline-block text-xs underline-offset-4 hover:underline"
            >
              先去用
            </Link>
          </div>
        )}
      </section>

      {configured && (
        <p className="text-tertiary mt-6 text-center text-[11px] leading-relaxed">
          账号由我统一开通 —— 还没拿到账号？跟我说一声。
        </p>
      )}
    </main>
  );
}
