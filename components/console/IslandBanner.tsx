"use client";

/**
 * 小词的「脸」—— Banner 档（它要说话了）
 *
 * 一句话 + 一句补充（可选）。**不放大段正文** —— 横幅是"提个醒"，不是"念一篇"。
 * 想看全部就点开面板，动态列表在那里（I2 会把这块接上完整的场景表）。
 *
 * ── 出口为什么不做成「关闭」按钮 ─────────────────────────────
 * 两条原因，缺一不可：
 *   ① 四档必须是**同一块材料在拉伸**，所以这一档的内容也必须长在同一个承载元素里；
 *   ② 承载元素本身是个 `<button>`（整块可点），而 HTML 不允许按钮里再套按钮。
 * 于是出口改成两条不需要第二个按钮的：**自己说完就走**（`BANNER_HOLD_MS`），
 * 或者**点它打开面板**。右边那个 `›` 就是"点我"的暗示，它不是交互元素。
 *
 * 硬约束「每条提示必带出口，不能出现关不掉的话」因此仍然成立。
 *
 * ── 字也是银的（2026-09-30）──────────────────────────────────
 * 横幅是那块材料拉得最长的一档，最容易露馅成"一条深色玻璃"。
 * 所以它和球、和岛共用同一道银（`.island-silver`，见 globals.css）。
 * 三处文字都是**叶子元素** —— 这是 `background-clip: text` 成立的前提
 * （子元素上的 opacity 会让裁切失效），要淡就淡在自己身上。
 */
import type { Notice } from "@/lib/console/notices";
import { contentFadeStyle } from "@/lib/island/form";

export function IslandBanner({
  notice,
  delayMs,
  slidePx,
}: {
  notice: Notice | null;
  delayMs: number;
  /** 从哪一侧滑出来（贴左为负、贴右为正），见 `lib/island/stage.ts` */
  slidePx: number;
}) {
  return (
    <span
      aria-hidden
      data-island-content="banner"
      style={contentFadeStyle(notice !== null, delayMs, slidePx)}
      className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden px-4"
    >
      {notice && (
        <>
          <span className="min-w-0 flex-1">
            <span className="island-silver block truncate text-[13px] leading-snug font-medium">
              {notice.title}
            </span>
            {notice.detail && (
              <span className="island-silver mt-0.5 block truncate text-[11px] leading-snug opacity-60">
                {notice.detail}
              </span>
            )}
          </span>
          <span className="island-silver shrink-0 text-sm leading-none opacity-60">›</span>
        </>
      )}
    </span>
  );
}
