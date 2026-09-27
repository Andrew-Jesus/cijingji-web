"use client";

/**
 * 小词 —— 全站常驻的那块「活体材料」
 *
 * 它只有**一块材料**，但有**两个家**：
 *   · **角落**：平时待命（小点 / 胶囊），可拖、位置有记忆；
 *   · **台上**：屏幕顶部中央，有事的时候登台（紧凑岛 / 横幅），说完或做完再回家。
 * 形态参考灵动岛的**思路**（形状即状态 / 连续形变 / 一物多用 / 在场不打扰），
 * 但位置与形状都按 Web 的实际情况重做过 —— 具体取舍见
 * `词径记-小词灵动岛-设计方案-v1.md` 与施工单 §10。
 *
 * ── 为什么挂在根 layout ───────────────────────────────────────
 * 它全站常驻，而且要在"页面还没加载完"时就报状态 ——
 * 词库装载、网络断开这些事，恰恰发生在首屏之前。
 *
 * ── 六件事分别归谁管（别混着写）────────────────────────────────
 *   · 该不该露面                     → `lib/console/dock.ts`（纯函数，有单测）
 *   · 长什么样 / 每一档多大           → `lib/island/form.ts`（纯函数，有单测）
 *   · 待在哪个家 / 面板封顶多高        → `lib/island/stage.ts`（纯函数，有单测）
 *   · 藏起来没有 / 它停在哪儿         → `lib/console/prefs.ts`（只写 localStorage）
 *   · 本组件只负责把结论落到 DOM 上
 *
 * ── 「同一块材料」是这一版的核心（2026-09-26）──────────────────
 * 各档**不许**写成几个组件按状态条件渲染 —— 那样用户看到的是"旧的消失 + 新的出现"，
 * 那是弹窗，不是灵动岛。所以：
 *   · **承载材料只有一个**，就是下面那个 `<button>` 本身，尺寸与圆角都在它身上做过渡；
 *   · 内容（环 / 文字 / 横幅 / 进度条）是它的孩子，在形变**后半段**才淡入；
 *   · 卡片（面板）是另一块东西，不是材料 —— 面板开着时它仍然是胶囊（面板的"把手"）。
 *
 * ── 位置为什么整段改用 `transform: translate()`（2026-09-26）──
 * 角落那套是 `bottom` 锚、台上那套天然是 `top` 锚，而 CSS 里 `auto → 长度` **不能过渡**，
 * 硬切会有一帧"啪"地跳过去。所以把一个定位层钉在视口左上角，位置全部由 transform 表达 ——
 * 换家就是 transform 的变化，可平滑过渡，也正好落在"只动 translate / scale / opacity"里。
 * 代价是当前档的宽高要以 `--island-w` / `--island-h` 两个自定义属性带下去，
 * 好让"贴右边""贴底边""居中"这些算式能自己减掉它自己的宽高
 * （于是**仍然不需要**在 JS 里读 `window.innerWidth` —— 那会多一个水合陷阱）。
 *
 * ── 面板为什么从"flex 兄弟"改成"绝对定位的孩子"（2026-09-26）──
 * 旧写法靠 `flex-col / flex-col-reverse` 让面板长在材料的上边或下边，
 * 那要求容器按 `bottom` 锚定。现在容器改由 transform 定位，若面板还在流里，
 * 面板一展开就会把材料顶走。改成绝对定位后：**容器的高度恒等于材料的高度**，
 * 面板挂在 `top: calc(100% + 缝)` 或 `bottom: calc(100% + 缝)` 上，
 * 材料纹丝不动 —— 也就顺带把"面板会不会把材料顶走"这个隐患彻底去掉了。
 *
 * ── 为什么"拖拽"要接管 touch-action ──────────────────────────
 * 材料上必须写 `touch-action: none`，否则手指一动就变成滚页面，拖拽永远开始不了。
 * 代价是从它上面起手的滚动没了 —— 它只有 44px 高，这个代价可以接受。
 */

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import {
  BOTTOM_MARGIN_PX,
  PANEL_GAP_PX,
  TOP_LIMIT_PX,
  clampSpotRatio,
  classifyGesture,
  dockPresentation,
  nearestSide,
  type DockSpot,
} from "@/lib/console/dock";
import { updatePrefs, usePrefs } from "@/lib/console/prefs";
import { probeRuntime, type RuntimeSnapshot } from "@/lib/console/probe";
import { pushNotice, useConsoleAlert, useConsoleStore, useTodayProgress } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { ensureSeeded } from "@/lib/db/seed";
import {
  BANNER_HOLD_MS,
  LIVE_HOLD_MS,
  SQUASH_MS,
  bannerNotice,
  islandBox,
  islandForm,
  islandShape,
  isStretching,
  motionMode,
  type IslandShape,
} from "@/lib/island/form";
import {
  contentSlidePx,
  panelMaxHeightExpr,
  panelSideForStage,
  stageFor,
  stageTransform,
} from "@/lib/island/stage";

