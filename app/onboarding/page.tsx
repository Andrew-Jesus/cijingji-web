"use client";

/**
 * /onboarding —— 冷启动问答（方案 §7.1）
 *
 * 三个问题，一屏一题：
 *   ① 准备什么考试 + 期限　② 每天能投入多久　③ 兴趣领域（多选）
 *
 * 两条刻意的设计：
 *   - **单选卡片点击即进，不放"下一步"按钮** —— 少一次点击，少一个决策点。
 *     只有多选的第 3 题需要按钮（它没法"选完就走"）。
 *   - **选了中考以外的目标，如实说"暂未收录"**，并且**不问期限**
 *     （期限选项是按中考 6 月生成的，对高考是错的数）——
 *     宁可少收集一个字段，也不拿一个错的默认值糊弄过去。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { OptionCard } from "@/components/onboarding/OptionCard";
import { StepProgress } from "@/components/onboarding/StepProgress";
import { getProfile, saveProfile } from "@/lib/db/repo";
import { deadlineOptions, type DeadlineOption } from "@/lib/onboarding/deadline";
import {
  GOAL_OPTIONS,
  INTEREST_OPTIONS,
  MAX_INTERESTS,
  MINUTE_OPTIONS,
  UNSUPPORTED_GOAL_NOTE,
  isGoalSupported,
  type GoalOption,
} from "@/lib/onboarding/questions";

const TOTAL_STEPS = 3;

export default function OnboardingPage() {
  const router = useRouter();

  const [step, setStep] = useState(1);

  const [goal, setGoal] = useState<string | null>(null);
  const [goalPicked, setGoalPicked] = useState(false);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [interests, setInterests] = useState<string[]>([]);

  const [deadlines, setDeadlines] = useState<DeadlineOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 期限选项依赖「今天」，所以只能在客户端算（服务端预渲染与客户端可能差一天，
   * 在渲染期读时钟会造成水合不一致）。
   *
   * 但它**不放在 effect 里** —— 那样等于「渲染完再同步触发一轮渲染」，
   * 是 React 明确不建议的写法（会多一次级联渲染）。改成在两个真正需要它的时机算：
   *   ① 用户点掉「考试目标」时（pickGoal，事件处理里）
   *   ② 从本地库恢复上次选择、且目标受支持时（下面那个 effect 的回调里）
   * 两处都在事件/Promise 回调中，天然避开了级联渲染。
   */
  function ensureDeadlines(goalCode: string | null) {
    if (isGoalSupported(goalCode)) setDeadlines(deadlineOptions(new Date()));
  }

  // 回到本页时把上次的选择带出来（改主意时不用从头想）
  useEffect(() => {
    let cancelled = false;
    void getProfile().then((p) => {
      if (cancelled || !p) return;
      setGoal(p.goal);
      setDeadline(p.goal_deadline);
      setMinutes(p.daily_minutes);
      setInterests(p.interests);
      // 能取到 profile 就说明上次已经选过目标，把「已选中」和期限选项一起还原 ——
      // 否则刷新页面会看到卡片亮着、却怎么也等不出期限那一栏。
      // （getProfile 无记录时返回 null，上面已经提前 return，所以走到这里必有 goal。）
      setGoalPicked(true);
      ensureDeadlines(p.goal);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 统一包一层：任何写入失败都要让用户看见，而不是静默卡住 */
  async function advance(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const goalSupported = isGoalSupported(goal);

  function pickGoal(option: GoalOption) {
    setGoal(option.code);
    setGoalPicked(true);
    ensureDeadlines(option.code);
  }

  function pickDeadline(value: string | null) {
    setDeadline(value);
    void advance(async () => {
      await saveProfile({ goal, goal_deadline: value });
      setStep(2);
    });
  }

  function skipDeadlineForUnsupportedGoal() {
    void advance(async () => {
      // 不支持的目标：不打期限。留 null 比留一个错的日期诚实。
      await saveProfile({ goal, goal_deadline: null });
      setStep(2);
    });
  }

  function pickMinutes(value: number) {
    setMinutes(value);
    void advance(async () => {
      await saveProfile({ goal, goal_deadline: deadline, daily_minutes: value });
      setStep(3);
    });
  }

  function toggleInterest(tag: string) {
    setInterests((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_INTERESTS) return prev; // 到上限就不再添加，不静默顶掉别人
      return [...prev, tag];
    });
  }

  function finishInterests() {
    void advance(async () => {
      await saveProfile({
        goal,
        goal_deadline: deadline,
        daily_minutes: minutes ?? undefined,
        interests,
      });
      router.push("/onboarding/test");
    });
  }

  return (
    <div className="flex h-full flex-col">
      <StepProgress current={step} total={TOTAL_STEPS} label={`第 ${step} / ${TOTAL_STEPS} 步`} />

      <div key={step} data-animated className="mt-8 flex-1 space-y-5">
        {step === 1 && (
          <>
            <header>
              <h1 className="text-primary text-lg leading-snug font-medium">
                你在准备什么考试？
              </h1>
              <p className="text-secondary mt-1.5 text-sm leading-relaxed">
                这决定我们按哪一套方法给你排。
              </p>
            </header>

            <div className="space-y-2.5">
              {GOAL_OPTIONS.map((option) => (
                <OptionCard
                  key={option.code}
                  label={option.label}
                  hint={option.hint}
                  selected={goal === option.code}
                  muted={!option.supported}
                  onClick={() => pickGoal(option)}
                />
              ))}
            </div>

            {/* 目标已选 + 是支持的 → 接着问期限 */}
            {goalPicked && goalSupported && (
              <div data-animated className="space-y-3 pt-2">
                <header>
                  <h2 className="text-primary text-base font-medium">考试大概在什么时候？</h2>
                  <p className="text-secondary mt-1 text-xs leading-relaxed">
                    用来估个进度 —— 具体日期每个城市都不一样，我们只按大概时间来。
                  </p>
                </header>
                <div className="space-y-2.5">
                  {deadlines.map((option) => (
                    <OptionCard
                      key={option.label}
                      label={option.label}
                      hint={option.hint}
                      selected={deadline === option.value}
                      onClick={() => pickDeadline(option.value)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 目标已选 + 不支持 → 如实说清楚，不问期限，给一条明确的路 */}
            {goalPicked && !goalSupported && (
              <div data-animated className="space-y-3 pt-2">
                <div className="border-warning-600/30 bg-warning-50 rounded-md border p-4">
                  <p className="text-primary text-xs font-medium">这个目标我们还没收录</p>
                  <p className="text-secondary mt-1.5 text-xs leading-relaxed">
                    {UNSUPPORTED_GOAL_NOTE}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={skipDeadlineForUnsupportedGoal}
                  className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3 text-sm transition-opacity duration-200 active:scale-[0.99] disabled:opacity-40"
                >
                  {busy ? "正在保存…" : "好，先按中考方案来"}
                </button>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <header>
              <h1 className="text-primary text-lg leading-snug font-medium">
                每天大概能拿出多久？
              </h1>
              <p className="text-secondary mt-1.5 text-sm leading-relaxed">
                照实选就好。选大了做不到反而打击人，我们宁可每天少一点、天天都做到。
              </p>
            </header>

            <div className="space-y-2.5">
              {MINUTE_OPTIONS.map((option) => (
                <OptionCard
                  key={option.value}
                  label={option.label}
                  hint={option.hint}
                  selected={minutes === option.value}
                  onClick={() => pickMinutes(option.value)}
                />
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <header>
              <h1 className="text-primary text-lg leading-snug font-medium">
                平时喜欢什么？
              </h1>
              <p className="text-secondary mt-1.5 text-sm leading-relaxed">
                选 1~{MAX_INTERESTS} 个。我们会用这些话题给你写例句 ——
                同一个词，写进你喜欢的事里，才记得住。
              </p>
            </header>

            <div className="space-y-2.5">
              {INTEREST_OPTIONS.map((option) => (
                <OptionCard
                  key={option.tag}
                  label={option.label}
                  selected={interests.includes(option.tag)}
                  onClick={() => toggleInterest(option.tag)}
                />
              ))}
            </div>

            <p className="text-tertiary text-xs leading-relaxed">
              {interests.length >= MAX_INTERESTS
                ? `最多选 ${MAX_INTERESTS} 个。选太多，例句反而会写得很泛 —— 一次只结合一个话题才写得像。`
                : `已选 ${interests.length} / ${MAX_INTERESTS}`}
            </p>

            <button
              type="button"
              disabled={interests.length === 0 || busy}
              onClick={finishInterests}
              className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3 text-sm transition-opacity duration-200 active:scale-[0.99] disabled:opacity-40"
            >
              {busy ? "正在保存…" : interests.length === 0 ? "至少选一个" : "好了，开始测一下"}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="border-danger-600/30 bg-danger-50 text-primary mt-4 rounded-md border p-3 text-xs leading-relaxed">
          没能保存：{error}
        </p>
      )}

      {step > 1 && (
        <button
          type="button"
          onClick={() => setStep(step - 1)}
          className="text-tertiary mt-5 self-start text-xs underline-offset-4 hover:underline"
        >
          上一步
        </button>
      )}
    </div>
  );
}
