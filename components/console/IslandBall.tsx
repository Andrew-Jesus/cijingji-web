"use client";

/**
 * 小词的「脸」—— 球档（日常待命）
 *
 * 它就是**改造前那颗悬浮球**：深墨圆盘 + 银「词」+ 贴着内缘的一圈进度环（表圈）。
 * 与那时相比只换了一处实现：以前是 `app/icon.png` 那张位图，
 * 现在改成 CSS 画的同一张脸 —— **因为这块材料要能被拉长**，
 * 位图被横向拉伸会糊、会变形，而"同一块材料"必须在形变中始终清晰。
 * 尺寸 / 配色 / 环的位置一像素没挪（44 / `--color-ink` / 半径 19.5，
 * 见 `lib/island/form.ts` 的 `THICKNESS_PX` 与 `IslandRing` 的 `rim`）。
 *
 * ── 为什么这里是"内容"，不是"整个组件"──────────────────────────
 * 硬约束（也是灵动岛的精髓）：各档形态必须是**同一块材料在拉伸**。
 * 所以承载材料只有一个，在 `ConsoleDock` 里；本文件只是它的孩子。
 * 如果按档拆成几个"完整组件"，用户看到的就是"旧的消失 + 新的出现"，
 * 那是弹窗，不是灵动岛。
 *
 * ── 「词」什么时候亮、什么时候退（2026-09-30 Andy 定）────────────
 * 它是 App 图标本来的样子（深墨圆盘 + 银字「词」）—— 小词就是那块图标"长大"的，
 * 这里把身份还给读者：一眼认出"这还是那颗球"，而不是"换了个新东西"。
 *
 * 规则：**今天动起来了就亮，一个词都还没做就退下去。**
 *   · 醒着（`done > 0`）→ 银「词」全亮 + 表圈环（按完成比例走）；
 *   · 空着（`done === 0`）→ **不画环**（否则是一圈 0% 的空线，不承载信息）、
 *     「词」退到一档暗银 → 整颗球安静得像一枚图标。
 *
 * ⚠️ 判据是 `done > 0`，**不是**"有没有任务" —— 理由见组件里 `awake` 那段
 * （`today` 只在首页 / 学习页写入，"还没排任务"这个状态一闪而过，拿它当"空着"等于白写）。
 *
 * ⚠️ **为什么是"退下去"而不是"彻底不画"**（Andy 要的是"藏起来，但要保持美观"，
 * 我这样落，理由两条）：
 *   ① **球上唯一的身份标记就是它** —— 岛档只报数和环、不出现「词」；
 *      所以「词」一没，第一次用的人就认不出角落里那颗深色圆盘是什么，
 *      也可能想不起去点它（**球是全站唯一的入口**）；
 *   ② 这条线他自己立过（2026-09-19）：收起态那颗小点用半透明压浅底，实测对比度
 *      只有 1.9:1，**等于消失**、用户"找不回来"。所以这里只退到 `opacity-70`
 *      （实测对比度仍 ≈3.3:1），**不越过那条线**。
 * 要改成"真的完全不画"，把那个 `opacity-70` 换成 `opacity-0` 即可 —— 一行的事。
 *
 * ── 「词」= 图标里的那一个字（2026-09-30 Andy：「参考「词」字设计做悬浮球」）──
 * 平涂的白在深底上只是张"贴纸"；有了竖直的明暗（上亮下暗）才像一块金属。
 * 这道银由 `.island-silver` / `.island-mark` 提供（见 globals.css），
 * **字体、字号、字重、银的四段停点、右下渐隐 —— 五项全部从 `scripts/gen-app-icon.py` 反推**：
 *   · 字体 / 字重 → 脚本 `FONT_CANDIDATES` 首位 `msyhbd.ttc`（微软雅黑粗体）
 *   · 字号 → 脚本 `GLYPH_RATIO = 0.38` × 44px，再除以实测墨宽比 0.930 ≈ **18px**
 *   · 银的四段 → 脚本 `SILVER_STOPS` 按 `detail_strength(44) = 0.583` 插值过的值
 *   · 右下渐隐 → 脚本 `FADE_*`（字形右下角化进底盘，Next.js「N」那套）
 * 也就是：**这颗球不是"像"图标，它就是图标长大成的那一颗。**
 * 它同时也是**球与岛之间的那个共同点**：材料拉长了，银字跟着过去，
 * 所以看起来是"同一块东西变长了"，而不是"换了一个深色条子"。
 *
 * ── 内容为什么迟一步才现身 ──────────────────────────────────
 * 淡入延迟由 `lib/island/form.ts` 的 `contentFadeStyle` 算：形变**后半段**才出现。
 * 前半段保持干净，否则会看见文字被拉伸变形时的一堆糊字。
 */
