"use client";

/**
 * 小词墨底上那圈进度环 —— 球档与岛档共用
 *
 * ── 两种尺寸，画的是同一条环 ──────────────────────────────────
 *   · `rim`（球档）：盒子 44、半径 19.5、笔宽 2.5 —— 它**贴着圆盘内缘走一圈**，
 *     就是那颗球的「表圈」。⚠️ 硬约束（README 在案）：**环只能走盘内侧** ——
 *     App 图标是满幅圆，环画到外圈会被边切掉。19.5 + 半笔宽 1.25 = 20.75，
 *     离 22 的边还剩 1.25px 余量，这是算过的，不是估的。
 *   · `compact`（岛档）：盒子 26、半径 10.5 —— 落在材料一端，
 *     像苹果 Live Activity 左边那个图标。
 *
 * ⚠️ 这条环是**同一个东西的两种大小**，不是两个装饰：从球拉长成岛的时候，
 * 表圈收成小环、并顺着锚定边滑到位（见 `IslandBall` / `IslandStretch`）。
 * 所以两档的笔宽刻意相同（2.5）—— 变的是圈的大小，不是线的粗细。
 *
 * ── 为什么抽成一个文件而不是各画一份 ──────────────────────────
 * 「今天到哪儿了」这件事两档都要画。各画一份的话，改一处就漏一处
 * （比如以后换了填充色，只改了一个档）。
 *
 * `-rotate-90` 把起点挪到 12 点方向（SVG 的 0° 在 3 点）。
 */
const STROKE = 2.5;
const BOXES = {
  rim: { box: 44, r: 19.5 },
  compact: { box: 26, r: 10.5 },
} as const;

export function IslandRing({
  ratio,
  variant = "compact",
}: {
  ratio: number;
  variant?: "rim" | "compact";
}) {
  const { box, r } = BOXES[variant];
  const center = box / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      width={box}
      height={box}
      className="shrink-0 -rotate-90"
      aria-hidden
    >
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="var(--color-track-on-dark)"
        strokeWidth={STROKE}
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="var(--color-brand-400)"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
      />
    </svg>
  );
}
