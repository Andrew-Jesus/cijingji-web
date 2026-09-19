/**
 * /onboarding 三段流程的共享外壳
 *
 * 只做一件事：给三页同样的宽度、留白与品牌标记 ——
 * 让"问答 → 自测 → 结果"在视觉上是一段连续的旅程，而不是三个不同页面。
 *
 * 注意别用 `LayoutProps<"/onboarding">`：本工程的类型化路由只生成了 `"/"`，
 * 传子路由会在 typecheck 时报 TS2344。显式声明 children 最稳。
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    // 底部 pb-20 是给左下角控制台悬浮球让位的（球 44px + 20px 边距）
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-8 pb-20">
      <p className="text-tertiary mb-6 text-xs tracking-wide">词径记 · 先了解一下你的情况</p>
      <div className="flex-1">{children}</div>
    </div>
  );
}