import { ConsolePanel } from "./ConsolePanel";
import { IslandBanner } from "./IslandBanner";
import { IslandLive } from "./IslandLive";
import { IslandPill } from "./IslandPill";

/** 按住多久算长按（开/关开发者模式）。一旦开始拖拽就把计时器清掉 */
const LONG_PRESS_MS = 600;
/** 换家的过渡。拖拽中会临时关掉，松手才让它滑过去 */
const SLIDE = "transform var(--duration-slow) var(--ease-soft)";

/** 一次按下的全部临时状态。放 ref 不放 state：pointermove 每帧都在改，进 state 会每帧重渲染 */
interface PressState {
  id: number | null;
  x: number;
  y: number;
  offX: number;
  offY: number;
  viewportH: number;
  /** 按下那一刻这个元素**自己**的宽高。拖拽时要把"中心"换回"左上角"，
   *  而各档的宽高差别很大（16 / 164 / 240 / 358），所以要现取 */
  elW: number;
  elH: number;
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
  elW: 0,
  elH: 0,
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
  const notices = useConsoleStore((s) => s.notices);
  const alerting = useConsoleAlert();
  const today = useTodayProgress();

  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  /** 拖拽中的实时位置（元素**中心**的视口坐标 + 它自己多大）。松手后清空，位置交回 prefs.spot */
  const [dragAt, setDragAt] = useState<{
    cx: number;
    cy: number;
    w: number;
    h: number;
  } | null>(null);
  /** 已经被按掉的那条横幅。同一个 id 不再冒出来 —— I2 的降噪限流也从这条开始长 */
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  /**
   * 「正在跑的事」这个窗口 —— 第几次被"有动静"推开。`0` = 现在没有事在跑。
   *
   * 为什么用**计数器**而不是存一个"截止时刻"：存时间就得在渲染里读一次 `Date.now()`
   * 才知道窗口还在不在，而 `Date.now()` 是**不纯函数**，渲染期间调用会被
   * `react-hooks/purity` 拦下。改成计数之后，渲染只读 state，时间全交给下面两个
   * effect 里的定时器管 —— 顺带还更好测。
   */
  const [liveSeq, setLiveSeq] = useState(0);
  /** 中段收细演到第几次。只为"换一个关键帧名字"，好让同一个动画能重播（见下） */
  const [squashSeq, setSquashSeq] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLButtonElement>(null);
  const press = useRef<PressState>({ ...IDLE_PRESS });
  /** 上一次看到的今日完成数。用来认"刚刚跳了一格" */
  const prevDone = useRef<number | null>(null);
  /** 上一次的形态。用来认"这一步是在拉长" */
  const prevShape = useRef<IslandShape | null>(null);

  // ── 结论：形态 / 家 / 面板（规则全在三个纯函数里，都有单测）──────
  /** 用户主动收起了（只留一颗小点，点一下能请回来） */
  const tucked = prefs.hidden;
  /** 背词进行中 —— 材料淡下去一点，少抢注意力 */
  const mini = !tucked && presentation === "mini";
  /** 动效降级（微信 UA / 系统"减少动态效果"） */
  const motionReduced = runtime?.motionReduced === true;
  const motion = motionMode(motionReduced);

  /** 最新一条"值得说"的动态。null = 它没话可说 */
  const speakable = bannerNotice(notices, dismissedId);
  /**
   * 有件正在跑的事（最近刚有动静）。
   *
   * 服务端与客户端首帧都是 `0`，两边都得到 `false`，不会有水合不一致。
   */
  const live = liveSeq > 0;

