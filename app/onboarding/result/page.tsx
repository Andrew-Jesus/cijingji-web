"use client";

/**
 * /onboarding/result —— 最关键的情绪时刻（方案 §7.3）
 *
 * 一屏给完四样东西：计划摘要 / 方法摘要 / 具体差异 / 诚实标注 + 反馈入口。
 *
 * 这一页的设计原则只有一条：**说得出"为你改了什么"，而且每一条都能追到出处**。
 * 所以每个数字都不是文案，是算出来的：
 *   - 每天几个词 → dailyCapFor（与首页同一个函数，两处永远一致）
 *   - 还剩多久 → deadline.daysUntil（大概值，不说精确天数）
 *   - 起点档位 → 自测判分（结果页用同一个种子重建卷子再算一遍）
 * 有出处的数字才经得起用户追问。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { pushNotice } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { getProfile } from "@/lib/db/repo";
import { DATA_HONEST_NOTE, ensureSeeded } from "@/lib/db/seed";
import { readAttempt } from "@/lib/onboarding/attempt";
import {
  UNSUPPORTED_GOAL_NOTE,
  findGoal,
  interestLabel,
  isGoalSupported,
} from "@/lib/onboarding/questions";
import { QUIZ_SEED, buildQuiz, levelLabel, scoreQuiz, type UnitBreakdown } from "@/lib/onboarding/quiz";
import { daysToCover, daysUntil, describeRemaining } from "@/lib/onboarding/deadline";
import { assembleTodayPlan } from "@/lib/plan/todayPlan";

interface ResultData {
  goalLabel: string;
  goalSupported: boolean;
  remainingText: string;
  dailyMinutes: number;
  interests: string[];
  /** null = 这次没做自测（走了降级路径） */
  quiz: { correct: number; total: number; level: number; label: string; note: string; byUnit: UnitBreakdown[] } | null;
  fallbackLevelLabel: string;
  summary: string;
  spellingRequired: boolean;
  perDay: number;
  perDayMinutes: number;
  unitLabel: string;
  totalInUnit: number;
  daysToCover: number;
  usedDailyMinutes: boolean;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ResultData };

