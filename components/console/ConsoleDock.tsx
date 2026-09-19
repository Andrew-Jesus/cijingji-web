"use client";

/**
 * 小词 —— 左下角常驻的悬浮「词」标
 *
 * 形态参考 Next.js 的开发者指示器（角落一颗小球、点开一块面板），
 * 但里面装的是**本产品自己的东西**：今日进度、快捷继续、各处推来的动态。
 *
 * ── 为什么挂在根 layout ───────────────────────────────────────
 * 它全站常驻，而且要在"页面还没加载完"时就报状态 ——
 * 词库装载、网络断开这些事，恰恰发生在首屏之前。
 *
 * ── 四件事分别归谁管（别混着写）────────────────────────────────
 *   · 该不该露面 / 那一下算点还是算拖 / 面板往哪边长 → `lib/console/dock.ts`（纯函数，有单测）
 *   · 藏起来没有 / 球停在哪儿                        → `lib/console/prefs.ts`（只写 localStorage）
 *   · 本组件只负责把结论落到 DOM 上
 *
 * ── 面板可以往上长，也可以往下长（2026-09-19 修）────────────────
 * 面板默认排在球的**上方**。但球是可以拖的 —— 一旦球被拖到屏幕上半部，
 * "从球往上长"就等于把面板顶出屏幕：实测把球放到最上（顶边 16px）再点开，
 * 面板顶边是 **−429px**，而它总共才 435px 高 —— 整块面板几乎全在屏幕外。
 *
 * 两个原因叠在一起：
 *   ① 方向写死了"永远往上"；
 *   ② `max-h-[70vh]` 是相对**视口**算的，不是相对"球上方还剩多少"算的，
 *      所以它管不住"往上长到哪"。
 *
 * 修法也是两条，缺一不可：
 *   ① **换边**：球在中线以下 → 往上长；在中线以上 → 往下长。
 *      判据在 `panelSideFor()`（纯函数，有单测）。
 *   ② **面板高度按"那一侧真实剩余空间"封顶**，全用 CSS 算：
 *      往上长时 = 球上沿 − 缝 − 留白；往下长时 = 视口高 − 球下沿 − 缝 − 留白。
 *      这样面板**在任何位置都不可能伸出屏幕**，内容多了就在面板内部滚动。
 *      两条合起来，还顺带省掉了 resize 监听 —— 表达式里全是 vh，转屏自动跟上。
 *
 * ── 位置为什么不用 top 存一个像素值 ───────────────────────────
 * 若在 JS 里存 innerHeight，就多出一个"服务端不知道屏幕多高"的水合陷阱，
 * 还要自己监听 resize。所以球的 `top` 是由 `100vh − bottom − size` 推出来的
 * （见 ballTopExpr），跟 `bottom` 用的是同一份表达式，两者永远自洽。
 * 只有**拖拽过程中**才需要真实像素 —— 那时从指针事件里取就是了。
 *
 * ── 对齐方向必须跟着"球在哪一边"走（2026-09-19 实测踩坑）──────
 * 容器是"宽度由内容撑开"的：面板一展开，容器宽度就等于面板宽度（320px）。
 * 若固定 `items-start`，球会被推到容器**左端** —— 实测球拖到右边后再点开，
 * `ballLeft` 从 311 变成 35，**球当着用户的面从右边缘跳到左边缘**。
 * 所以：球在左 → items-start，球在右 → items-end，让球始终贴着它自己那一边。
 *
 * ── 为什么"拖拽"要接管 touch-action ──────────────────────────
 * 球上必须写 `touch-action: none`，否则手指一动就变成滚页面，拖拽永远开始不了。
 * 代价是从球上起手的滚动没了 —— 球只有 44px，这个代价可以接受。
 */

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import {
  BALL_PX,
  BOTTOM_MARGIN_PX,
  MINI_PX,
  PANEL_EDGE_PAD_PX,
  PANEL_GAP_PX,
  TOP_LIMIT_PX,
  clampSpotRatio,
  classifyGesture,
  dockPresentation,
  nearestSide,
  panelSideFor,
  type DockSpot,
} from "@/lib/console/dock";
import { updatePrefs, usePrefs } from "@/lib/console/prefs";
import { probeRuntime, type RuntimeSnapshot } from "@/lib/console/probe";
import { pushNotice, useConsoleAlert, useConsoleStore, useTodayProgress } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { ensureSeeded } from "@/lib/db/seed";
import { progressRatio } from "@/lib/plan/todayProgress";