  const formInput = {
    presentation,
    tucked,
    open,
    speaking: speakable !== null,
    live,
  };
  const form = islandForm(formInput);
  const shape = islandShape(form);
  const stage = stageFor({ ...formInput, motionReduced });

  const banner = shape === "banner" ? speakable : null;
  /** 有进度数字可报吗 —— 决定胶囊宽一档（环 + 字）还是窄一档（只放「词」） */
  const hasProgressText = today !== null && today.total > 0;
  const box = islandBox(shape, { hasProgressText });
  /** 面板往哪边长。**这是"面板会不会跑出屏幕"的唯一开关**（规则在 stage.ts，有单测） */
  const panelSide = panelSideForStage(stage, prefs.spot.ratio);
  /** 内容从哪一侧滑出来 */
  const slidePx = contentSlidePx(stage, prefs.spot.side);

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

  /*
    ④ 横幅说完就走。
    到点后把它记进 dismissedId —— 之后它不再冒出来。
    用"记 id"而不是"关掉它"，是因为这条动态本身还得留在面板的动态列表里，
    只是不该在上面挂着了。
  */
  useEffect(() => {
    if (!speakable) return;
    const id = speakable.id;
    const timer = window.setTimeout(() => setDismissedId(id), BANNER_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [speakable]);

  /*
    ⑤ 「正在跑的事」的窗口 —— 这就是"事多久待多久"。

    今日进度**每跳一格**，计数器就 +1：你还在背，它一直在；你不背了（进度不动），
    12 秒后它自己回角落。跟苹果 Live Activity 同一条规矩。

    为什么用"计数器"而不是"截止时刻"：存时间就得在渲染里读 `Date.now()` 才知道
    窗口还在不在，而那是不纯函数（`react-hooks/purity` 会拦）。计数器一改，
    下面 ⑥ 那个 effect 就会重跑 —— 计时自然被刷新，正好就是"跳一格刷新计时"。
  */
  useEffect(() => {
    const done = today?.done ?? null;
    if (done === null) {
      prevDone.current = null;
      return;
    }
    const total = today?.total ?? 0;
    const prev = prevDone.current;
    prevDone.current = done;
    // 首帧不算"跳了一格"；往回退（换天 / 清数据）也不算
    if (prev === null || done <= prev) return;
    // 今天已经背完就不再报"收尾中" —— 那是另一件事（属于 I2 的场景表）
    if (done >= total) return;
    // 放进定时器里改 state：effect 体内同步 setState 会被 react-hooks 规则拦下
    const timer = window.setTimeout(() => setLiveSeq((n) => n + 1), 0);
    return () => window.clearTimeout(timer);
  }, [today]);

  /*
    ⑥ 12 秒没动静就归位。

    `liveSeq` 每变一次（= 每跳一格）这个 effect 就重跑一遍：旧定时器清掉、新定时器
    重新起算 —— 「跳一格刷新计时」的全部实现就是这一句。

    `open` 在依赖里，是为了**面板开着的时候不收回** —— 用户正低头看面板，
    整块东西（连着面板）突然飞回角落会很吓人。等他关掉面板，这个 effect 重跑，
    重新给满一个窗口。
  */
  useEffect(() => {
    if (liveSeq === 0 || open) return;
    const timer = window.setTimeout(() => setLiveSeq(0), LIVE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [liveSeq, open]);

  /*
    ⑦ 中段收细 —— 「被拉长」的手感。

    只在**变宽**的那一步演一次：横着拉长时中段细一点，像软糖被扯开。
    往回缩不演（缩的时候再收细就变成"瘪"了）。

    两个关键帧名字轮流用（island-squash-a / -b），是为了**重启**动画：
    同一个元素重复设同一个 animation-name，浏览器认为"没变"，不会重播。
    也不能靠给材料换 `key` 重挂载 —— 那样过渡就没有起点，形变会直接跳过去。
  */
  useEffect(() => {
    const from = prevShape.current;
    prevShape.current = shape;
    if (from === null || from === shape) return;
    if (!isStretching(from, shape)) return;
    const timer = window.setTimeout(() => setSquashSeq((n) => n + 1), 0);
    return () => window.clearTimeout(timer);
  }, [shape]);

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
      // 记下"抓它时手指离它中心多远"，拖的时候它才不会突然跳到手指底下
      offX: rect ? rect.left + rect.width / 2 - e.clientX : 0,
      offY: rect ? rect.top + rect.height / 2 - e.clientY : 0,
      viewportH: window.innerHeight,
      elW: rect?.width ?? 0,
      elH: rect?.height ?? 0,
      dragging: false,
      timer: null,
      swallowClick: false,
    };
    // 抓住指针：手指滑出材料外，move / up 也仍然回到它上面。
    // 包 try/catch 是因为合成事件（自动化测试、少数旧内核）里 pointerId 可能无效，
    // 那种情况下 setPointerCapture 会抛 NotFoundError —— 不该因此让它点不动。
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
      // 拖它 = 想让它让开，这时候还说着话就是找骂（场景表第 16 条）。
      // 顺手把当前那条横幅按掉，不用再等 5.6 秒。
      if (speakable) setDismissedId((id) => id ?? speakable.id);
    }
    setDragAt({ cx: e.clientX + p.offX, cy: e.clientY + p.offY, w: p.elW, h: p.elH });
  }

  function onPointerUp(e: PointerEvent<HTMLButtonElement>) {
    const p = press.current;
    if (p.id !== e.pointerId) return;
    clearLongPress();

    if (p.dragging) {
      // 竖直位置换算成比例。可用行程与"落到哪一边"都在这里现算 ——
      // 只有这一刻才需要真实像素，所以不必为此在组件里存一份视口尺寸。
      const travel = Math.max(1, p.viewportH - p.elH - BOTTOM_MARGIN_PX - TOP_LIMIT_PX);
      const centerY = e.clientY + p.offY;
      const spot: DockSpot = {
        side: nearestSide(e.clientX + p.offX, window.innerWidth),
        ratio: clampSpotRatio((centerY - p.elH / 2 - TOP_LIMIT_PX) / travel),
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

  // ── 位置 ────────────────────────────────────────────────────────
  /**
   * 当前档的宽高，作为自定义属性带下去。
   *
   * `stage.ts` 那几套算式靠它自己减掉自己的宽高（贴右边、贴底边、居中都要用）。
   * 传 CSS 长度而不是像素数字，是为了让宽度里的 `min()` 也能原样带过去 ——
   * 于是**不需要在 JS 里读视口宽**，也就没有"服务端不知道屏幕多宽"的水合陷阱。
   */
  const sizeVars = {
    "--island-w": box.matW,
    "--island-h": box.matH,
  } as CSSProperties;

  const rootStyle: CSSProperties = dragAt
    ? {
        ...sizeVars,
        transform: `translate(${dragAt.cx - dragAt.w / 2}px, ${dragAt.cy - dragAt.h / 2}px)`,
        transition: "none",
      }
    : {
        ...sizeVars,
        transform: stageTransform({ stage, side: prefs.spot.side, ratio: prefs.spot.ratio }),
        transition: SLIDE,
      };

  /**
   * 面板能有多高 = 那一侧**真实剩下的空间**，所以它永远不可能伸出屏幕。
   * 算式在 `stage.ts`（有单测）—— 那是 09-19 修"面板跑出屏幕"留下的性质，不许退。
   */
  const panelMaxHeight = panelMaxHeightExpr(stage, prefs.spot.ratio, panelSide);

  /**
   * 材料本体的样式。各档共用同一份 —— **这就是"同一块材料"的落点**：
   * 变的只有宽、高、圆角，看起来才像一块材料被拉伸，而不是换了个东西。
   *
   * 中段收细挂在这里（材料层）。它不能挂在外层定位层上 —— 位移在那儿，
   * 一个元素身上同时既有 `translate` 又播 `scaleY` 关键帧会互相覆盖。
   */
  const materialStyle: CSSProperties = {
    width: box.matW,
    height: box.matH,
    borderRadius: box.radius,
    transition: motion.material,
    ...(squashSeq > 0 && motion.squash
      ? { animation: `${squashSeq % 2 === 0 ? "island-squash-a" : "island-squash-b"} ${SQUASH_MS}ms var(--ease-soft)` }
      : null),
  };

  const materialClass = `bg-ink focus-visible:ring-brand-600 focus-visible:ring-offset-page relative block touch-none select-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
    alerting ? "shadow-alert" : "shadow-float"
  }`;

  /** 只在 Dot 档出现的隐形点击扩边 —— 材料太小时靠它把可点范围撑到 44 */
  const hitPad = box.hitInset > 0 ? (
    <span aria-hidden className="absolute" style={{ inset: `-${box.hitInset}px` }} />
  ) : null;

  // 用户把小词收起来了：只留一颗小点，点一下就能请回来。
  // （等以后有了「设置」页，这里应该换成一个正经的开关。）
  if (tucked) {
    return (
      <div
        ref={rootRef}
        style={rootStyle}
        data-island-stage="corner"
        className="fixed top-0 left-0 z-50"
      >
        <button
          type="button"
          onClick={() => updatePrefs({ hidden: false })}
          aria-label="显示小词"
          data-island-shape="dot"
          data-island-material
          style={materialStyle}
          className={`${materialClass} rounded-full hover:scale-125`}
        >
          {hitPad}
        </button>
      </div>
    );
  }

  // 引导流程前半段完全不出现 —— 新用户还没建立认知，浮球只会分心
  if (presentation === "hidden") return null;

  return (
    <div
      ref={rootRef}
      style={rootStyle}
      data-island-stage={stage}
      className="fixed top-0 left-0 z-50"
    >
      {/*
        材料那一层。它的高度**就是**容器的高度（面板不在流里），
        所以定位层的 translate 落在哪，材料就落在哪 —— 面板开合不会把它顶走。
      */}
      <div className="group relative">
        {/*
          悬停时浮出的名称条。窄屏（基本都是触屏）不显示 ——
          触屏点一下会留下"粘住的 hover"，那条字会一直挂在边上。
          在哪一边，条子就往**另一侧**伸，否则会顶出屏幕外。
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
          /*
            说话时把话也报给读屏 —— 内容层是 aria-hidden 的（那是装饰性排布），
            所以名字必须带上正文，否则用读屏的人永远听不到横幅说了什么。
          */
          aria-label={banner ? `小词：${banner.title}` : "小词"}
          data-island-shape={shape}
          data-island-material
          style={materialStyle}
          className={`${materialClass} rounded-full ${mini ? "opacity-70" : "hover:scale-105"}`}
        >
          {hitPad}

          {/*
            内容裁剪层。`borderRadius: inherit` 跟着材料走 ——
            形变时它不用另做过渡，圆角天然同步（也就不会在动画中间露直角）。
          */}
          <span className="absolute inset-0 overflow-hidden" style={{ borderRadius: "inherit" }}>
            <IslandPill
              visible={shape === "dot" || shape === "pill"}
              delayMs={motion.contentDelayMs}
              slidePx={slidePx}
              progress={today}
            />
            <IslandLive
              visible={shape === "live"}
              delayMs={motion.contentDelayMs}
              slidePx={slidePx}
              progress={today}
            />
            <IslandBanner
              notice={banner}
              delayMs={motion.contentDelayMs}
              slidePx={slidePx}
            />
          </span>

          {/*
            有 warning / danger 级动态时才亮的小点，其余时候保持安静。
            Dot 档没有角落可挂（材料只有 16px），那一档靠外圈陶土柔光代替 ——
            它本来就更像"体温"而不是"通知徽标"。
          */}
          {alerting && shape !== "dot" && (
            <span
              className="bg-accent-600 ring-page absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2"
              aria-hidden
            />
          )}
        </button>
      </div>

      {/*
        面板：绝对定位挂在材料的上边或下边（不再是 flex 兄弟）。
        `100%` 就是材料的高 —— 因为容器的高度恒等于材料的高。
        横向贴着材料同一边（贴左就左对齐、贴右就右对齐），所以不用算任何偏移。
      */}
      {open && (
        <div
          className="absolute"
          style={{
            left: prefs.spot.side === "left" ? 0 : "auto",
            right: prefs.spot.side === "left" ? "auto" : 0,
            ...(panelSide === "above"
              ? { top: "auto", bottom: `calc(100% + ${PANEL_GAP_PX}px)` }
              : { top: `calc(100% + ${PANEL_GAP_PX}px)`, bottom: "auto" }),
          }}
        >
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
        </div>
      )}
    </div>
  );
}
