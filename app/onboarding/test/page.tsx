"use client";

/**
 * /onboarding/test —— 20 词快速自测（方案 §7.2）
 *
 * 三条硬要求：
 *   1. **全程不显示对错** —— 选中态只用中性色（brand），绝不用 success/danger 色。
 *      这不是藏结果，是不想让"我刚答错了"影响后面 15 道题的判断。
 *   2. **点选即进**，不用"下一题"按钮；留 200ms 的选中反馈再切，避免手快时不知道点没点上。
 *   3. 结果**只用于算 level_self_report**（3 档：入门 / 中等 / 熟练），不是测评分数。
 *
 * 判分在提交时一次完成；作答原文存进 sessionStorage，结果页用同一个种子重建卷子再算 ——
 * 这样"抽题可复现"这条保证在真实流程里也验了一遍。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { OptionCard } from "@/components/onboarding/OptionCard";
import { StepProgress } from "@/components/onboarding/StepProgress";
import { db } from "@/lib/db/local";
import { completeOnboarding, getProfile } from "@/lib/db/repo";
import { ensureSeeded } from "@/lib/db/seed";
import { saveAttempt } from "@/lib/onboarding/attempt";
import { QUIZ_SEED, buildQuiz, scoreQuiz, type QuizQuestion } from "@/lib/onboarding/quiz";

/** 选中反馈的停留时间：够让人看见"点上了"，又不至于等得烦 */
const ADVANCE_DELAY_MS = 200;

type Phase = "loading" | "asking" | "blocked" | "error";

export default function QuizPage() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // 没走完问答就直接进来（比如手输 URL）→ 送回第一页，不产生半份 profile
        const profile = await getProfile();
        if (cancelled) return;
        if (!profile) {
          router.replace("/onboarding");
          return;
        }

        await ensureSeeded(db);
        const [units, words, senses, placements] = await Promise.all([
          db.units.toArray(),
          db.words.toArray(),
          db.senses.toArray(),
          db.word_placements.toArray(),
        ]);

        const questions = buildQuiz({
          snapshot: { units, words, senses, placements },
          seed: QUIZ_SEED,
        });
        if (cancelled) return;

        if (questions.length === 0) {
          setPhase("blocked");
          setMessage("本地词库还没准备好，这次出不了题。请跳过自测，我按中等档给你安排。");
          return;
        }

        setQuestions(questions);
        setAnswers(new Array(questions.length).fill(null));
        setPhase("asking");
      } catch (e) {
        if (cancelled) return;
        setPhase("error");
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(finalAnswers: (number | null)[], qs: QuizQuestion[]) {
    setSubmitting(true);
    try {
      const result = scoreQuiz(qs, finalAnswers);
      await completeOnboarding(result.level);
      saveAttempt({
        seed: QUIZ_SEED,
        answers: finalAnswers,
        submitted_at: new Date().toISOString(),
      });
      router.push("/onboarding/result");
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  function select(optionIndex: number) {
    if (locked || submitting) return;

    setPicked(optionIndex);
    setLocked(true);

    const next = [...answers];
    next[index] = optionIndex;
    setAnswers(next);

    timer.current = setTimeout(() => {
      const nextIndex = index + 1;
      if (nextIndex < questions.length) {
        setLocked(false);
        setIndex(nextIndex);
        setPicked(next[nextIndex] ?? null); // 回看改过的题时，把原来的选择带出来
      } else {
        void submit(next, questions);
      }
    }, ADVANCE_DELAY_MS);
  }

  function goBack() {
    if (index === 0 || submitting) return;
    if (timer.current) clearTimeout(timer.current);
    setLocked(false);
    const prev = index - 1;
    setIndex(prev);
    setPicked(answers[prev] ?? null);
  }

  /** 出不了题时的降级：不卡住流程，直接按中等档完成引导 */
  async function skipWithoutQuiz() {
    setSubmitting(true);
    try {
      await completeOnboarding(2);
      router.push("/onboarding/result");
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const question = questions[index] ?? null;

  return (
    <div className="flex h-full flex-col">
      {phase === "loading" && <p className="text-secondary text-sm">正在出题…</p>}

      {phase === "blocked" && (
        <div className="space-y-4">
          <h1 className="text-primary text-lg font-medium">这次出不了题</h1>
          <p className="text-secondary text-sm leading-relaxed">{message}</p>
          <button
            type="button"
            disabled={submitting}
            onClick={skipWithoutQuiz}
            className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3 text-sm transition-opacity duration-200 active:scale-[0.99] disabled:opacity-40"
          >
            {submitting ? "正在保存…" : "跳过自测，继续"}
          </button>
        </div>
      )}

      {phase === "error" && (
        <div className="border-danger-600/30 bg-danger-50 rounded-md border p-4">
          <p className="text-primary text-sm font-medium">自测没能继续</p>
          <p className="text-secondary mt-1.5 text-xs break-words">{message}</p>
        </div>
      )}

      {phase === "asking" && question && (
        <>
          <StepProgress
            current={index + 1}
            total={questions.length}
            label={`第 ${index + 1} / ${questions.length}`}
          />

          <div key={question.word_id} data-animated className="mt-8 flex-1 space-y-5">
            <header>
              <p className="text-tertiary text-xs">{question.unit_code}</p>
              <h1 className="text-primary mt-1 text-3xl font-medium break-words">
                {question.lemma}
              </h1>
              {question.phonetic_uk ? (
                <p className="text-tertiary mt-1.5 text-sm">{question.phonetic_uk}</p>
              ) : null}
              <p className="text-secondary mt-4 text-sm">它是什么意思？</p>
            </header>

            <div className="space-y-2.5">
              {question.options.map((option, i) => (
                <OptionCard
                  key={option}
                  label={option}
                  selected={picked === i}
                  onClick={() => select(i)}
                />
              ))}
            </div>
          </div>

          <p className="text-tertiary mt-5 text-xs leading-relaxed">
            不认识的凭感觉选就好，不用纠结 —— 我们要的是真实情况，不是满分。
            {submitting ? "正在算结果…" : ""}
          </p>

          {index > 0 && !submitting && (
            <button
              type="button"
              onClick={goBack}
              className="text-tertiary mt-4 self-start text-xs underline-offset-4 hover:underline"
            >
              上一题
            </button>
          )}
        </>
      )}
    </div>
  );
}
