/**
 * 「我选的是哪个单元」—— 只写 localStorage，**不上云**。
 *
 * ── 为什么不塞进 Profile ─────────────────────────────────────
 * 它是"这台设备上先从哪本书哪个单元开始"的选择，而词库本身（阶段 1 的 D4）
 * 也还没上云。先放本机，等词库上云时再一起挪进 Profile ——
 * 比现在为它改一次 Dexie schema + 云端迁移划算得多。
 *
 * ── 为什么用 useSyncExternalStore，而不是 useState + useEffect ──
 * 与 `lib/console/prefs.ts` 同因：localStorage 属于"React 之外的存储"，
 * 用 useState + useEffect 去同步它会先在 effect 里 setState、再触发一轮级联渲染
 * （eslint 的 react-hooks/set-state-in-effect 也会直接拦下）。
 *
 * ── 读写全部包 try/catch ─────────────────────────────────────
 * 隐私模式 / 禁用存储时 localStorage 会直接抛异常，
 * 而"记不住偏好"绝不该把整页搞崩 —— 退回「没选过」即可。
 */
import { useSyncExternalStore } from "react";

const KEY = "cj.scope.unit";

/** null = 还没选过 → 用 `defaultScope()` 里那个默认单元 */
export type UnitSelection = string | null;

/**
 * 缓存的快照。**必须返回同一个引用**，否则 useSyncExternalStore 会
 * 认为"每次都在变"而无脑重渲染。
 *
 * 注意这里用 `undefined` 表示"还没读过盘"，`null` 是一个**合法值**（没选过）——
 * 两者不能混用，否则"从没选过"会被每次重新读盘。
 */
let cache: UnitSelection | undefined;
const listeners = new Set<() => void>();

function readFromStorage(): UnitSelection {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { unitId?: unknown };
    return typeof parsed.unitId === "string" && parsed.unitId.length > 0 ? parsed.unitId : null;
  } catch {
    return null;
  }
}

function getSnapshot(): UnitSelection {
  if (typeof window === "undefined") return null;
  if (cache === undefined) cache = readFromStorage();
  return cache;
}

/**
 * 水合时先用 null（= 默认单元），水合完成后 React 会自动拿真实值再渲染一次。
 * 这样服务端与客户端首帧完全一致，不会报水合不一致。
 */
function getServerSnapshot(): UnitSelection {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读当前选中的单元 id。订阅是模块级的，引用稳定 */
export function useSelectedUnitId(): UnitSelection {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 改选择：先更缓存（保证下一次读取是新的），再落盘，最后通知订阅者 */
export function selectUnit(unitId: string): void {
  cache = unitId;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ unitId }));
  } catch {
    /* 存不了就算了，不该打断用户正在做的事 */
  }
  for (const listener of listeners) listener();
}
