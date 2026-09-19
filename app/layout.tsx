import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ConsoleDock } from "@/components/console/ConsoleDock";
import { MOTION_BOOTSTRAP_SCRIPT } from "@/lib/ua/wechat";

/*
 * 注意：这里**不用 next/font 拉 Google 字体**。
 * 两个原因：① 中文界面用系统字体栈更快、更像原生 App；
 * ② 构建时联网拉字体会拖慢甚至失败（国内网络环境下尤其明显）。
 * 字体栈定义在 globals.css 的 --font-sans。
 */

export const metadata: Metadata = {
  title: "词径记",
  description:
    "按需定制的背单词工具：只给你这一单元的词，用适合你的方法，按科学间隔安排复习。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 与 globals.css 的 --color-page 保持一致（themeColor 只能是字面量，无法读 CSS 变量）
  themeColor: "#f7f5f2",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-page text-primary">
        {/*
          必须在 body 的第一个位置、且是同步脚本：
          它在首帧之前给 <html> 打 data-motion="reduced"，
          否则微信里会先按正常动效渲染一帧再切降级 —— 用户看到的是"跳一下"。
        */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOTSTRAP_SCRIPT }} />
        {children}
        {/*
          左下角常驻悬浮「词」标 —— 小词。
          放根 layout 是因为它**全站常驻**，而且要在页面首屏之前就能报状态
          ——「词库准备好了」「网断了」这些事恰恰发生在首屏之前。
          它自己会按路由判断该不该露面（见 lib/console/dock.ts）。
        */}
        <ConsoleDock />
      </body>
    </html>
  );
}
