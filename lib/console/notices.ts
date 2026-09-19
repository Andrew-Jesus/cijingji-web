/**
 * 控制台提示 —— 纯逻辑层
 *
 * 这一层**不碰 React、不碰 zustand、不碰浏览器 API**，所以能直接单测。
 * 项目硬约束：能做成纯函数的必须做成纯函数（store.ts 只留胶水）。
 *
 * ── 为什么要有"提示"这件事 ──────────────────────────────────
 * 产品里原本有太多"悄悄发生"的事：词库灌好了、任务单排出来了、网络断了。
 * 用户看不到，就感觉不到"系统在为我工作"。
 * 把这些事件收进左下角那个悬浮球里，既不打断操作，又能随时翻看 ——
 * 这就是控制台存在的意义（Andy 2026-09-19 提的"参考 Next.js 指示器"）。
 */

/** 提示级别。决定圆点颜色，也决定悬浮球要不要亮起"有情况"的光环 */
export type NoticeLevel = "info" | "success" | "warning" | "danger";

export interface Notice {
  id: string;
  level: NoticeLevel;
  /** 一句话说清发生了什么，控制在一行内 */
  title: string;
  /** 补充信息（数字、原因、下一步）。可省 */
  detail?: string;
  /** ISO 时刻。**只在客户端生成** —— 服务端渲染永远不产生提示，避免水合不一致 */
  at: string;
  /** 去重键：同 key 的新提示**顶掉**旧的，而不是排成两条 */
  key?: string;
}

/** 推入时的入参：id 与时刻由 store 补，调用方不用关心 */
export type NoticeInput = Omit<Notice, "id" | "at">;

/** 滑动窗口上限。超出的从尾部丢（尾部就是最老的） */
export const MAX_NOTICES = 40;

/** 需要"被看见"的级别 —— 悬浮球据此亮光环，其余级别安静地躺着 */
export const ALERT_LEVELS: readonly NoticeLevel[] = ["warning", "danger"];

export function makeNotice(input: NoticeInput, id: string, at: string): Notice {
  return { ...input, id, at };
}

/**
 * 插入一条提示，返回**新数组**（不改原数组）。
 *
 * 三条规则，顺序不能换：
 *   ① 同 key 的先删掉 —— 否则"每次刷新推一条"会滚成一大串
 *   ② 新条目放最前 —— 列表按时间倒序展示
 *   ③ 超出上限从尾部截断
 */
export function insertNotice(list: readonly Notice[], next: Notice): Notice[] {
  const kept = next.key ? list.filter((n) => n.key !== next.key) : list.slice();
  return [next, ...kept].slice(0, MAX_NOTICES);
}

/** 有没有需要被看见的级别。空列表返回 false（悬浮球此时不亮，保持安静） */
export function hasAlert(list: readonly Notice[]): boolean {
  return list.some((n) => ALERT_LEVELS.includes(n.level));
}

/** 最高的告警级别 —— 状态灯用它定颜色；没有告警时返回 null */
export function topAlertLevel(list: readonly Notice[]): NoticeLevel | null {
  if (list.some((n) => n.level === "danger")) return "danger";
  if (list.some((n) => n.level === "warning")) return "warning";
  return null;
}

/**
 * "14:32"。
 * 非法时刻返回 `--:--` 而不是抛错 —— 一条提示的时间戳坏了，
 * 不该把整个面板拖垮（面板是"兜底可看"的东西）。
 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 「复制全部」按钮要的整段文本。给的是纯文本，粘到哪里都能读 */
export function noticesToText(list: readonly Notice[]): string {
  if (list.length === 0) return "（暂无动态）";
  return list
    .map((n) => {
      const head = `[${formatClock(n.at)}] ${n.title}`;
      return n.detail ? `${head}\n    ${n.detail}` : head;
    })
    .join("\n");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
