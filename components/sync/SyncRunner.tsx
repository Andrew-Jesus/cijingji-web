"use client";

/**
 * 同步的节拍器。
 *
 * ── 为什么挂在 `(app)` 外壳上，而不是每个页面各写一遍 ────────────
 * `(app)/layout.tsx` 是首页与学习页共用的外壳 —— 挂在这里，
 * 将来往 `(app)` 里加新页面时**自动**就有同步，不用记得去补。
 * 反过来，每个页面各写一个 `useEffect` 的写法一定会在某次加页面时漏掉一个，
 * 而"某个页面不同步"这种问题，用户是察觉不到的（数据只是慢一拍）。
 *
 * ── 它负责的两个时机（§7.5 一共四个）──────────────────────────
 *   · **进来就同步一次**：一条代码同时覆盖了"登录成功后"与"首页加载完成后"
 *     （这两个时机在真实使用里本来就是同一个动作：进到受保护页面）
 *   · **`online` 事件**：断网恢复的瞬间自动补上 —— 这正是验收 V2 要的行为
 *
 * 另外两个不在这里，各有理由：
 *   · "学习页结算"由那一页自己触发 —— 只有它知道什么时候练完了
 *   · **定时轮询刻意不做**：浪费流量、浪费电量，上面这几个时机已经够了
 *
 * ── 为什么这个组件不渲染任何东西 ──────────────────────────────
 * 它是**行为**，不是界面。返回 `null` 是为了能安全地塞进布局里，
 * 不产生任何多余的元素（这个项目的布局间距都是调好的，多包一层会挤歪）。
 */
import { useEffect } from "react";

import { syncNow } from "@/lib/sync/sync";

export function SyncRunner() {
  useEffect(() => {
    // 不 await：界面的节奏不该等网络。失败会被 syncNow 内部吞掉，这里不会被 reject。
    void syncNow("home");

    const handleOnline = () => void syncNow("online");
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  return null;
}
