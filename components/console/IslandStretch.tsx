"use client";

/**
 * 小词的「脸」—— 岛档（拉长之后）
 *
 * 这是"球被拉开"的终点：**同一块材料、同样的厚度与圆角，只是变长了**。
 * 里面装三件事：左边一个进度环、接着「今日 12 / 36」、另一头「还剩 24 词」。
 *
 * ── 文件名为什么叫 Stretch 而不是 Island ───────────────────────
 * 形态名在 `lib/island/form.ts` 里就叫 `island`（Andy 的语言：球 / 岛）。
 * 组件前缀已经是 `Island`，再叫 `IslandIsland` 就成了叠字 ——
 * 所以文件名用它的**动作**（被拉长）来命名，一对就明白。
 *
 * ── 为什么不像横幅那样拉满屏 ────────────────────────────────
 * 因为它会**常驻**（事多久待多久，见 `LIVE_HOLD_MS`）。一块天天挂在角落的巨幕
 * 会让人喘不过气；这条 240 宽的小岛"不打扰、但你一眼看得见"。
 * 拉满屏那一档留给"要提醒你"的消息（`IslandBanner`）。
 *
 * ── 为什么数字会自己跳 ─────────────────────────────────────
 * 数据就是今日进度（`useTodayProgress`）。背完一个词，进度跳一格，
 * 小词就重新拉长报一次 —— 这才是"实时"。
 * 它不自己算数：口径由 `lib/plan/todayProgress.ts` 独家定义，免得两处各算一套。
 *
 * ── 为什么要分左右（`mirror`）────────────────────────────────
 * 材料贴着哪一边，"锚"就在哪一边：
 *   · 贴左 → 它往**右**长，球心（左起 22px）和环（左起 29px）几乎原地不动；
 *   · 贴右 → 它往**左**长，这时环必须跟着贴右边摆，否则会**从右端突然跳到左端**，
 *     跳掉整整两百来像素 —— 那正是"不无缝"的典型症状。
 * 所以整条内容左右镜像一下，环永远待在"球原来那个位置"附近。
 *
 * ── 字为什么是银的（2026-09-30 Andy 定）──────────────────────────
 * 拉长之后**不能变成一条深色玻璃**：它和那颗球是同一块材料，
 * 所以球上的银字与打光一路带过来（`.island-silver` / `.island-material`，
 * 色值出自 `scripts/gen-app-icon.py`）。这样形变读起来才是"同一块东西变长了"，
 * 而不是"换了个深色条子"。
 *
 * ⚠️ 一个必须绕开的坑：`.island-silver` 靠 `background-clip: text` 把渐变裁进字形，
 * 而**子元素上的 `opacity` 会让这个裁切失效** —— 那道银会按父元素的满不透明度
 * 画出来，该淡的地方反而不淡了。所以下面每一段文字都拆成**叶子**，
 * 要淡就淡在它自己身上。别图省事在外面再包一层。
 *
 * ── 内容为什么迟一步才现身 ──────────────────────────────────
 * 淡入延迟由 `lib/island/form.ts` 的 `contentFadeStyle` 算：形变**后半段**才出现。
 * 前半段保持干净，否则会看见文字被拉伸变形时的一堆糊字。
 */
import type { TodayProgress } from "@/lib/console/store";
import { contentFadeStyle } from "@/lib/island/form";
import { progressRatio } from "@/lib/plan/todayProgress";

import { IslandRing } from "./IslandRing";

export function IslandStretch({
  visible,
  delayMs,
  slidePx,
  progress,
  mirror,
}: {
  visible: boolean;
  delayMs: number;
  /** 从哪一侧滑出来（贴左为负、贴右为正），见 `lib/island/stage.ts` */
  slidePx: number;
  progress: TodayProgress | null;
  /** 材料贴在屏幕右边时整条内容左右镜像 —— 理由见文件头 */
  mirror: boolean;
}) {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const left = Math.max(total - done, 0);

  return (
    <span
      aria-hidden
      data-island-content="island"
      style={contentFadeStyle(visible, delayMs, slidePx)}
      className={`pointer-events-none absolute inset-0 flex items-center justify-between gap-2.5 overflow-hidden px-4 ${
        mirror ? "flex-row-reverse" : ""
      }`}
    >
      {/*
        左边一组：环 + 今日进度。两个都留在同一个组里，
        所以"环紧挨着它报的那个数"这件事，镜像前后都成立。
      */}
      <span className={`flex min-w-0 items-center gap-2.5 ${mirror ? "flex-row-reverse" : ""}`}>
        <IslandRing ratio={progressRatio(done, total)} />
        {/*
          三片**叶子**各自带银。
          ⚠️ 别改回"外面一个 span 包着、里面两个带 opacity 的 span"——
          那正是 `background-clip: text` 会失效的写法：子元素的 opacity 让
          那道银按**父元素的满不透明度**画出来，"今日"和" / 36"反而不淡了。
          所以这里的淡，淡在每一片自己身上（`.island-silver.opacity-60`）。
          理由见 globals.css 的 `.island-silver`。
        */}
        <span className="text-xs leading-none whitespace-nowrap tabular-nums">
          <span className="island-silver opacity-60">{"今日 "}</span>
          <span className="island-silver font-medium">{done}</span>
          <span className="island-silver opacity-60">{` / ${total}`}</span>
        </span>
      </span>

      {/*
        另一头只放一个会跳的数 —— 三件事里最该被扫到的那件。
        `shrink-0` 保证它永远不被压变形，挤不下时先挤中间那段空白。

        ⚠️ 这里和上面那个 `{done}` 都用 **`font-medium`** 而不是默认字重 ——
        它是"灵动岛稍作调整"（Andy 2026-09-30）里最轻的那一下：球上那个「词」是
        **bold**，岛上这两个数如果还是细体，同一块材料拉长之后会突然"变轻"。
        只给**要看的数**加，标签（`今日` / `还剩` 那几个字）保持原样 + `opacity`，
        三层的轻重关系一点没变。
      */}
      <span className="island-silver shrink-0 text-xs leading-none font-medium opacity-70 tabular-nums">
        还剩 {left} 词
      </span>
    </span>
  );
}
