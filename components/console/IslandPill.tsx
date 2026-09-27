"use client";

/**
 * 小词的「脸」—— Dot 档与 Pill 档的内容
 *
 * ── 为什么这里是"内容"，不是"整个组件"──────────────────────────
 * 硬约束（也是灵动岛的精髓）：各档形态必须是**同一块材料在拉伸**。
 * 所以承载材料只有一个，在 `ConsoleDock` 里；本文件只是它的孩子。
 * 如果按档拆成几个"完整组件"，用户看到的就是"旧的消失 + 新的出现"，
 * 那是弹窗，不是灵动岛。
 *
 * ── 内容为什么迟一步才现身 ──────────────────────────────────
 * 淡入延迟由 `lib/island/form.ts` 的 `contentFadeStyle` 算：形变**后半段**才出现。
 * 前半段保持干净，否则会看见文字被拉伸变形时的一堆糊字。
 *
 * ── 没进度可报时为什么放一个「词」字 ─────────────────────────
 * 那是 App 图标本来的样子（深墨圆 + 银字「词」）——
 * 小词就是那块图标"长大"的，这里把身份还给它，而不是留一个空环。
 */
import type { TodayProgress } from "@/lib/console/store";
import { contentFadeStyle } from "@/lib/island/form";
import { progressRatio } from "@/lib/plan/todayProgress";

import { IslandRing } from "./IslandRing";

export function IslandPill({
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
  const hasProgress = progress !== null && progress.total > 0;

  return (
    <span
      aria-hidden
      data-island-content="pill"
      style={contentFadeStyle(visible, delayMs, slidePx)}
      className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2.5 overflow-hidden px-3.5"
    >
      {hasProgress && progress ? (
        <>
          <IslandRing ratio={progressRatio(progress.done, progress.total)} />
          <span className="text-on-ink text-xs leading-none whitespace-nowrap tabular-nums">
            <span className="opacity-60">今日 </span>
            {progress.done}
            <span className="opacity-60"> / {progress.total}</span>
          </span>
        </>
      ) : (
        <span className="text-on-ink text-[15px] leading-none font-medium">词</span>
      )}
    </span>
  );
}
