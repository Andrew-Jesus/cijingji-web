import { describe, expect, it } from "vitest";

import type { GoalProfile, Sense, Unit, Word, WordPlacement } from "@/lib/db/types";
import bundleJson from "@/lib/db/seed-data.json";
import { buildQuiz, scoreQuiz, type QuizQuestion } from "@/lib/onboarding/quiz";
import { daysToCover } from "@/lib/onboarding/deadline";
import { MINUTE_OPTIONS } from "@/lib/onboarding/questions";
import { buildDailyPlan, chooseMode } from "@/lib/plan/buildDailyPlan";
import { dailyCapFor } from "@/lib/plan/estimate";
import { mergeProfile } from "@/lib/profile/mergeProfile";
import { LIMITS, defaultScope, validateScope } from "@/lib/scope/schema";
import { resolveScope, type WordSnapshot } from "@/lib/scope/resolveScope";

/**
 * 引导流程的数据链路集成测试
 *
 * 它**照着 `/onboarding/result` 的代码走一遍**，确认页面上那几个数字连得上。
 * 单元测试只保证每个函数自己没错，管不了"函数之间对不上"——
 * 而 `daily_minutes` 那个缺口正是这类问题：每个函数都对，拼起来才发现没人用它。
 *
 * 这里的断言是**页面文案的数学依据**，改了会直接改到用户看到的字。
 */
const bundle = bundleJson as unknown as {
  units: Unit[];
  words: Word[];
  senses: Sense[];
  word_placements: WordPlacement[];
  goal_profiles: GoalProfile[];
};

const snapshot: WordSnapshot = {
  units: bundle.units,
  words: bundle.words,
  senses: bundle.senses,
  placements: bundle.word_placements,
};

const zhongkao = bundle.goal_profiles.find((p) => p.goal_code === "zhongkao")!;

function planFor(dailyMinutes: number) {
  const merged = mergeProfile({ profile: zhongkao, phases: zhongkao.phases });
  const validated = validateScope(defaultScope());
  if (!validated.ok) throw new Error("默认范围必须合法");
  const resolved = resolveScope(validated.scope, snapshot);
  if (!resolved.ok) throw new Error("默认范围必须能解析出词");

  const dailyCap = dailyCapFor(dailyMinutes, chooseMode(merged.pace), LIMITS.daily_cap);
  const plan = buildDailyPlan({
    words: resolved.words,
    weak_word_ids: [],
    daily_cap: dailyCap,
    pace: merged.pace,
  });

  return { merged, resolved, dailyCap, plan };
}

/** 造一份"真实作答"：前 n 题答对，其余答错 */
function answersWith(questions: QuizQuestion[], correctCount: number): number[] {
  return questions.map((q, i) =>
    i < correctCount ? q.answer_index : (q.answer_index + 1) % q.options.length,
  );
}

describe("引导流程数据链路（照着 result 页的算法走）", () => {
  it("词库能出满 20 题的卷子，且每题选项合法", () => {
    const qs = buildQuiz({ snapshot });
    expect(qs).toHaveLength(20);
    expect(qs.every((q) => q.options.length === 4)).toBe(true);
    expect(qs.every((q) => q.answer_index >= 0 && q.answer_index < q.options.length)).toBe(true);
  });

  it("★ 闭环自洽：用户答的分钟数 ≈ 排出来的词量与估算用时", () => {
    // 这是 dailyCapFor 存在的理由 —— 三条链必须首尾相接：
    //   profile.daily_minutes → dailyCapFor → daily_cap → buildDailyPlan → estimated_minutes
    // 只要有一环不接，结果页与首页就会各说各的。
    for (const minutes of [10, 15, 20]) {
      const { plan } = planFor(minutes);
      expect(plan.estimated_minutes).toBe(minutes);
      expect(plan.items).toHaveLength(dailyCapFor(minutes, "recall_spell", LIMITS.daily_cap));
    }
  });

  it("30 分钟会被每日上限截住（不把整本书塞进一天）", () => {
    const { plan, dailyCap } = planFor(30);
    expect(dailyCap).toBe(LIMITS.daily_cap); // 30min/25s = 72，被截到 50
    expect(plan.items.length).toBe(LIMITS.daily_cap);
    expect(plan.estimated_minutes).toBeLessThan(30); // 诚实：排不满就说排不满
  });

  it("每个时长档都能排出非空任务单（引导里的四个选项都不能是坏的）", () => {
    for (const option of MINUTE_OPTIONS) {
      const { plan } = planFor(option.value);
      expect(plan.items.length).toBeGreaterThan(0);
      expect(plan.estimated_minutes).toBeGreaterThan(0);
    }
  });

  it("「预计 X 天过一遍」算得出且不为 0", () => {
    const { resolved, plan } = planFor(15);
    const days = daysToCover(resolved.words.length, plan.items.length);
    expect(days).toBeGreaterThan(0);
    expect(days).toBe(Math.ceil(resolved.words.length / plan.items.length));
  });

  it("分档与页面文案一致：答对 15/20 落在「熟练」", () => {
    const qs = buildQuiz({ snapshot });
    const r = scoreQuiz(qs, answersWith(qs, 15));
    expect(r.correct).toBe(15);
    expect(r.label).toBe("熟练");
  });

  it("分档与页面文案一致：答对 5/20 落在「入门」", () => {
    const qs = buildQuiz({ snapshot });
    const r = scoreQuiz(qs, answersWith(qs, 5));
    expect(r.correct).toBe(5);
    expect(r.label).toBe("入门");
  });

  it("by_unit 的对题数之和 = 总对题数（结果页要按单元展示，不能对不上）", () => {
    const qs = buildQuiz({ snapshot });
    const r = scoreQuiz(qs, answersWith(qs, 11));
    expect(r.by_unit.reduce((s, u) => s + u.correct, 0)).toBe(r.correct);
    expect(r.by_unit.reduce((s, u) => s + u.total, 0)).toBe(r.total);
  });

  it("自测用同一个种子重算，结果完全一致（结果页依赖这条）", () => {
    const qs = buildQuiz({ snapshot });
    const answers = answersWith(qs, 13);
    const first = scoreQuiz(qs, answers);

    // 结果页没有拿到卷子对象，只有种子 + 答案 —— 重建后必须得到同样的分
    const rebuilt = buildQuiz({ snapshot });
    const second = scoreQuiz(rebuilt, answers);

    expect(second.correct).toBe(first.correct);
    expect(second.level).toBe(first.level);
    expect(second.by_unit).toEqual(first.by_unit);
  });

  it("方法摘要是手写的一句话，不为空（结果页直接展示它）", () => {
    const merged = mergeProfile({ profile: zhongkao, phases: zhongkao.phases });
    expect(zhongkao.user_facing_summary.length).toBeGreaterThan(0);
    expect(merged.pace.spelling_required).toBe(true); // 中考方案要拼写 → 结果页显示"要动手拼写"
  });
});
