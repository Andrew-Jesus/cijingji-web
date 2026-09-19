"use client";

/**
 * 小词展开后看到的面板
 *
 * 三块，从上到下：
 *   ① 今日任务 —— 今天做了多少 / 一共多少，加一个"继续"按钮
 *   ② 动态 —— 网站各处推来的提示，倒序排列（最新在最上）
 *   ③ 页脚 —— 收起小词
 *
 * ── 「运行状态」为什么不在常规视野里 ─────────────────────────
 * 数据置信度、渲染是否降级、剪贴板导出……这些是**给开发者排查问题的**，
 * 用户看了只会困惑（"置信度 75%"是什么意思？）。所以它们只在
 * **开发者模式**下出现（长按悬浮球 0.6 秒进入），日常完全看不见。
 *
 * ── 两条刻意的设计决定（沿用上一版，别改）─────────────────────
 * 1. **不编任何假参数**（比如版本号）。这块面板的价值就是"这里说的是真的"，
 *    编一个进去等于自毁。
 * 2. **不写结论性的漂亮话**。网络那行写"在线 / 离线"，不写"网络正常" ——
 *    `navigator.onLine` 只代表网卡连着，不代表真能出网。
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatClock, noticesToText, type NoticeLevel } from "@/lib/console/notices";
import type { RuntimeSnapshot } from "@/lib/console/probe";
import { pushNotice, useConsoleStore, useConsoleTopAlert, useTodayProgress } from "@/lib/console/store";
import { formatCny } from "@/lib/ai/contract";
import { formatCacheHitRate, summarizeUsage, type UsageStats } from "@/lib/ai/usageStats";
import { seedBundle } from "@/lib/db/seed";
import { loadRecentAiUsage } from "@/lib/db/studyRepo";
import { progressRatio } from "@/lib/plan/todayProgress";

/** 级别 → 圆点颜色。走 design token 的类名，不写死色值 */
const LEVEL_DOT: Record<NoticeLevel, string> = {
  info: "bg-brand-600",
  success: "bg-success-600",
  warning: "bg-warning-600",
  danger: "bg-danger-600",
};

const BUILD_LABEL = process.env.NODE_ENV === "production" ? "正式版" : "开发版";
const CONFIDENCE_PCT = Math.round(seedBundle.meta.confidence * 100);