import { ConsolePanel } from "./ConsolePanel";

/**
 * 用户主动收起后剩的那一小颗。
 *
 * ── 两个踩过的坑（2026-09-19 实测）────────────────────────────
 * ① **颜色不能用 `bg-strong`。** 那个 token 是 `#d6cfc5` 浅暖灰，
 *    压 `#f7f5f2` 的页面底上、再乘 45% 透明度，最深处只有 `#ece9e5` ——
 *    实测对比度 **1.21:1**，等于看不见，用户收起之后**找不回来**。
 *    它是"浅底上的小标记"，所以要取品牌色里**最深的一档 `brand-800`**：
 *    页面底上 4.62:1、白卡上更高，稳过 WCAG 对"图形元素"要求的 3:1。
 *    （`brand-600` 是 2.93:1，卡在线上，所以不用它；半透明更不行，
 *    60% 透明度只有 1.9:1。这一颗只有 12px，深一点绝不会喧宾夺主 ——
 *    但"看不见"是 bug，不是克制。）
 * ② **不能只给它 12px 的点击范围。** 12px 的触摸目标手指根本点不中
 *    （iOS 人机指南要求 44px）。所以外面套一圈 44px 的透明热区，
 *    视觉上仍然只有 TUCKED_PX 那么大。
 */
const TUCKED_PX = 12;
/** 收起态那一下的「可点范围」。比球大出来的部分要从定位里扣掉，见 pad */
const RESTORE_HIT_PX = 44;
/** 距屏幕左右边的留白 */
const EDGE_PX = 20;
/** 按住多久算长按（开/关开发者模式）。一旦开始拖拽就把计时器清掉 */
const LONG_PRESS_MS = 600;
/** 进度环半径（在 44px 的画布里）。压在圆盘内侧 2.5px，像金属盘的一圈表圈 */
const RING_R = 19.5;
const RING_C = 2 * Math.PI * RING_R;
/** 位置变化的过渡。拖拽中会临时关掉，松手才让它滑过去 */
const SLIDE =
  "left var(--duration-slow) var(--ease-soft), right var(--duration-slow) var(--ease-soft), top var(--duration-slow) var(--ease-soft), bottom var(--duration-slow) var(--ease-soft)";

/** 一次按下的全部临时状态。放 ref 不放 state：pointermove 每帧都在改，进 state 会每帧重渲染 */
interface PressState {
  id: number | null;
  x: number;
  y: number;
  offX: number;
  offY: number;
  viewportH: number;
  dragging: boolean;
  timer: number | null;
  swallowClick: boolean;
}

const IDLE_PRESS: PressState = {
  id: null,
  x: 0,
  y: 0,
  offX: 0,
  offY: 0,
  viewportH: 0,
  dragging: false,
  timer: null,
  swallowClick: false,
};

