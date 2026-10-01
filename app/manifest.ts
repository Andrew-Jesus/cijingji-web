import type { MetadataRoute } from "next";

/**
 * 主屏安装清单（Web App Manifest）
 *
 * 手机浏览器靠它知道"这网站叫什么、用哪个图标、点开要不要带地址栏"。
 * 没有它，安卓 Chrome 只会给一个"添加书签"，而不是"安装"。
 *
 * ⚠️ 它由 Next 在 `/manifest.webmanifest` 上提供（不是 `public/` 里的静态文件），
 *    所以改完要**重新部署**才生效；而门房（`public/sw.js`）会在 install 时把它抓进缓存，
 *    断网时那一次安装也照样认得出图标。
 *
 * ⚠️ iOS 不读这个文件里的 `display`（Safari 另有一套 `apple-mobile-web-app-*` 的规矩，
 *    由 `app/layout.tsx` 的 `metadata.appleWebApp` 提供）。
 *    两边都要写 —— 这是"同一件事写两遍"的少数例外之一，抄漏一边 iOS 上就不是全屏。
 *
 * 图标分两套，**两套都要给**：
 *
 *   · **普通版**（`purpose: "any"`，来自 `app/icon.png`）= 一张内切的深墨圆片，四个角透明。
 *   · **满幅版**（`purpose: "maskable"`，来自 `public/icon-maskable-*.png`）= 底色铺满整块、
 *     一个透明像素都没有，**形状交给系统去切**（安卓会套成圆形 / 方圆形 / 圆角方）。
 *
 * ⚠️ 两套**不能合成一个文件**。只给普通版：安卓把它塞进自己画的底色里，
 *    圆片外面会露出一圈白边；只给满幅版：不认 maskable 的场合会把整块方料原样显示，
 *    字看着偏小、四周空一圈。
 * 所以规矩是"**分开声明**"，而不是在同一个 src 上写 `"any maskable"`
 *    —— 后者正是"两种场合里必有一种不对"的写法。
 *
 * 两套都由 `scripts/gen-app-icon.py` 一次生成（**图标是生成物、禁手改 PNG**），
 * 而且字宽取的是同一个 38% —— 圆形遮罩下"看得见的面积"就是那个内切圆，
 * 于是满幅版看起来和普通版**是同一个标**，换的只是"圆片 → 整块料"。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // 稳定身份：以后就算域名/路径变了，浏览器也认得出"这是同一个应用"
    id: "/",
    name: "词径记",
    short_name: "词径记",
    description:
      "按需定制的背单词工具：只给你这一单元的词，用适合你的方法，按科学间隔安排复习。",
    lang: "zh-CN",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // 与 globals.css 的 --color-page 一致（这两处只能写字面量，读不到 CSS 变量）
    background_color: "#f7f5f2",
    theme_color: "#f7f5f2",
    icons: [
      // 普通版 —— 桌面浏览器 / iOS / 旧安卓
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      { src: "/favicon.ico", sizes: "48x48", type: "image/x-icon" },
      // 满幅版 —— 安卓按自己的形状裁；192 走旧安装条件，512 走高清
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