import type { TodayProgress } from "@/lib/console/store";
import { contentFadeStyle } from "@/lib/island/form";
import { progressRatio } from "@/lib/plan/todayProgress";

import { IslandRing } from "./IslandRing";

export function IslandBall({
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
  /**
   * 「今天有任务」—— 决定环有没有可画的比例（分母）。
   * 只看 `total`：任务排好了，只是还没开始做，那也是一件事实。
   */
  const hasTask = progress !== null && progress.total > 0;
  /**
   * 「这颗球醒了没有」—— 决定球上**亮不亮**（见文件头那条 2026-09-30 的规矩）。
   *
   * ⚠️ **判据是 `done > 0`，不是 `hasTask`。** 别看这两个差不多：
   *   · `today` 只在**首页 / 学习页**写入（`setTodayProgress`），别的路由刷新后是 `null`；
   *     所以"还没排任务"这个状态其实一闪而过 —— 拿它当"空着"用，等于这条规矩白写。
   *   · 天天出现、而且真的"空着"的，是**今天一个词都还没做**（`done === 0`）：
   *     那时环是一个 **0% 的空圈** —— 一圈没有内容的灰线，不承载信息，只是噪点。
   * ⇒ 于是规则是：**今天还没动 → 整颗球安静（不画环、「词」退一档）；
   *    做掉第一个词 → 环长出来、「词」亮起。**
   * 这也让"环出现"本身变成一句反馈："你今天动起来了"。
   */
  const awake = hasTask && progress.done > 0;

  return (
    <span
      aria-hidden
      data-island-content="ball"
      style={contentFadeStyle(visible, delayMs, slidePx)}
      className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden"
    >
      {/*
        表圈。它和「词」都靠 `place-items-center` 居中 —— 两层各自居中，
        就一定是同心的，不需要算任何偏移。
        没"醒"的时候干脆不画环：那时这颗球就是 App 图标本身（没有 0% 的空圈）。
      */}
      {awake && progress && (
        <span className="absolute inset-0 grid place-items-center">
          <IslandRing ratio={progressRatio(progress.done, progress.total)} variant="rim" />
        </span>
      )}
      {/*
        「词」—— 它就是 **App 图标里的那一个字**（Andy 2026-09-30：参考「词」字设计做悬浮球）。
        三个数都从图标脚本反推出来的，别凭手感调：

          · **字号 18px**：脚本的 `GLYPH_RATIO = 0.38`（墨迹宽占画布）→ 44 × 0.38 = 16.7px；
            实测微软雅黑粗体的「词」墨迹宽 = 0.930 × 字号 → 16.7 / 0.930 ≈ **17.98 ≈ 18px**。
            改造前是 15px（等于墨迹只有 14px，比图标细一圈）。
          · **字重 bold**：图标脚本的 `FONT_CANDIDATES` 第一个就是 `msyhbd.ttc`（微软雅黑粗体）。
          · **`.island-mark`**：在银底上多加一道"右下渐隐"，见 globals.css。

        ⚠️ 18px 会不会顶到表圈？不会 —— 墨迹 16.7 × 17.4，半对角 12.05px，
        而表圈内缘在 18.25px（半径 19.5 减半个笔宽 1.25）。

        ⚠️ 淡必须淡在**这一片叶子自己身上**（`.island-mark` 与 `opacity-*` 同元素）——
        套一层父元素再给子元素设 opacity，`background-clip: text` 会失效，
        那道银会按父元素的满不透明度画出来，"该淡的不淡"。
      */}
      <span
        className={`island-silver island-mark relative text-[18px] leading-none font-bold transition-opacity duration-300 ${
          awake ? "opacity-100" : "opacity-70"
        }`}
      >
        词
      </span>
    </span>
  );
}
