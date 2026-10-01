import type { NextConfig } from "next";

/**
 * 发版标识 —— 在**构建期**算好，注入给客户端（`lib/release/version.ts` 是它唯一的出口）。
 *
 *   · 线上（Vercel）：`VERCEL_GIT_COMMIT_SHA` 前 7 位 —— 每次推送都不同，天然唯一；
 *   · 本地：构建那一刻的时间戳（本机没有 commit sha）。
 *
 * ⚠️ 必须在这里（构建期）算。写进客户端代码里运行时算的话，
 * 服务端渲染和客户端水合会拿到两个不同的值 —— 那是一个**必然触发**的水合不一致。
 *
 * ⚠️ `NEXT_PUBLIC_` 前缀不是随便起的：只有带这个前缀的变量才会被内联进浏览器那一份包。
 */
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? String(Date.now());

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  /**
   * 构建产物目录。默认值就是 Next 自己的选择（`.next`），**线上跑的一直是它**。
   *
   * ── 为什么留一个环境变量口子（2026-09-28 B3 落地时加）──────────
   * 在阿墨这台机器上，`npm run build` 会撞两次墙，两次都和"目录里已经有旧东西"有关：
   *
   *   ① `next dev` 会把 `.next/dev` 占住（Windows 上表现为整个 `.next`
   *      改名 / 删除都 `Permission denied`），于是没法"先挪走再构建"；
   *   ② 就算能挪，构建过程中 Next 要清掉上一轮产物，而**本机有条安全护栏**：
   *      一轮对话里删超过 50 个文件就要人工确认 —— 构建直接被它中断，
   *      报的还是一句和构建毫无关系的 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。
   *
   * 换个空目录构建，两个问题一起绕开：新目录里没有旧文件可删，也不与 dev 抢地盘。
   *
   * ```bash
   * NEXT_DIST_DIR=.next-b3 npm run build
   * ```
   *
   * 这正是 `MEMORY.md` 里那条"大目录改名挪走、别硬删"的经验在新的地方复现了一次。
   * **Vercel 那边不设这个变量，所以线上产物仍然落在标准位置 `.next`** ——
   * 平台按 `.next` 找产物，这里改了默认值会让部署直接失败。
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  /**
   * 只给门房脚本（`/sw.js`）单独指定缓存头 —— 别的文件一个都不动。
   *
   * 为什么它需要特殊照顾：浏览器拿 Service Worker 脚本时会走它自己的 HTTP 缓存规则。
   * 只要被任何一层（CDN 边缘 / 浏览器）长期缓存住，**用户就永远装不上新门房** ——
   * 而这是最难查的一种故障：本地全对、线上永远旧，刷新多少次都一样。
   *
   * 现在有两道保险：
   *   ① 注册地址带 `?v=<构建号>`（见 `components/pwa/ServiceWorkerRegistrar.tsx`）
   *      —— 每次发版都是一个"新地址"，缓存无从命中；
   *   ② 这里再显式声明"每次都要回源校验"，堵住中间层。
   *
   * ⚠️ 用 `no-cache` 而**不是** `no-store`：前者是"可以存、但每次必须校验"，
   *    后者是"根本不许存"。部分浏览器对 SW 脚本的 `no-store` 处理换过几轮，
   *    `no-cache` 已经足够达到目的，而且更稳。没必要为了更狠而踩一个未知。
   *
   * `Service-Worker-Allowed: /`：允许脚本取得根路径下的控制权。
   * 它本来就在根目录，所以这一条是"把意图写明"，不是"必需"。
   */
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
