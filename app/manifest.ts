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
 * 图标说明：这里先用 `app/icon.png`（512）与 `app/apple-icon.png`（180）。
 * 安卓会把非 maskable 的图标塞进一个它自己画的底色里 —— 所以后续会再由
 * `scripts/gen-app-icon.py` 出一版**满幅**（`purpose: "maskable"`）的，
 * 图标是**生成物**、禁手改 PNG（项目硬约束）。
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
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      { src: "/favicon.ico", sizes: "48x48", type: "image/x-icon" },
    ],
  };
}
