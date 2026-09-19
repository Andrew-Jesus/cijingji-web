/**
 * 控制台状态 —— zustand store
 *
 * 这一层只做胶水：生成 id 与时刻、调 notices.ts 的纯函数、暴露开合状态。
 * **业务规则一律不写在这里**（那样就没法单测了）。
 *
 * 为什么用全局 store 而不是 React Context：
 * 提示是**从任何地方推**的（首页、引导流程、以后的学习页、以后的服务端调用），
 * 推的时候那些地方并不在控制台的子树里。Context 要求包一层 Provider 并层层传函数，
 * 而 store 可以 `pushNotice(...)` 一行搞定（见文件末的便捷函数）。
 */
import { create } from "zustand";

import {
  hasAlert,
  insertNotice,
  makeNotice,
  topAlertLevel,
  type Notice,
  type NoticeInput,
  type NoticeLevel,
} from "./notices";

interface ConsoleStore {
  notices: Notice[];
  open: boolean;
  /**
   * 今日进度（小词外圈那道环读这个数）。
   * null = 还没排出今天的任务 —— 首页排完后会写进来。
   * 由首页写入而不是小词自己去算，是为了**避免两处各算一遍**（口径会飘）。
   */
  today: TodayProgress | null;
  push(input: NoticeInput): void;
  setOpen(next: boolean): void;
  toggle(): void;
  clear(): void;
  setToday(next: TodayProgress | null): void;
}

export interface TodayProgress {
  done: number;
  total: number;
  /**
   * 今天那一单的 id（就是本地日期，如 `2026-09-19`）。
   *
   * 有它，"继续今天的学习"才能**一步落到学习页**，而不是先回首页再点一次。
   * 可选：旧调用方（或首页还没排完时）没有这个值，那时退回"去首页"这条老路 ——
   * 缺一个字段不该让按钮失效。
   */
  sessionId?: string;
}

/**
 * id 只用来做 React 的 key，不做持久化，所以"时间前缀 + 自增"就够，
 * 不必动用 crypto（还能避免 SSR / 老内核下的可用性差异）。
 */
let seq = 0;
function nextNoticeId(): string {
  seq += 1;
  return `n${Date.now().toString(36)}-${seq}`;
}

export const useConsoleStore = create<ConsoleStore>((set) => ({
  notices: [],
  open: false,
  today: null,
  push: (input) =>
    set((s) => ({
      notices: insertNotice(s.notices, makeNotice(input, nextNoticeId(), new Date().toISOString())),
    })),
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  clear: () => set({ notices: [] }),
  setToday: (today) => set({ today }),
}));

/**
 * 给非组件代码用的一行式入口。
 * 页面里写 `pushNotice({ level: "success", title: "…" })` 即可，
 * 不需要订阅、也不需要 hook —— 推提示的地方通常根本不关心控制台长什么样。
 */
export function pushNotice(input: NoticeInput): void {
  useConsoleStore.getState().push(input);
}

/** 有没有 alert 级提示（悬浮球据此亮光环）。返回布尔值，引用稳定，不会引起多余重渲染 */
export function useConsoleAlert(): boolean {
  return useConsoleStore((s) => hasAlert(s.notices));
}

/** 最重的告警级别，给状态灯定颜色 */
export function useConsoleTopAlert(): NoticeLevel | null {
  return useConsoleStore((s) => topAlertLevel(s.notices));
}

/**
 * 首页排完今日计划后写一次，小词的进度环就跟着动。
 * 小词自己不去读 IndexedDB —— 排计划要跑一整套 resolveScope，
 * 为了一个环再跑一遍纯属浪费，而且两处口径迟早会飘。
 *
 * `sessionId` 一并带上：环旁边那个"继续今天的学习"要直接跳到学习页。
 */
export function setTodayProgress(done: number, total: number, sessionId?: string): void {
  useConsoleStore.getState().setToday({ done, total, ...(sessionId ? { sessionId } : {}) });
}

/** 今日进度。返回 null 表示还没排（小词此时不画环） */
export function useTodayProgress(): TodayProgress | null {
  return useConsoleStore((s) => s.today);
}
