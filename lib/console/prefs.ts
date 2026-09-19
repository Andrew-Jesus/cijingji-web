/**
 * 小词的本机偏好 —— 藏起来没有、开发者模式开没开、球停在哪儿
 *
 * 三件事都只写 localStorage，**不上云**：
 * 它们是"这台设备上的手感"，换台设备本来就该重新摆一次，
 * 没必要为它走一趟网络（何况阶段 0 还没有账号体系）。
 *
 * ── 为什么用 useSyncExternalStore，而不是 useState + useEffect ──
 * localStorage 属于"React 之外的存储"。用 useState + useEffect 去同步它，
 * 会先在 effect 里同步 setState、再触发一轮级联渲染 —— React 官方明确不建议
 * （eslint 的 react-hooks/set-state-in-effect 也会直接拦下）。
 * useSyncExternalStore 正是为这种场景设计的：它自己负责订阅、并在水合后
 * 用真实值补一次渲染，**不需要我们手写"挂载后再读"的开关**。
 *
 * ── 读写全部包 try/catch ───────────────────────────────────────
 * 隐私模式 / 禁用存储时 localStorage 会直接抛异常，
 * 而"记不住偏好"绝不该把整页搞崩 —— 退回默认值即可。
 */
import { useSyncExternalStore } from "react";

import { DEFAULT_SPOT, clampSpotRatio, type DockSpot } from "./dock";

const KEY = "cj.dock";

export interface DockPrefs {
  /** 用户主动把小词收起来了（只留一点点，可点回来） */
  hidden: boolean;
  /** 开发者模式：面板里多出「运行状态」与工具条 */
  dev: boolean;
  spot: DockSpot;
}

export const DEFAULT_PREFS: DockPrefs = {
  hidden: false,
  dev: false,
  spot: DEFAULT_SPOT,
};

/** 从存储里读。每个字段都验一遍 —— 值可能被手改过，也可能是旧版本留下的 */
function readFromStorage(): DockPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<DockPrefs>;
    return {
      hidden: parsed.hidden === true,
      dev: parsed.dev === true,
      spot: {
        side: parsed.spot?.side === "right" ? "right" : "left",
        ratio: clampSpotRatio(parsed.spot?.ratio ?? DEFAULT_SPOT.ratio),
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * 缓存的快照。**必须返回同一个引用**，否则 useSyncExternalStore 会
 * 认为"每次都在变"而无脑重渲染（甚至死循环）。
 */
let cache: DockPrefs | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): DockPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  if (cache === null) cache = readFromStorage();
  return cache;
}

/**
 * 水合时先用默认值，水合完成后 React 会自动拿真实值再渲染一次。
 * 这样服务端与客户端首帧完全一致，不会报水合不一致。
 */
function getServerSnapshot(): DockPrefs {
  return DEFAULT_PREFS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读偏好。订阅是模块级的，引用稳定 */
export function usePrefs(): DockPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 改偏好：先更缓存（保证下一次读取是新的），再落盘，最后通知订阅者 */
export function updatePrefs(patch: Partial<DockPrefs>): void {
  const next = { ...getSnapshot(), ...patch };
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不了就算了，不该打断用户正在做的事 */
  }
  for (const listener of listeners) listener();
}
