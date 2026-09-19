"use client";

/**
 * `/` —— 首页 / 今日任务单（方案 §7.4）
 *
 * 阶段 0 的两条硬要求：
 *   1. **首屏不等网络** —— 数据全在本地 IndexedDB，天然满足（阶段 2 的验收项）。
 *   2. **断网可用** —— 同上。
 *
 * 「开始学习」现在真的能开始了 —— 跳到 `/study/<今天的日期>`。
 * 之前的占位按钮是**故意禁用**的（放一个点了没反应的按钮比不放更伤信任），
 * B3 把学习页做出来之后才把它接上。
 *
 * 这一页**不再自己装配任务单**：装配收在 `assembleTodayPlan` 一处，
 * 首页 / 结果页 / 学习页跑的是同一条流水线，所以三个地方说的数字永远一样。
 *
 * ── 排版约定（B2 收尾时统一过一次，改动请沿用）────────────────────────
 *   页面主角是「今天多少词」，其余都往后站，靠三样东西分层：
 *     ① 字号：主数字 44px ＞ 正文 14px ＞ 辅助 12px ＞ 标签 11px
 *     ② 颜色：primary（正文）＞ secondary（辅助）＞ tertiary（最安静）
 *     ③ 留白：卡与卡之间 12px，卡内 20~24px；主卡额外靠"底衬色"跳出白卡堆
 *   底衬**只能用暖色**（`bg-feature`）：整页是暖白调，用冷色的主色浅版
 *   （brand-50）会发青、跟页面打架 —— 这条踩过一次，别再改回去。
 *   两处刻意不加的东西：卡片投影（柔感风格靠描边和留白，不靠阴影）、
 *   卡片内分隔线以外的任何装饰线。
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { pushNotice, setTodayProgress } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { getProfile, isOnboarded } from "@/lib/db/repo";
import { DATA_HONEST_NOTE, ensureSeeded } from "@/lib/db/seed";
import { deriveWeakWordIds, saveDailyPlan, todayKey } from "@/lib/db/studyRepo";
import { findGoal, interestLabel, isGoalSupported } from "@/lib/onboarding/questions";
import { countDoneInPlan } from "@/lib/plan/todayProgress";
import { assembleTodayPlan } from "@/lib/plan/todayPlan";

interface HomeData {
  perDay: number;
  perDayMinutes: number;
  /** 今天已经练过多少个不同的词。B3 有学习页之前它恒为 0，但通路是通的 */
  doneToday: number;
  brief: string;
  summary: string;
  unitLabel: string;
  totalInUnit: number;
  firstWords: { word_id: string; lemma: string; meaning_zh: string | null }[];
  goalLabel: string;
  goalSupported: boolean;
  dailyMinutes: number;
  interests: string[];
  level: number | null;
  /**
   * 今天这一单的 id —— 就是**本地日期**（`2026-09-19`）。
   * "开始学习"直接跳到 `/study/<它>`，学习页再用同一天的任务单把自己装满。
   * 用日期当 id 的好处：刷新、重进、明天再来，都不会出现"两份今天的单子"。
   */
  sessionId: string;
  /** "9月19日 · 周六"。只在客户端算 —— 服务端与客户端可能跨时区差一天。 */
  todayLabel: string;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: HomeData };

