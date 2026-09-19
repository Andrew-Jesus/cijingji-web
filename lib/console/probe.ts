/**
 * 运行时自检 —— 把"悬浮球自己能看到的状态"读出来
 *
 * 只读本机（IndexedDB / navigator / <html> 上的标记），**不发任何网络请求**。
 * 这与产品的"本地优先、首屏不等网络"是同一条原则：
 * 连控制台里的状态都不该依赖网络。
 */
import { db } from "@/lib/db/local";
import { MOTION_ATTR, MOTION_REDUCED } from "@/lib/ua/wechat";

export interface RuntimeSnapshot {
  words: number;
  placements: number;
  units: number;
  online: boolean;
  motionReduced: boolean;
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

export async function probeRuntime(): Promise<RuntimeSnapshot> {
  const [words, placements, units] = await Promise.all([
    db.words.count(),
    db.word_placements.count(),
    db.units.count(),
  ]);
  return { words, placements, units, online: readOnline(), motionReduced: readMotionReduced() };
}