export function ConsolePanel({
  runtime,
  dev,
  maxHeight,
  rise,
  onClose,
  onHide,
}: {
  runtime: RuntimeSnapshot | null;
  dev: boolean;
  /**
   * 面板能长多高 —— **CSS 长度表达式，不是像素值**。
   * 由球当前的位置算出来（那一侧还剩多少空间），见 ConsoleDock。
   * 传表达式而不是数字，是为了让它在转屏 / 手机地址栏收放时自动重算。
   */
  maxHeight: string;
  /**
   * 入场方向。面板长在球上方 → 往上冒；长在球下方 → 往下落。
   * 方向反了会像是"面板穿过球钻出来"，观感不对。
   */
  rise: "up" | "down";
  onClose: () => void;
  onHide: () => void;
}) {
  const router = useRouter();
  const notices = useConsoleStore((s) => s.notices);
  const clear = useConsoleStore((s) => s.clear);
  const alert = useConsoleTopAlert();
  const today = useTodayProgress();
  const [copied, setCopied] = useState(false);
  /**
   * 今天的 AI 记账汇总。**只在开发者模式下读** ——
   * "调了几次、花了多少钱、缓存命中多少"对用户毫无意义，
   * 而每次打开面板都去扫一遍 `ai_usage` 表也是白费。
   */
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dev) return;
    let cancelled = false;
    void loadRecentAiUsage()
      .then((rows) => {
        if (!cancelled) setUsage(summarizeUsage(rows, new Date()));
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dev]);

  // 面板只在用户点开后才渲染（store.open 初值为 false），所以这里读时钟不会
  // 造成服务端 / 客户端水合不一致。
  const now = new Date();
  const dateLabel = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${"日一二三四五六"[now.getDay()]}`;

  // 展开就把焦点收进面板：键盘用户按 Esc 才能生效（不然焦点还留在球上）
  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(noticesToText(notices));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      pushNotice({
        key: "clipboard",
        level: "success",
        title: "动态已复制",
        detail: `${notices.length} 条，可直接粘贴`,
      });
    } catch {
      pushNotice({
        key: "clipboard",
        level: "warning",
        title: "复制失败",
        detail: "浏览器拒绝了剪贴板访问 —— 非 HTTPS 环境下会这样，可以手动选中文字",
      });
    }
  }

  const lampClass =
    alert === "danger"
      ? "bg-danger-600"
      : alert === "warning"
        ? "bg-warning-600"
        : "bg-success-600";

  return (
    <div
      id="console-panel"
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="小词"
      data-animated
      data-rise={rise}
      /*
        高度由外面算好传进来，**不写 max-h-[70vh]** ——
        70vh 是相对视口算的，管不住"面板往上长到哪"：
        球被拖到屏幕上半部时，面板依然能长到视口的 70% 高，
        然后整块从屏幕顶上冒出去（实测顶边 −429px）。
        现在封顶高度 = 球那一侧真实剩下的空间，所以永远出不去。
        内容超了就在这块里滚动。
      */
      style={{ maxHeight }}
      className="border-subtle bg-surface shadow-float w-[min(20rem,calc(100vw-2.5rem))] overflow-y-auto rounded-lg border outline-none"
    >
      {/* ① 头部 */}
      <header className="border-subtle flex items-start gap-3 border-b px-4 py-3">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${lampClass}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-primary text-sm leading-none font-medium">小词</p>
          <p className="text-tertiary mt-1.5 text-[11px] tracking-[0.06em]">
            {dev ? `${BUILD_LABEL} · 开发者模式` : dateLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-tertiary hover:text-secondary focus-visible:ring-brand-600 focus-visible:ring-offset-surface -mt-0.5 -mr-1 shrink-0 rounded-sm px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          收起
        </button>
      </header>

      {/* ② 今日任务 */}
      <section className="px-4 pt-4 pb-4">
        {/*
          这里**不再**在标题右边重复一遍"12 / 36 词" —— 大数字就在下面一行，
          同一块区域里把同一个数写两遍，看着像没做完。
        */}
        <p className="text-tertiary text-[11px] tracking-[0.08em]">今日任务</p>

        {today ? (
          <>
            <p className="text-primary mt-3 flex items-baseline text-2xl leading-none font-medium tabular-nums">
              {today.done}
              <span className="text-secondary ml-1.5 text-xs font-normal">/ {today.total} 词</span>
            </p>
            <div className="bg-sunken mt-3.5 h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-brand-600 h-full rounded-full"
                style={{ width: `${progressRatio(today.done, today.total) * 100}%` }}
              />
            </div>
          </>
        ) : (
          <p className="text-tertiary mt-3 text-xs leading-relaxed">
            今天还没排任务 —— 回到首页就会排好。
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            onClose();
            // 有今天的单子就一步落到学习页；没有（还没排过）才回首页 ——
            // 少一次点击的意义在手机上比看上去大
            router.push(today?.sessionId ? `/study/${today.sessionId}` : "/");
          }}
          className="bg-brand-600 text-on-brand focus-visible:ring-brand-600 focus-visible:ring-offset-surface mt-4 w-full rounded-md px-4 py-2.5 text-sm font-medium transition-opacity duration-160 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {today?.sessionId ? "继续今天的学习" : "去排今天的任务"}
        </button>
      </section>

      {/* ③ 动态 */}
      <section className="border-subtle border-t px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-tertiary text-[11px] tracking-[0.08em]">动态</p>
          <p className="text-tertiary text-[11px] tabular-nums">{notices.length} 条</p>
        </div>

        {notices.length === 0 ? (
          <p className="text-tertiary mt-2.5 text-xs">还没有动态。</p>
        ) : (
          <ul className="mt-3 max-h-44 space-y-3 overflow-y-auto pr-0.5">
            {notices.map((n) => (
              <li key={n.id} className="flex gap-2.5">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[n.level]}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-primary text-xs leading-snug">
                    <span className="text-tertiary mr-2 tabular-nums">{formatClock(n.at)}</span>
                    {n.title}
                  </p>
                  {n.detail && (
                    <p className="text-tertiary mt-1 text-[11px] leading-relaxed break-words">
                      {n.detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        ④ 开发者区。长按球 0.6 秒才会出现。
        这里的东西对用户没有意义，只在我排查问题时有用 —— 所以默认整块不存在。
      */}
      {dev && (
        <section className="border-subtle border-t px-4 py-3.5">
          <p className="text-tertiary text-[11px] tracking-[0.08em]">运行状态（开发者）</p>
          <dl className="mt-2.5 space-y-1.5">
            <Fact
              label="本地词库"
              value={runtime ? `${runtime.words} 词 · ${runtime.placements} 条归属` : "读取中…"}
            />
            <Fact
              label="数据"
              value={`置信度 ${CONFIDENCE_PCT}% · ${seedBundle.meta.is_verified ? "已人工核对" : "未经人工核对"}`}
            />
            <Fact
              label="网络"
              value={!runtime ? "检测中…" : runtime.online ? "在线" : "离线（本地数据照常可用）"}
            />
            <Fact
              label="渲染"
              value={!runtime ? "检测中…" : runtime.motionReduced ? "已降级 · 只留淡入" : "完整动效"}
            />
            {/*
              下面两行是 AI 记账的仪表盘。硬约束要求"每次调用必须记账"，
              但记了不看等于没记 —— 尤其是**缓存命中率**：
              它是"提示词把固定部分放在前面"这套省钱设计有没有生效的唯一证据。
              命中率掉到 0 通常意味着有人往稳定前缀里塞了会变的东西（日期 / 昵称），
              那是个要立刻修的问题，而它在界面上本来是看不见的。
            */}
            <Fact
              label="AI 调用"
              value={
                !usage
                  ? "读取中…"
                  : usage.has_data
                    ? `今天 ${usage.calls} 次${usage.failed > 0 ? `（失败 ${usage.failed}）` : ""}`
                    : "今天还没调过"
              }
            />
            <Fact
              label="记账"
              value={
                !usage || !usage.has_data
                  ? "—"
                  : `${formatCny(usage.cost_cny)} · 缓存命中 ${formatCacheHitRate(usage.cache_hit_rate)}`
              }
            />
            {usage && usage.has_data && (
              <Fact
                label="tokens"
                value={`入 ${usage.input_tokens} / 出 ${usage.output_tokens} / 命中 ${usage.cached_tokens}`}
              />
            )}
          </dl>

          {/* 价格表里查不到的模型不会静默变成"免费"——这句话就是防它悄悄发生的 */}
          {usage && usage.unpriced_model_calls > 0 && (
            <p className="text-tertiary mt-2 text-[11px] leading-relaxed">
              有 {usage.unpriced_model_calls} 次调用的模型不在价格表里，那几笔**没计价**（不是免费的）。
            </p>
          )}

          <div className="border-subtle mt-3 flex items-center justify-between gap-3 border-t pt-2.5">
            <button
              type="button"
              onClick={clear}
              disabled={notices.length === 0}
              className="text-secondary hover:text-primary focus-visible:ring-brand-600 disabled:text-tertiary rounded-sm px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed"
            >
              清空动态
            </button>
            <button
              type="button"
              onClick={() => void copyAll()}
              disabled={notices.length === 0}
              className="text-secondary hover:text-primary focus-visible:ring-brand-600 disabled:text-tertiary rounded-sm px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed"
            >
              {copied ? "已复制" : "复制全部"}
            </button>
          </div>
        </section>
      )}

      {/* ⑤ 页脚 */}
      <footer className="border-subtle flex items-center justify-between gap-3 border-t px-4 py-2.5">
        <button
          type="button"
          onClick={onHide}
          className="text-secondary hover:text-primary focus-visible:ring-brand-600 rounded-sm px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          收起小词
        </button>
        {dev && <span className="text-tertiary text-[11px]">长按球可退出开发者模式</span>}
      </footer>
    </div>
  );
}

/** 状态行：标签占固定窄列，值占余下整列。值不截断，坏了也看得见 */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-[11px]">
      <dt className="text-tertiary w-14 shrink-0">{label}</dt>
      <dd className="text-secondary min-w-0 flex-1 tabular-nums">{value}</dd>
    </div>
  );
}
