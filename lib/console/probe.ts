/**
 * 运行时自检 —— 把"悬浮球自己能看到的状态"读出来
 *
 * 只读本机（IndexedDB / navigator / <html> 上的标记），**不发任何网络请求**。
 * 这与产品的"本地优先、首屏不等网络"是同一条原则：
 * 连控制台里的状态都不该依赖网络。
 */
import { db } from "@/lib/db/local";
import { CACHE_PREFIX } from "@/lib/pwa/cache";
import { MOTION_ATTR, MOTION_REDUCED } from "@/lib/ua/wechat";

export interface RuntimeSnapshot {
  words: number;
  placements: number;
  units: number;
  online: boolean;
  motionReduced: boolean;
  /**
   * 门房（Service Worker）的情况。**它平时完全不可见** ——
   * "离线能不能用"出了问题，界面上没有任何地方会红，用户也只会说"打不开"。
   * 所以这一格是给排查用的：有没有登记上、有没有真的接管、正在用哪个缓存。
   */
  offline: OfflineSnapshot;
}

export interface OfflineSnapshot {
  /** 浏览器支不支持门房（老浏览器 / 非安全上下文就是 false） */
  supported: boolean;
  /** 登记上了没有。登记 ≠ 接管：第一次装完，通常要再打开一次才受控 */
  registered: boolean;
  /** **这个页面**是不是已经由门房接管 —— 只有它才是"断网能重开"的前提 */
  controlled: boolean;
  /** 正在用的缓存里那个版本号（`cijingji-<版本>` 的后半段），没有就是 null */
  cacheVersion: string | null;
}

/**
 * 动效降级标记由首帧前的内联脚本打在 <html> 上（见 lib/ua/wechat.ts）。
 * SSR 时读不到，返回 false —— 面板本来也只在客户端出现。
 */
export function readMotionReduced(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute(MOTION_ATTR) === MOTION_REDUCED;
}

/**
 * `navigator.onLine` 只代表"网卡有没有连上"，不代表真的能出网，
 * 所以面板上的文案别写成"网络正常"，写"在线 / 离线"就够诚实。
 */
export function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * 读门房的现状。**全程只读** —— 不注册、不触发更新、不发任何请求。
 * （"读状态"这件事本身绝不该有副作用，否则开发者模式一开就把线上缓存搅了。）
 */
export async function probeOffline(): Promise<OfflineSnapshot> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { supported: false, registered: false, controlled: false, cacheVersion: null };
  }

  let registered = false;
  try {
    registered = (await navigator.serviceWorker.getRegistration()) !== undefined;
  } catch {
    /* 取不到就按"没登记"显示 —— 这一格是给人看的，不值得为它抛错 */
  }

  let cacheVersion: string | null = null;
  try {
    if (typeof caches !== "undefined") {
      const mine = (await caches.keys()).find((key) => key.startsWith(CACHE_PREFIX));
      cacheVersion = mine ? mine.slice(CACHE_PREFIX.length) : null;
    }
  } catch {
    /* 非安全上下文（http 而不是 https / localhost）下 `caches` 拿不到 */
  }

  return {
    supported: true,
    registered,
    controlled: navigator.serviceWorker.controller !== null,
    cacheVersion,
  };
}

export async function probeRuntime(): Promise<RuntimeSnapshot> {
  const [words, placements, units, offline] = await Promise.all([
    db.words.count(),
    db.word_placements.count(),
    db.units.count(),
    probeOffline(),
  ]);
  return {
    words,
    placements,
    units,
    online: readOnline(),
    motionReduced: readMotionReduced(),
    offline,
  };
}