export default function HomePage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const profile = await getProfile();
        if (cancelled) return;

        // 没走完引导就回引导页 —— 判断口径只有 isOnboarded 一处，不在这里另写一套
        if (!profile || !isOnboarded(profile)) {
          router.replace("/onboarding");
          return;
        }

        await ensureSeeded(db);
        const [units, words, senses, placements, goalProfiles, reviewLogs] = await Promise.all([
          db.units.toArray(),
          db.words.toArray(),
          db.senses.toArray(),
          db.word_placements.toArray(),
          db.goal_profiles.toArray(),
          db.review_logs.toArray(),
        ]);
        const snapshot = { units, words, senses, placements };

        const goalProfile = goalProfiles.find((p) => p.goal_code === "zhongkao");
        if (!goalProfile) throw new Error("本地库缺少 goal_profiles（中考）配置");

        // 错词本：从 review_logs 派生 —— "最后一次没答对"的词，最近的排前面。
        // 这是阶段 0 里"复习"这件事的**全部**实现（真正的间隔调度归阶段 2 的 FSRS）。
        const weakWordIds = await deriveWeakWordIds();

        // 装配口径收在 assembleTodayPlan 一处：首页 / 结果页 / 学习页跑的是同一条流水线，
        // 所以"每天几个词"这三个地方永远说得一样。
        const assembled = assembleTodayPlan({
          snapshot,
          goalProfile,
          dailyMinutes: profile.daily_minutes,
          weakWordIds,
        });
        if (!assembled.ok) throw new Error(`[${assembled.code}] ${assembled.message}`);

        const plan = assembled.plan;
        const goalOption = findGoal(profile.goal);
        const now = new Date();
        const sessionId = todayKey(now);
        const planWordIds = plan.items.map((i) => i.word_id);

        // 把今天这一单存下来：学习页读的就是它 —— "首页说的"与"学习页练的"必须是同一份。
        // 幂等覆盖（同一天重复进入不会存出两份），且**保留已有 status**
        // （否则学了一半退出来再进首页，进度会被抹平）。
        await saveDailyPlan({
          planDate: sessionId,
          items: plan.items,
          brief: plan.brief,
          estimatedMinutes: plan.estimated_minutes,
          now,
        });

        // 今日已完成：今天练过的词 ∩ 今天任务单。口径与学习页、小词环共用
        // （lib/plan/todayProgress），所以不会出现"两个地方说的数字不一样"。
        const doneToday = countDoneInPlan(reviewLogs, planWordIds, now);

        if (cancelled) return;
        // 排好了就往小词报一声 —— 用户不会盯着加载过程，但翻小词时能看见
        pushNotice({
          key: "daily-plan",
          level: "info",
          title: "今日任务单已排好",
          detail:
            `${plan.items.length} 个词 · 约 ${plan.estimated_minutes} 分钟 · 起点 ${assembled.scopeLabel}` +
            // 错词有没有参与排计划是用户看得见的差异（"今天怎么有几个眼熟的词"）——
            // 说一句比不说好，不说他会以为这几个词是随机冒出来的
            (plan.breakdown.weak > 0 ? ` · 其中 ${plan.breakdown.weak} 个是之前错过的` : ""),
        });
        // 小词外圈那道进度环读的就是这个数。由首页写入而不是小词自己去算 ——
        // 排计划要跑一整套 resolveScope，为了一个环再跑一遍纯属浪费。
        setTodayProgress(doneToday, plan.items.length, sessionId);
        setState({
          status: "ready",
          data: {
            perDay: plan.items.length,
            perDayMinutes: plan.estimated_minutes,
            doneToday,
            brief: plan.brief,
            summary: goalProfile.user_facing_summary,
            unitLabel: assembled.scopeLabel,
            totalInUnit: assembled.wordsInScope,
            firstWords: plan.items.slice(0, 5).map((i) => ({
              word_id: i.word_id,
              lemma: i.lemma,
              meaning_zh: i.meaning_zh,
            })),
            goalLabel: goalOption?.label ?? profile.goal,
            goalSupported: isGoalSupported(profile.goal),
            dailyMinutes: profile.daily_minutes,
            interests: profile.interests,
            level: profile.level_self_report,
            sessionId,
            todayLabel: `${now.getMonth() + 1}月${now.getDate()}日 · 周${"日一二三四五六"[now.getDay()]}`,
          },
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        pushNotice({
          key: "daily-plan",
          level: "danger",
          title: "没能排今天的任务",
          detail: message,
        });
        setState({ status: "error", message });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    // pb-20 而不是 pb-12：左下角常驻着小词（44px 高 + 20px 边距），
    // 底部留白不够的话，滚到最后一行时球会压住文字。
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
      <header className="mb-7 flex items-start justify-between gap-4">
        <h1 className="text-primary text-lg leading-none font-medium">词径记</h1>
        <button
          type="button"
          onClick={() => router.push("/onboarding")}
          className="text-tertiary -mt-1 -mr-2 shrink-0 px-2 py-1 text-xs underline-offset-4 hover:underline"
        >
          改我的情况
        </button>
      </header>

      {state.status === "loading" && (
        <p className="text-secondary py-16 text-center text-sm">正在装载本地词库…</p>
      )}

      {state.status === "error" && (
        <div className="border-danger-600/30 bg-danger-50 rounded-lg border p-4">
          <p className="text-primary text-sm font-medium">没能排今天的任务</p>
          <p className="text-secondary mt-1 text-xs break-words">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <div data-animated className="flex flex-col gap-3">
          {/* ① 主卡：今天的量。整页的视觉重心 —— 暖砂底衬把它从白卡堆里抬出来 */}
          <section className="bg-feature rounded-lg px-6 pt-6 pb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-secondary text-[11px] tracking-[0.08em]">
                  今天 · {state.data.todayLabel}
                </p>
                <p className="text-brand-800 mt-3 flex items-baseline text-[2.75rem] leading-none font-medium tabular-nums">
                  {state.data.perDay}
                  <span className="text-secondary ml-2 text-sm font-normal">个词</span>
                </p>
                <p className="text-secondary mt-3 text-xs">约 {state.data.perDayMinutes} 分钟</p>
              </div>
              <ProgressRing value={state.data.doneToday} total={state.data.perDay} />
            </div>

            <p className="text-secondary border-strong mt-5 border-t pt-4 text-xs leading-relaxed">
              {state.data.brief}
            </p>

            <button
              type="button"
              onClick={() => router.push(`/study/${state.data.sessionId}`)}
              className="bg-brand-600 text-on-brand ease-soft mt-4 w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity duration-200 active:scale-[0.99]"
            >
              {state.data.doneToday > 0 ? "继续今天的学习" : "开始今天的学习"}
            </button>
            <p className="text-tertiary mt-2 text-[11px] leading-relaxed">
              {state.data.doneToday > 0
                ? `今天已经练过 ${state.data.doneToday} 个 —— 接着上次的地方往下走。`
                : "点开就是第一个词。中途退出没关系，再进来会接着上次。"}
            </p>
          </section>

          {/* ② 今天的前几个词 */}
          <section className="border-subtle bg-surface rounded-lg border p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-tertiary text-[11px] tracking-[0.08em]">今天从这些开始</p>
              <p className="text-tertiary shrink-0 text-[11px] tabular-nums">
                {state.data.unitLabel} · 共 {state.data.totalInUnit} 词
              </p>
            </div>
            <ul className="divide-subtle mt-3 divide-y">
              {state.data.firstWords.map((w) => (
                <li
                  key={w.word_id}
                  className="grid grid-cols-[minmax(0,7rem)_1fr] items-baseline gap-x-4 py-3"
                >
                  <span className="text-primary truncate text-sm">{w.lemma}</span>
                  <span className="text-secondary text-xs leading-relaxed">{w.meaning_zh}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ③ 方案摘要：先给一句人话，再列具体参数 */}
          <section className="border-subtle bg-surface rounded-lg border p-5">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">会怎么练</p>
            <p className="text-primary mt-3 text-sm leading-relaxed">{state.data.summary}</p>
            <dl className="border-subtle mt-4 space-y-2 border-t pt-4">
              <Row label="目标" value={state.data.goalLabel} />
              <Row label="每天" value={`${state.data.dailyMinutes} 分钟`} />
              <Row
                label="兴趣"
                value={
                  state.data.interests.length > 0
                    ? state.data.interests.map(interestLabel).join("、")
                    : "还没选"
                }
              />
              <Row label="起点" value={state.data.level ? `第 ${state.data.level} 档` : "未测"} />
            </dl>
          </section>

          {/* ④⑤ 两段说明：位置不动，但把"音量"调小 —— 不加底色、不加整圈描边，
              只靠左侧一条细线标记，字号降一级、颜色降到最安静的一档。
              内容一字未删（"数据不完美要如实说"是硬约束）。 */}
          {!state.data.goalSupported && (
            <QuietNote title="关于你选的目标">
              你选了「{state.data.goalLabel}」，我们还没收录这套方案 —— 现在按中考的方案给你安排。
              等你要用的时候，我们再把它补上。
            </QuietNote>
          )}

          <QuietNote title="数据说明（必须让你知道）">
            {DATA_HONEST_NOTE}
            <br />
            复习间隔还没接（科学复习调度排在阶段 2），现在只按确定性顺序排 ——
            顺序是稳的、每天不会跳，但不是「最科学」的那种。
          </QuietNote>
        </div>
      )}
    </main>
  );
}

/**
 * 定义列表的一行：标签占固定窄列、值占余下整列。
 * 值不截断 —— 截断会把"兴趣"这种可长可短的内容切掉尾巴。
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-xs">
      <dt className="text-tertiary w-12 shrink-0">{label}</dt>
      <dd className="text-secondary min-w-0 flex-1">{value}</dd>
    </div>
  );
}

/** 安静说明块：左侧一条细线 + 小标题，不要再抢白卡的主线注意力 */
function QuietNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-warning-600/40 border-l-2 py-0.5 pl-4">
      <p className="text-tertiary text-[11px] tracking-[0.08em]">{title}</p>
      <p className="text-tertiary mt-2 text-xs leading-relaxed">{children}</p>
    </section>
  );
}

/**
 * 进度环。用 token 变量而不是写死的十六进制 —— 换色板时它跟着变。
 * `-rotate-90` 让起点落在 12 点方向（SVG 的 0° 在 3 点方向）。
 * 底环用 surface 白：它坐在淡主色底的卡片上，白底环比灰环更像"跑道"。
 */
function ProgressRing({ value, total }: { value: number; total: number }) {
  const ratio = total > 0 ? Math.min(Math.max(value / total, 0), 1) : 0;
  const R = 30;
  const circumference = 2 * Math.PI * R;

  return (
    <div
      className="relative shrink-0"
      role="img"
      aria-label={`今日进度：${value} / ${total}`}
    >
      <svg viewBox="0 0 72 72" className="h-16 w-16 -rotate-90">
        <circle cx="36" cy="36" r={R} fill="none" stroke="var(--color-surface)" strokeWidth="5" />
        <circle
          cx="36"
          cy="36"
          r={R}
          fill="none"
          stroke="var(--color-brand-600)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="text-secondary absolute inset-0 flex items-center justify-center text-[11px] tabular-nums">
        {value}/{total}
      </span>
    </div>
  );
}
