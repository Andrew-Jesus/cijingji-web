/**
 * `(app)` 这一组页面（`/`、`/study/…`）的共享外壳。
 *
 * 只做一件事：套上登录门卫。**不加任何布局样式** ——
 * 各页自己有 `<main>` 与留白（首页顶部那段"排版约定"就是它们的共同口径），
 * 在这里再包一层会把已经调好的间距挤歪。
 *
 * 注意别用 `LayoutProps<"/">`：本工程的类型化路由里这个组没有独立的键，
 * 显式声明 children 最稳（`app/onboarding/layout.tsx` 里踩过同一个坑）。
 */

import { AuthGate } from "@/components/auth/AuthGate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
