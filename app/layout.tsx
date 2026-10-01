import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ConsoleDock } from "@/components/console/ConsoleDock";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
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

  /*
   * 主屏安装清单（`app/manifest.ts`）**不用在这里登记** ——
   * Next 认这个文件名，会自动生成 `/manifest.webmanifest` 并挂上 <link rel="manifest">。
   *
   * 但 iOS 是另一套：它不读清单里的 `display`，另认 `apple-mobile-web-app-*`。
   * 所以"加进主屏之后不要地址栏"这件事必须**两边都写**，漏一边 iOS 上就不是全屏。
   * 这是项目里少见的"同一件事写两遍"，原因不在我们这边。
   */
  appleWebApp: {
    capable: true,
    title: "词径记",
    // 状态栏保持系统默认配色 —— 暖白页面配深色字，跟着系统走比自己指定更不容易出错。
    statusBarStyle: "default",
  },
  applicationName: "词径记",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 与 globals.css 的 --color-page 保持一致（themeColor 只能是字面量，无法读 CSS 变量）
  themeColor: "#f7f5f2",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    /*
     * ⚠️ `suppressHydrationWarning` 不是可有可无的装饰，它在给下面那个首帧脚本擦屁股。
     *
     * 服务端渲染这一趟，有两件事它**没法知道**：
     *   ① 是不是微信内置浏览器（那要看 UA）
     *   ② 用户有没有开系统的「减弱动态效果」（那是浏览器端的偏好，根本不会随请求发上来）
     * 所以服务端吐出的 HTML 上**一定没有** `data-motion`；
     * 而首帧脚本会在 React 接手之前把它打上去。
     *
     * React 水合一比对：「服务端给的 HTML 里没这个属性，眼前的 DOM 上却有」→
     * 判为水合不一致，**把整棵服务端 HTML 丢掉、改成纯客户端重渲**
     * （报错原文就写着 "This won't be patched up."）。
     * 代价是首屏白一下 / 闪一下，SSR 等于白做 —— 而这趟重渲完全可以避免。
     *
     * `suppressHydrationWarning` 只压**这一个元素自己**的属性差异（不向下传染给子节点），
     * 正是 React 官方为「水合前用脚本改根元素属性」留的标准出口
     * （next-themes 这类主题库都这么写）。
     * ⚠️ 它压的是**这一条**，不是关掉水合检查：子节点该报的照报。
     */
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-page text-primary">
        {/*
          必须在 body 的第一个位置、且是同步脚本：
          它在首帧之前给 <html> 打 data-motion="reduced"，
          否则微信里会先按正常动效渲染一帧再切降级 —— 用户看到的是"跳一下"。
        */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOTSTRAP_SCRIPT }} />
        {/*
          请门房上岗 —— Service Worker 的注册器。它不画任何东西（返回 null）。
          放在根布局是因为门房是**全站**的基础设施，跟路由无关；
          它自己会判断"现在是不是正式构建"—— 开发环境不注册，免得被自己的缓存骗。
        */}
        <ServiceWorkerRegistrar />
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
