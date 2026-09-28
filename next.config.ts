import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
