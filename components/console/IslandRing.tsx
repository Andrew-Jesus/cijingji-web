"use client";

/**
 * 小词墨底上那圈进度环 —— 胶囊档与紧凑岛档共用
 *
 * ── 为什么抽成一个文件 ────────────────────────────────────────
 * 「今天到哪儿了」这件事，Pill 和 Live 两档都要画同一条环。
 * 各画一份的话，改一处就漏一处（比如以后换了填充色，只改了一个档）。
 *
 * ── 为什么画在材料内侧 ───────────────────────────────────────
 * 半径 10.5 / 26 —— 压在内侧，既不会被材料的圆角切到，
 * 也不会跟外面那圈告警柔光打架。
 * `-rotate-90` 把起点挪到 12 点方向（SVG 的 0° 在 3 点）。
 */
const RING_BOX = 26;
const RING_CENTER = RING_BOX / 2;
const RING_R = 10.5;
const RING_C = 2 * Math.PI * RING_R;

export function IslandRing({ ratio }: { ratio: number }) {
  return (
    <svg
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      width={RING_BOX}
      height={RING_BOX}
      className="shrink-0 -rotate-90"
      aria-hidden
    >
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_R}
        fill="none"
        stroke="var(--color-track-on-dark)"
        strokeWidth="2.5"
      />
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_R}
        fill="none"
        stroke="var(--color-brand-400)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - ratio)}
      />
    </svg>
  );
}