export function ConsoleDock() {
  const pathname = usePathname();
  const presentation = dockPresentation(pathname);
  const prefs = usePrefs();

  const open = useConsoleStore((s) => s.open);
  const setOpen = useConsoleStore((s) => s.setOpen);
  const toggle = useConsoleStore((s) => s.toggle);
  const alerting = useConsoleAlert();
  const today = useTodayProgress();

  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  /** 拖拽中的实时位置。松手后清空，位置交回 prefs.spot */
  const [dragAt, setDragAt] = useState<{ x: number; y: number; viewportH: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLButtonElement>(null);
  const press = useRef<PressState>({ ...IDLE_PRESS });

  // ① 开局自检：先确保词库灌好（幂等，与首页并发调用也安全），再读一次规模
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await ensureSeeded(db);
        const snap = await probeRuntime();
        if (cancelled) return;
        setRuntime(snap);
        pushNotice({
          key: "boot",
          level: "success",
          title: "词库准备好了",
          detail: `${snap.words} 个词条 · ${snap.placements} 条单元归属，都装在这台设备上，断网也能背`,
        });
      } catch (e) {
        if (cancelled) return;
        pushNotice({
          key: "boot",
          level: "danger",
          title: "词库没能装好",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ② 网络开关。用 key:"net" 去重，反复断连也不会堆一屏
  useEffect(() => {
    function onOnline() {
      setRuntime((r) => (r ? { ...r, online: true } : r));
      pushNotice({
        key: "net",
        level: "success",
        title: "网络回来了",
        detail: "小词和进度都放在本机，有没有网都一样用",
      });
    }
    function onOffline() {
      setRuntime((r) => (r ? { ...r, online: false } : r));
      pushNotice({
        key: "net",
        level: "warning",
        title: "现在没网",
        detail: "不碍事 —— 词和进度都在本机，照常能背",
      });
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ③ 展开时的收尾：点外面关、按 Esc 关
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: globalThis.PointerEvent) {
      // 用 pointerdown 而不是 click：click 会在"按下球 → 松开在别处"时漏掉
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

  // ── 手势 ────────────────────────────────────────────────────────
  function clearLongPress() {
    if (press.current.timer !== null) {
      window.clearTimeout(press.current.timer);
      press.current.timer = null;
    }
  }

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const rect = ballRef.current?.getBoundingClientRect();
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      // 记下"抓球时手指离球心多远"，拖的时候球才不会突然跳到手指底下
      offX: rect ? rect.left + rect.width / 2 - e.clientX : 0,
      offY: rect ? rect.top + rect.height / 2 - e.clientY : 0,
      viewportH: window.innerHeight,
      dragging: false,
      timer: null,
      swallowClick: false,
    };
    // 抓住指针：手指滑出球外，move / up 也仍然回到球上。
    // 包 try/catch 是因为合成事件（自动化测试、少数旧内核）里 pointerId 可能无效，
    // 那种情况下 setPointerCapture 会抛 NotFoundError —— 不该因此让球点不动。
    try {
      ballRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 抓不住就算了，只是手指滑出去后收不到 move / up */
    }

    press.current.timer = window.setTimeout(() => {
      press.current.timer = null;
      press.current.swallowClick = true;
      // 长按 = 开关开发者模式。刻意不给任何界面提示 —— 它不是给用户的功能
      updatePrefs({ dev: !prefs.dev });
      setOpen(true);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const p = press.current;
    if (p.id !== e.pointerId) return;

    if (!p.dragging) {
      if (classifyGesture(e.clientX - p.x, e.clientY - p.y) !== "drag") return;
      p.dragging = true;
      clearLongPress(); // 一开始拖，就不再算长按
      p.swallowClick = true; // 拖完那一下不算点击
      setOpen(false); // 拖着的时候先把面板收掉，免得它跟着晃
    }
    setDragAt({ x: e.clientX + p.offX, y: e.clientY + p.offY, viewportH: p.viewportH });
  }

  function onPointerUp(e: PointerEvent<HTMLButtonElement>) {
    const p = press.current;
    if (p.id !== e.pointerId) return;
    clearLongPress();

    if (p.dragging) {
      // 竖直位置换算成比例。可用行程与"落到哪一边"都在这里现算 ——
      // 只有这一刻才需要真实像素，所以不必为此在组件里存一份视口尺寸。
      const travel = Math.max(1, p.viewportH - BALL_PX - BOTTOM_MARGIN_PX - TOP_LIMIT_PX);
      const centerY = e.clientY + p.offY;
      const spot: DockSpot = {
        side: nearestSide(e.clientX + p.offX, window.innerWidth),
        ratio: clampSpotRatio((centerY - BALL_PX / 2 - TOP_LIMIT_PX) / travel),
      };
      updatePrefs({ spot });
      setDragAt(null);
    }

    // 这里**不**处理"点击"。点击交给 onClick —— 那样键盘（Enter / 空格）也能开合面板，
    // 不必为无障碍另写一套。拖过 / 长按过的这一次，靠 swallowClick 挡掉。
    p.id = null;
  }

  function onPointerCancel(e: PointerEvent<HTMLButtonElement>) {
    if (press.current.id !== e.pointerId) return;
    clearLongPress();
    press.current = { ...IDLE_PRESS };
    setDragAt(null);
  }

  function onBallClick() {
    if (press.current.swallowClick) {
      press.current.swallowClick = false;
      return;
    }
    toggle();
  }

  // ── 几何 ────────────────────────────────────────────────────────
  const tucked = prefs.hidden;
  const mini = !tucked && presentation === "mini";
  const size = tucked ? TUCKED_PX : mini ? MINI_PX : BALL_PX;
  /** 收起态外面那圈透明热区比球大出来的部分。定位要把它扣掉，
   *  否则那颗小点看起来会从屏幕边上"缩进去"16px */
  const pad = tucked ? (RESTORE_HIT_PX - size) / 2 : 0;

  // 竖直位置：0 = 能到的最上，1 = 能到的最下。整段行程用 CSS calc 表达，
  // 所以屏幕多高这件事根本不需要进 JS。
  const ratio = clampSpotRatio(prefs.spot.ratio);
  // 球的外接框（相对视口上下边）。写成表达式而不是像素值，
  // 是为了让"面板封顶高度"能跟着转屏/地址栏收放自动重算。
  const travelExpr = `(100vh - ${TOP_LIMIT_PX + size + BOTTOM_MARGIN_PX}px)`;
  const ballTopExpr = `${TOP_LIMIT_PX + pad}px + ${ratio.toFixed(4)} * ${travelExpr} - env(safe-area-inset-bottom)`;
  const ballBottomExpr = `${BOTTOM_MARGIN_PX - pad}px + ${(1 - ratio).toFixed(4)} * ${travelExpr} + env(safe-area-inset-bottom)`;

  // 面板往哪边长。**这是"面板会不会跑出屏幕"的唯一开关**，规则在 dock.ts（有单测）
  const panelSide = panelSideFor(ratio);

  /*
    面板能有多高 = 那一侧**真实剩下的空间**，所以它永远不可能伸出屏幕。
      · 往上长：球上沿 − 缝 − 留白
      · 往下长：视口高 − 球下沿 − 缝 − 留白
    再跟 70vh 取小值，免得在大屏上摊成一张巨幕。
    全是 vh 表达式 → 转屏、手机地址栏收放都自动跟上，不需要 resize 监听。
  */
  const panelMaxHeight =
    panelSide === "above"
      ? `min(70vh, calc(${ballTopExpr} - ${PANEL_GAP_PX + PANEL_EDGE_PAD_PX}px))`
      : `min(70vh, calc(100vh - (${ballTopExpr}) - ${size + PANEL_GAP_PX + PANEL_EDGE_PAD_PX}px))`;

  /*
    容器的锚定方向跟着面板走：
      · 面板在上 → 锚底边（面板向上生长，球的底边不动）
      · 面板在下 → 锚顶边（面板向下生长，球的顶边不动）
    两种都让球纹丝不动；锚错方向的话，面板一展开就会把球顶走。
  */
  const anchorStyle: CSSProperties =
    panelSide === "above"
      ? { top: "auto", bottom: `calc(${ballBottomExpr})` }
      : { top: `calc(${ballTopExpr})`, bottom: "auto" };

  const posStyle: CSSProperties = dragAt
    ? {
        left: dragAt.x - BALL_PX / 2,
        right: "auto",
        top: "auto",
        bottom: dragAt.viewportH - dragAt.y - BALL_PX / 2,
        transition: "none",
      }
    : prefs.spot.side === "left"
      ? { left: EDGE_PX - pad, right: "auto", ...anchorStyle, transition: SLIDE }
      : { left: "auto", right: EDGE_PX - pad, ...anchorStyle, transition: SLIDE };

  // 用户把小词收起来了：只留边上一小颗，点一下就能请回来。
  // （等以后有了「设置」页，这里应该换成一个正经的开关。）
  if (tucked) {
    return (
      <div ref={rootRef} style={posStyle} className="fixed z-50">
        <button
          type="button"
          onClick={() => updatePrefs({ hidden: false })}
          aria-label="显示小词"
          style={{ width: RESTORE_HIT_PX, height: RESTORE_HIT_PX }}
          className="focus-visible:ring-brand-600 focus-visible:ring-offset-page group grid place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <span
            aria-hidden
            style={{ width: size, height: size }}
            className="bg-brand-800 block rounded-full transition-transform duration-200 group-hover:scale-125"
          />
        </button>
      </div>
    );
  }

  // 引导流程前半段完全不出现 —— 新用户还没建立认知，浮球只会分心
  if (presentation === "hidden") return null;

  return (
    <div
      ref={rootRef}
      style={{ ...posStyle, gap: PANEL_GAP_PX }}
      className={`fixed z-50 flex ${
        panelSide === "above" ? "flex-col-reverse" : "flex-col"
      } ${prefs.spot.side === "left" ? "items-start" : "items-end"}`}
    >
      {/*
        球写在前面、面板写在后面：配合 flex-col / flex-col-reverse，
        就能在不复制一份 JSX 的前提下让面板长在球的上边或下边 ——
        `column-reverse` 会把第一个孩子放到**底**部，于是"面板在球上方"。
      */}
      <div className="group relative">
        {/*
          悬停时浮出的名称条。窄屏（基本都是触屏）不显示 ——
          触屏点一下会留下"粘住的 hover"，那条字会一直挂在球边上。
          球在哪一边，条子就往**另一侧**伸，否则会顶出屏幕外。
        */}
        <span
          className={`border-subtle bg-surface text-secondary pointer-events-none absolute bottom-1/2 hidden translate-y-1/2 rounded-sm border px-2 py-1 text-[11px] whitespace-nowrap opacity-0 transition-opacity duration-160 group-hover:opacity-100 sm:block ${
            prefs.spot.side === "left" ? "left-full ml-3" : "right-full mr-3"
          }`}
        >
          小词
        </span>

        <button
          ref={ballRef}
          type="button"
          onClick={onBallClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          aria-expanded={open}
          aria-controls="console-panel"
          aria-label="小词"
          style={{ width: size, height: size }}
          className={`focus-visible:ring-brand-600 focus-visible:ring-offset-page ease-soft relative block touch-none rounded-full transition-transform duration-200 select-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
            alerting ? "shadow-alert" : "shadow-float"
          } ${mini ? "opacity-70" : "hover:scale-105"}`}
        >
          {/* alt 留空：按钮自己的 aria-label 已经说明了它是什么，这里只是装饰 */}
          <Image
            src="/icon.png"
            alt=""
            width={BALL_PX}
            height={BALL_PX}
            draggable={false}
            className="h-full w-full rounded-full"
          />

          {/*
            今日进度环。画在圆盘**内侧**（半径 19.5 / 44），
            所以既不会跟告警光环（在球外 3px）打架，也不用撑大布局。
            `-rotate-90` 把起点挪到 12 点方向（SVG 的 0° 在 3 点）。
          */}
          {today && !mini && (
            <svg
              viewBox="0 0 44 44"
              className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
              aria-hidden
            >
              <circle
                cx="22"
                cy="22"
                r={RING_R}
                fill="none"
                stroke="var(--color-track-on-dark)"
                strokeWidth="2.5"
              />
              <circle
                cx="22"
                cy="22"
                r={RING_R}
                fill="none"
                stroke="var(--color-brand-400)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - progressRatio(today.done, today.total))}
              />
            </svg>
          )}

          {/* 有 warning / danger 级动态时才亮的小点，其余时候保持安静 */}
          {alerting && (
            <span
              className="bg-accent-600 ring-page absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2"
              aria-hidden
            />
          )}
        </button>
      </div>

      {open && (
        <ConsolePanel
          runtime={runtime}
          dev={prefs.dev}
          maxHeight={panelMaxHeight}
          rise={panelSide === "above" ? "up" : "down"}
          onClose={() => setOpen(false)}
          onHide={() => {
            setOpen(false);
            updatePrefs({ hidden: true });
          }}
        />
      )}
    </div>
  );
}
