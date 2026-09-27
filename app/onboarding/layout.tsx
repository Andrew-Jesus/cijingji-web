/**
 * /onboarding 三段流程的共享外壳
 *
 * 只做一件事：给三页同样的宽度、留白与品牌标记 ——
 * 让"问答 → 自测 → 结果"在视觉上是一段连续的旅程，而不是三个不同页面。
 *
 * ⚠️ **门卫也要套上（2026-09-27 补）**：引导过程会写画像（`saveProfile`），
 * 而写入要挂"现在是谁"的 id。身份是在 `AuthGate` 里认下来的 ——
 * 这一组页面原先没套门卫，于是**在引导页上直接刷新**时，身份会退回本机档，
 * 答完的那份画像就挂到了一个临时 id 名下（虽然下次进首页时还能被认领回来，
 * 但那一步本来就不该发生）。套上之后，这一组页面与 `(app)` 走同一套认人流程。
 *
 * 顺带也更对：没登录的人本来就不该走到引导页（那是登录之后的事）。
 * 断网时门卫照样放行（见 lib/auth/guard.ts 的"失败方向"），不影响可用性。
 *
 * 注意别用 `LayoutProps<"/onboarding">`：本工程的类型化路由只生成了 `"/"`，
 * 传子路由会在 typecheck 时报 TS2344。显式声明 children 最稳。
 */
import { AuthGate } from "@/components/auth/AuthGate";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      {/* 底部 pb-20 是给左下角控制台悬浮球让位的（球 44px + 20px 边距） */}
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-8 pb-20">
        <p className="text-tertiary mb-6 text-xs tracking-wide">词径记 · 先了解一下你的情况</p>
        <div className="flex-1">{children}</div>
      </div>
    </AuthGate>
  );
}
