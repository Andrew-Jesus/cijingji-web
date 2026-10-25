/**
 * 「这次用多少分钟」的落盘位置 —— **只写 localStorage，不上云**。
 *
 * ── 为什么不进 Profile / 云端 ────────────────────────────────
 * 它回答的是"**这一次**我有多少时间"，不是"我是谁"。
 * 手机上前排等车选了 3 分钟，不该让家里电脑上的 20 分钟被改掉 ——
 * 跨设备同步在这里反而是错的（同步器也没有"哪台设备最后改的"这种概念值得加）。
 *
 * 引导里答的 `profile.daily_minutes` 是另一件事：那是"我的日常节奏"，
 * 进库、上云、参与同步。两者都在，但不互相覆盖。
 *
 * ── 读写全部包 try/catch ─────────────────────────────────────
 * 隐私模式 / 禁用存储时 `localStorage` 会直接抛异常，
 * 而"记不住这次选了多久"绝不该把整页搞崩 —— 退回"没选过"即可，下次按建议值给。
 *
 * ── 为什么这里没有 hook ──────────────────────────────────────
 * 页面把选中的分钟数放在自己的 state 里（它就是这一次的选择），
 * 本文件只负责两件 IO：进来时读一次、改了就写一次。
 * 用 `useSyncExternalStore` 去订阅一个"只在同一个页面里被改"的值是多余的，
 * 还会在首帧多跑一轮（服务端快照 null → 水合后真实值 → 页面重排一次）。
 */
import { parseStoredBudget, serializeBudget, suggestMinutes } from "./timeBudget";

const KEY = "cj.plan.budget";

/** 读上次选的分钟数。null = 从没选过 / 读不出来（两种情况处理方式相同：走建议值） */
export function readBudgetMinutes(): number | null {
  try {
    if (typeof window === "undefined") return null;
    return parseStoredBudget(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** 记住这次的选择。存不了就算了，不打断用户正在做的事 */
export function writeBudgetMinutes(minutes: number): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, serializeBudget(minutes));
  } catch {
    /* 隐私模式 / 配额满 —— 忽略 */
  }
}

/**
 * 页面用的解析入口：**上次选的 → 引导里答的每天多少**。
 *
 * 首页和学习页都调它，别各写一份 —— 否则从首页进是 20 分钟、
 * 从收藏夹直接进学习页却是 10 分钟，用户会觉得这软件记性不好。
 */
export function resolveBudgetMinutes(profileMinutes: number): number {
  return suggestMinutes({
    lastUsed: readBudgetMinutes(),
    profileMinutes,
  });
}