export default function ResultPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  // 反馈入口：阶段 0 没有后端，用"复制一段给开发者"的真实可用做法，
  // 而不是做一个点了没反应的假按钮（假按钮比没有按钮更伤信任）。
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const profile = await getProfile();
        if (cancelled) return;
        if (!profile) {
          router.replace("/onboarding");
          return;
        }

        await ensureSeeded(db);
        const [units, words, senses, placements, goalProfiles] = await Promise.all([
          db.units.toArray(),
          db.words.toArray(),
          db.senses.toArray(),
          db.word_placements.toArray(),
          db.goal_profiles.toArray(),
        ]);
        const snapshot = { units, words, senses, placements };

        // ---- 策略包（阶段 0 固定读中考那一行）----
        const goalProfile = goalProfiles.find((p) => p.goal_code === "zhongkao");
        if (!goalProfile) throw new Error("本地库缺少 goal_profiles（中考）配置");

        // ---- 计划：从八上 Unit 1 起，按用户答的分钟数定每日词量 ----
        // 装配口径与首页、学习页共用同一个函数（assembleTodayPlan）——
        // 这一页说"每天 20 个词"，首页显示的就一定是 20 个。
        // 引导阶段还没有作答记录，所以错词表是空的（如实：第一次来，没有错词）。
        const assembled = assembleTodayPlan({
          snapshot,
          goalProfile,
          dailyMinutes: profile.daily_minutes,
          weakWordIds: [],
        });
        if (!assembled.ok) throw new Error(`[${assembled.code}] ${assembled.message}`);
        const plan = assembled.plan;

        // ---- 自测结果：用同一个种子重建卷子，再判一次分 ----
        let quiz: ResultData["quiz"] = null;
        const attempt = readAttempt();
        if (attempt) {
          const questions = buildQuiz({ snapshot, seed: attempt.seed || QUIZ_SEED });
          if (questions.length > 0) {
            const scored = scoreQuiz(questions, attempt.answers);
            quiz = {
              correct: scored.correct,
              total: scored.total,
              level: scored.level,
              label: scored.label,
              note: scored.note,
              byUnit: scored.by_unit,
            };
          }
        }

        const goalOption = findGoal(profile.goal);
        const days = profile.goal_deadline ? daysUntil(profile.goal_deadline, new Date()) : NaN;

        if (cancelled) return;
        pushNotice({
          key: "goal-plan",
          level: "success",
          title: "你的方案已生成",
          detail: `${goalOption?.label ?? profile.goal} · 每天 ${profile.daily_minutes} 分钟 → ${plan.items.length} 个词`,
        });
        setState({
          status: "ready",
          data: {
            goalLabel: goalOption?.label ?? profile.goal,
            goalSupported: isGoalSupported(profile.goal),
            remainingText: describeRemaining(days),
            dailyMinutes: profile.daily_minutes,
            interests: profile.interests,
            quiz,
            fallbackLevelLabel: levelLabel(profile.level_self_report ?? 2),
            summary: goalProfile.user_facing_summary,
            spellingRequired: assembled.merged.pace.spelling_required,
            perDay: plan.items.length,
            perDayMinutes: plan.estimated_minutes,
            unitLabel: assembled.scopeLabel,
            totalInUnit: assembled.wordsInScope,
            daysToCover: daysToCover(assembled.wordsInScope, plan.items.length),
            usedDailyMinutes: profile.daily_minutes > 0,
          },
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        pushNotice({ key: "goal-plan", level: "danger", title: "方案没生成出来", detail: message });
        setState({ status: "error", message });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function copyFeedback() {
    if (state.status !== "ready") return;
    const d = state.data;
    const report = [
      "【词径记 · 阶段 0 反馈】",
      `时间：${new Date().toLocaleString("zh-CN")}`,
      `目标：${d.goalLabel}${d.remainingText ? `（${d.remainingText}）` : ""}`,
      `每天：${d.dailyMinutes} 分钟 → ${d.perDay} 个词`,
      `兴趣：${d.interests.length ? d.interests.map(interestLabel).join("、") : "（没选）"}`,
      `自测：${d.quiz ? `${d.quiz.correct} / ${d.quiz.total} → ${d.quiz.label}` : "未做"}`,
      "",
      "我发现的问题：",
      feedbackText.trim() || "（在这里写）",
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      setCopied("ok");
    } catch {
      // 剪贴板 API 在非 HTTPS / 老浏览器下会失败 —— 退回到"选中让人自己复制"
      setCopied("fail");
      setFeedbackText(report + "\n\n" + feedbackText);
    }
  }

  if (state.status === "loading") {
    return <p className="text-secondary text-sm">正在把你的方案整理出来…</p>;
  }

  if (state.status === "error") {
    return (
      <div className="border-danger-600/30 bg-danger-50 rounded-md border p-4">
        <p className="text-primary text-sm font-medium">没能生成方案</p>
        <p className="text-secondary mt-1.5 text-xs break-words">{state.message}</p>
      </div>
    );
  }

  const d = state.data;
  const levelLabelText = d.quiz?.label ?? d.fallbackLevelLabel;

  return (
    <div data-animated className="space-y-4">
      <header>
        <h1 className="text-primary text-xl leading-snug font-medium">给你排好了</h1>
        <p className="text-secondary mt-1.5 text-sm leading-relaxed">
          下面每一条都是按你刚才答的来的。
        </p>
      </header>

      {/* ① 计划摘要 */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-secondary text-xs">你的安排</p>
        <p className="text-primary mt-2.5 text-sm leading-relaxed">
          {d.goalLabel}
          {d.remainingText ? ` · ${d.remainingText}` : ""} · 每天 {d.dailyMinutes} 分钟
        </p>
        <p className="text-primary mt-1.5 text-sm leading-relaxed">
          从 <span className="font-medium">{d.unitLabel}</span> 开始，共 {d.totalInUnit} 词，
          {d.daysToCover > 0 ? `预计 ${d.daysToCover} 天过一遍。` : "。"}
        </p>
        <p className="text-secondary mt-3 text-xs leading-relaxed">
          今天 {d.perDay} 个词，约 {d.perDayMinutes} 分钟 —— 正好是你给的时间。
        </p>
      </section>

      {/* ② 自测结果（有就说，没有也如实说） */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-secondary text-xs">自测</p>
        {d.quiz ? (
          <>
            <p className="text-primary mt-2.5 text-sm">
              答对 {d.quiz.correct} / {d.quiz.total} · 起点定在{" "}
              <span className="font-medium">{d.quiz.label}</span>
            </p>
            <p className="text-secondary mt-2 text-xs leading-relaxed">{d.quiz.note}</p>
            {d.quiz.byUnit.length > 0 && (
              <ul className="text-tertiary mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {d.quiz.byUnit.map((u) => (
                  <li key={u.unit_code} className="tabular-nums">
                    {u.unit_code} {u.correct}/{u.total}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-primary mt-2.5 text-sm leading-relaxed">
            这次没做自测，起点先按 <span className="font-medium">{levelLabelText}</span> 来 ——
            做几张卡片之后我们会自己调。
          </p>
        )}
      </section>

      {/* ③ 方法摘要（手写文案，不由 AI 生成） */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-secondary text-xs">会怎么练</p>
        <p className="text-primary mt-2.5 text-sm leading-relaxed">{d.summary}</p>
      </section>

      {/* ④ 具体差异：说得出"为你改了什么" */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-secondary text-xs">按你的情况，这几件事跟默认不一样</p>
        <ul className="mt-3 space-y-2.5">
          <Diff
            title={d.spellingRequired ? "要动手拼写，不只是认得" : "先只练认得，不要求拼写"}
            why={d.spellingRequired ? "中考要写，所以提前练" : "先把认词这一步走稳"}
          />
          <Diff
            title={`每天 ${d.perDay} 个词`}
            why={`你给了 ${d.dailyMinutes} 分钟，按这个量刚好排满，不用硬撑`}
          />
          <Diff
            title={
              d.interests.length > 0
                ? `例句会写进你喜欢的：${d.interests.map(interestLabel).join("、")}`
                : "例句暂时用通用话题"
            }
            why={
              d.interests.length > 0
                ? "同一个词放进你熟悉的事里，才记得住"
                : "你在引导里没选兴趣，随时可以补上"
            }
          />
          <Diff
            title={`起点定在「${levelLabelText}」`}
            why={d.quiz ? `自测答对 ${d.quiz.correct} / ${d.quiz.total}` : "这次没自测，取中间档"}
          />
        </ul>
      </section>

      {/* ⑤ 诚实标注 */}
      <section className="border-warning-600/30 bg-warning-50 rounded-lg border p-4">
        <p className="text-primary text-xs font-medium">必须让你知道的两件事</p>
        <p className="text-secondary mt-2 text-xs leading-relaxed">{DATA_HONEST_NOTE}</p>
        <p className="text-secondary mt-2 text-xs leading-relaxed">
          另外：20 个词只能看出个大概，这个档位是用来定起点的，<span className="font-medium">不是给你打分</span>。
          觉得定低了或高了，跟我说，我们调。
        </p>
        {!d.goalSupported && (
          <p className="text-secondary mt-2 text-xs leading-relaxed">{UNSUPPORTED_GOAL_NOTE}</p>
        )}
      </section>

      {/* ⑥ 反馈入口 */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <button
          type="button"
          onClick={() => setFeedbackOpen((v) => !v)}
          className="text-secondary text-xs underline underline-offset-4"
        >
          {feedbackOpen ? "收起" : "这地方不对 / 我有话说"}
        </button>

        {feedbackOpen && (
          <div className="mt-3 space-y-3" data-animated>
            <textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              rows={3}
              placeholder="哪里不像你的情况？直接写。"
              className="border-subtle bg-page text-primary placeholder:text-tertiary w-full resize-none rounded-md border p-3 text-xs leading-relaxed outline-none focus:border-brand-600"
            />
            <button
              type="button"
              onClick={copyFeedback}
              className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-2.5 text-xs transition-opacity duration-200 active:scale-[0.99]"
            >
              {copied === "ok" ? "已复制，发给我就行" : "复制这段反馈"}
            </button>
            <p className="text-tertiary text-xs leading-relaxed">
              {copied === "fail"
                ? "浏览器不让自动复制 —— 上面的文字已经填进输入框，长按选中复制即可。"
                : "阶段 0 还没有站内反馈表，先这样把情况带给我。"}
            </p>
          </div>
        )}
      </section>

      {/* CTA */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3.5 text-sm transition-opacity duration-200 active:scale-[0.99]"
      >
        去看今天的任务单
      </button>
    </div>
  );
}

/** 「为你改了什么 + 为什么」—— 两行都要有，只说结论不算"量身定制" */
function Diff({ title, why }: { title: string; why: string }) {
  return (
    <li>
      <p className="text-primary text-sm leading-snug">{title}</p>
      <p className="text-tertiary mt-1 text-xs leading-snug">{why}</p>
    </li>
  );
}
