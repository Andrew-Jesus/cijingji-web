"use client";

/**
 * 小词的「脸」—— Live 档（有件正在跑的事）
 *
 * 这是苹果那个"外卖配送中"的对应物：**一枚不宽的胶囊**，
 * 左边一个进度环、中间一句状态、右边还剩多少、底下一根细进度条。
 *
 * ── 为什么它不像横幅那样拉满屏 ────────────────────────────────
 * 因为它会**常驻**（事多久待多久，见 LIVE_HOLD_MS）。一块天天挂在头顶的巨幕
 * 会让人喘不过气；而这枚 240 宽的小岛"不打扰、但你一眼看得见"。
 * 拉满屏那一档留给"要提醒你"的消息（Banner）。
 *
 * ── 为什么数字会自己跳 ─────────────────────────────────────
 * 数据就是今日进度（`useTodayProgress`）。背完一个词，进度跳一格，
 * 小词就重新登台报一次 —— 这才是"实时"。
 * 它不自己算数：口径由 `lib/plan/todayProgress.ts` 独家定义，免得两处各算一套。
 *
 * ── 内容为什么迟一步才现身 ──────────────────────────────────
 * 淡入延迟由 `lib/island/form.ts` 的 `contentFadeStyle` 算：形变**后半段**才出现。
 * 前半段保持干净，否则会看见文字被拉伸变形时的一堆糊字。
 */
import type { TodayProgress } from "@/lib/console/store";
import { contentFadeStyle } from "@/lib/island/form";
import { progressRatio } from "@/lib/plan/todayProgress";

import { IslandRing } from "./IslandRing";

export function IslandLive({
  visible,
  delayMs,
  slidePx,
  progress,
}: {
  visible: boolean;
  delayMs: number;
  /** 从哪一侧滑出来（贴左为负、贴右为正），见 `lib/island/stage.ts` */
  slidePx: number;
  progress: TodayProgress | null;
}) {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const left = Math.max(total - done, 0);

  return (
    <span
      aria-hidden
      data-island-content="live"
      style={contentFadeStyle(visible, delayMs, slidePx)}
      className="pointer-events-none absolute inset-0 flex items-center gap-2.5 overflow-hidden px-4 pb-1.5"
    >
      <IslandRing ratio={progressRatio(done, total)} />

      {/* 中间那句状态：空间不够就省略号，绝不撑破材料 */}
      <span className="text-on-ink min-w-0 flex-1 truncate text-[13px] leading-snug">
        今日任务收尾中
      </span>

      {/* 右边只放一个会跳的数 —— 三件事里最该被扫到的那件 */}
      <span className="text-on-ink shrink-0 text-xs leading-none opacity-70 tabular-nums">
        还剩 {left} 词
      </span>

      {/*
        底部那根细进度条。它贴在材料下沿内侧 8px ——
        细到不抢戏，但扫一眼就知道"走到哪了"。跑道的半透明白复用
        `--color-track-on-dark`（跟环的跑道是同一个变量，别另定义）。
      */}
      <span className="bg-track-on-dark absolute right-4 bottom-2 left-4 h-[3px] overflow-hidden rounded-full">
        <span
          className="bg-brand-400 block h-full rounded-full"
          style={{ width: `${progressRatio(done, total) * 100}%` }}
        />
      </span>
    </span>
  );
}
