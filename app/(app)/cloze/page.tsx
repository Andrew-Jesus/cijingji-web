"use client";

/**
 * `/cloze` —— 完形填空
 *
 * ── 为什么进来不自动出题（一个刻意的取舍）─────────────────────────
 * 最直觉的做法是"进页面就调 AI，等着就行"。但那样有三个问题：
 *   ① **会白发请求**。用户选的单元存在 localStorage 里，首帧拿不到真实值
 *      （`useSelectedUnitId` 首帧返回 null）—— 于是页面会用默认单元先发一次，
 *      水合完成后再发一次。两次都花钱，而第一次的结果会被丢掉。
 *   ② **用户不知道要等多久**。写一篇 200 词短文是 10~25 秒，比背一个词慢一个量级。
 *      不给预期的话，用户会以为卡死了然后关掉 —— 钱花了，人也没做成。
 *   ③ **点错单元就白花钱**。
 * 所以：有缓存直接显示；没有缓存就摆一个「出这一套」的按钮，让人自己按下去。
 *
 * ── 作答怎么回到复习安排 ────────────────────────────────────
 * 用户明确要求过"做完形填空也算复习"。所以每个空答完都会经
 * `recordAnswer` 写进 `review_logs` + `word_states`，走的是与背单词同一个事务。
 *
 * 三条口径（都写死在 `submit()` 里，改之前先想清楚）：
 *   · 答对 → `rating 3`（Good），答错 → `rating 1`（Again）。
 *     **答错永远拿不到 Good 及以上**——这条和 `lib/study/replay.ts` 的硬规矩一致。
 *   · 错因一律记 `context`（"句子里没认出来"），不是 `meaning`。
 *     四选一有上下文提示，猜对不等于记住；反过来答错也说明的不是"意思没记住"，
 *     而是"放进句子里就不认得了"，这两个事实的补救方式不一样。
 *   · **兜底题不回流**。它的挖空词跟本单元没有任何关系（见 `clozeRepo.saveCloze`），
 *     记进复习安排等于往数据里写脏东西。结算页会如实说明这一点。
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { AiResponse, AiUsageDraft } from "@/lib/ai/contract";
import { db } from "@/lib/db/local";
import { dropCachedCloze, findCachedCloze, saveCloze } from "@/lib/db/clozeRepo";
import { DATA_HONEST_NOTE, ensureSeeded, seedBundle } from "@/lib/db/seed";
import { recordAiUsage, recordAnswer, todayKey } from "@/lib/db/studyRepo";
import type { ClozeSet } from "@/lib/db/types";
import { useSelectedUnitId } from "@/lib/scope/selection";
import {
  gradeCloze,
  normalizeLemma,
  splitPassage,
  type ClozeBlank,
  type ClozeGrade,
} from "@/lib/study/cloze";
import type { ReviewRecord } from "@/lib/study/types";

/* ══════════════════════════ 页面骨架 ══════════════════════════ */

export default function ClozePage() {
  const selectedUnitId = useSelectedUnitId();
  /**
   * 没选过单元时用种子里的默认单元。
   *
   * `key` 那一行是这一页最关键的一处：单元一变就让整个屏幕**重新挂载**，
   * 于是 `choices` / 计时 / 当前阶段全部回到初始值。
   * 不用 key 就得在 effect 里手动清六七个 state —— 那种写法每次加一个 state
   * 都要记得补一行重置，漏一个就会串题（上一单元的答案出现在新题目上）。
   */
  const unitId = selectedUnitId ?? seedBundle.meta.default_unit_id;
  return <ClozeScreen key={unitId} unitId={unitId} />;
}

/* ══════════════════════════ 状态 ══════════════════════════ */

/** 渲染用的题干。与 `ClozeSet` 的区别只是**不带缓存那一层的字段**（id / 指纹 / 时间） */
interface QuestionSet {
  unitId: string;
  unitLabel: string;
  title: string;
  passage: string;
  blanks: ClozeBlank[];
  source: "ai" | "template";
  model: string | null;
  /** 服务端给的诚实说明（降级原因 / 兜底理由）。缓存命中时为 null */
  note: string | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "error"; message: string }
  | { kind: "answering"; set: QuestionSet }
  | { kind: "checking"; set: QuestionSet }
  | {
      kind: "graded";
      set: QuestionSet;
      grade: ClozeGrade;
      /** 每个空考的那个词的中文意思（查不到就没有） */
      meanings: Map<number, string>;
      /** 结算之后关于"这次有没有记进复习安排"的一句实话 */
      saveNote: string | null;
    };

/** 从缓存行变成一个渲染用的题干 */
function fromCache(row: ClozeSet): QuestionSet {
  return {
    unitId: row.unit_id,
    unitLabel: row.unit_label,
    title: row.title,
    passage: row.passage,
    blanks: row.blanks,
    source: row.source,
    model: row.model,
    note: null,
  };
}

/**
 * 取当前毫秒。**包一层是必须的**，理由与学习页那处一模一样：
 * `Date.now()` 直接写在组件里会被 React 的纯度检查（`react-hooks/purity`）
 * 判成"渲染期调用了不纯函数"——它没法知道我们只在事件回调里调。
 * 包成模块作用域的函数，语义不变，检查也不再误报。
 */
function nowMs(): number {
  return Date.now();
}

/* ══════════════════════════ 主体 ══════════════════════════ */

function ClozeScreen({ unitId }: { unitId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [choices, setChoices] = useState<Record<number, number>>({});
  /** 每个空"选过又换掉"的次数 —— 写进 `review_logs.hesitation_count` */
  const [hesitation, setHesitation] = useState<Record<number, number>>({});
  /** 开始作答的时刻（毫秒）。**只在题目就绪时设一次**，不用 `Date.now()` 现取 */
  const startedAt = useRef(0);

  useEffect(() => {
    let alive = true;

    async function readCache() {
      try {
        // 词库不灌就没法在判分后查中文释义。这里不 await：用户此刻还没开始做题，
        // 后台灌完即可；`submit()` 里会再 await 一次（幂等，第二次几乎立即返回）。
        void ensureSeeded(db).catch(() => undefined);

        const cached = await findCachedCloze(unitId);
        if (!alive) return;
        if (cached) {
          startedAt.current = nowMs();
          setPhase({ kind: "answering", set: fromCache(cached) });
        } else {
          setPhase({ kind: "idle" });
        }
      } catch (e) {
        if (!alive) return;
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }

    void readCache();
    return () => {
      alive = false;
    };
  }, [unitId]);

  /**
   * 出一套题。
   *
   * `refresh` = 用户点「换一套」。它做的唯一一件事是**先把缓存删掉**，
   * 这样服务端那条路才会真的去生成；否则本地缓存的题会被原样读回来，
   * 用户点了半天发现题没变，还会以为按钮坏了。
   */
  async function generate(refresh = false): Promise<void> {
    setPhase({ kind: "generating" });
    setChoices({});
    setHesitation({});

    try {
      if (refresh) await dropCachedCloze(unitId);

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "cloze_generate", unitId }),
      });
      const data = (await res.json()) as AiResponse;

      if (!data.ok) {
        setPhase({ kind: "error", message: data.message });
        return;
      }
      if (data.task !== "cloze_generate") {
        setPhase({ kind: "error", message: "服务器返回了另一种任务的结果，暂时出不了题。" });
        return;
      }

      const set: QuestionSet = {
        unitId: data.unit_id,
        unitLabel: data.unit_label,
        title: data.payload.title,
        passage: data.payload.passage,
        blanks: data.payload.blanks,
        source: data.source,
        model: data.model,
        note: data.notes.length > 0 ? data.notes.join(" ") : null,
      };

      // 记账与缓存写入都**不阻塞展示**：
      // 用户已经拿到题了，这两步失败最多是"下次多花一次钱"，不该变成一句报错糊在脸上。
      persistInBackground(set, data.usages);

      startedAt.current = nowMs();
      setPhase({ kind: "answering", set });
    } catch (e) {
      setPhase({
        kind: "error",
        message: `没能连上服务器（${e instanceof Error ? e.message : String(e)}）。`,
      });
    }
  }

  /** 缓存 + 记账。两个都用 `void` 起，失败只吞掉 */
  function persistInBackground(set: QuestionSet, usages: AiUsageDraft[]): void {
    const now = new Date();
    void saveCloze({
      unitId: set.unitId,
      unitLabel: set.unitLabel,
      title: set.title,
      passage: set.passage,
      blanks: set.blanks,
      source: set.source,
      model: set.model,
      now,
    }).catch(() => undefined);
    void recordAiUsage(usages, now).catch(() => undefined);
  }

  /** 点一个选项。**同一个空改选**才算一次犹豫（第一次选不算犹豫） */
  function pick(no: number, index: number): void {
    const before = choices[no];
    if (before !== undefined && before !== index) {
      setHesitation((prev) => ({ ...prev, [no]: (prev[no] ?? 0) + 1 }));
    }
    setChoices((prev) => ({ ...prev, [no]: index }));
  }

  async function submit(): Promise<void> {
    const current = phase;
    if (current.kind !== "answering") return;

    const set = current.set;
    setPhase({ kind: "checking", set });

    const grade = gradeCloze(set, choices);
    const elapsed = Math.max(nowMs() - startedAt.current, 0);

    // 查每个空考的词：既要中文释义（给结算页看），也要 word_id（回流要用）
    const info = await lookupWords(set.blanks);

    const meanings = new Map<number, string>();
    for (const [no, item] of info) {
      if (item.meaning) meanings.set(no, item.meaning);
    }

    let saveNote: string | null = null;

    if (set.source !== "ai") {
      // 兜底题：词跟本单元无关，记进去就是脏数据。**如实说明，不假装记了**
      saveNote = "这套是通用练习题，不计入你的复习安排。";
    } else {
      const now = new Date();
      const sessionId = `cloze-${todayKey(now)}`;
      // 单个空的耗时没法单独测（用户会来回看），把整篇耗时平均摊到每空。
      // 这是一个**估计值**，所以不参与"最慢的词"那类判断的强结论。
      const perBlank = Math.round(elapsed / Math.max(set.blanks.length, 1));

      const records: ReviewRecord[] = [];
      let missing = 0;

      for (const blank of grade.blanks) {
        const wordId = info.get(blank.no)?.wordId;
        if (!wordId) {
          missing += 1;
          continue;
        }
        records.push({
          word_id: wordId,
          session_id: sessionId,
          mode: "cloze",
          is_correct: blank.correct,
          latency_ms: perBlank,
          hesitation_count: hesitation[blank.no] ?? 0,
          error_type: blank.correct ? null : "context",
          rating: blank.correct ? 3 : 1,
        });
      }

      // 一条一条写，但**一起等**：少一次 await 的串行累加，也便于统计失败数
      const settled = await Promise.allSettled(records.map((r) => recordAnswer(r, now)));
      const failed = settled.filter((s) => s.status === "rejected").length;

      if (records.length === 0) {
        saveNote = "这套题里的词在本地词库里查不到，没有计入复习安排。";
      } else if (failed > 0) {
        saveNote = `有 ${failed} 个词没能记进复习安排（写入出了点问题，下次再练会补上）。`;
      } else if (missing > 0) {
        saveNote = `${missing} 个空考的词在词库里查不到，其余 ${records.length} 个已记进复习安排。`;
      }
    }

    setPhase({ kind: "graded", set, grade, meanings, saveNote });
  }

  /** 再做一遍：清空选择，重新计时。题目不变 —— 想换题用「换一套」 */
  function retry(): void {
    const current = phase;
    if (current.kind !== "graded") return;
    setChoices({});
    setHesitation({});
    startedAt.current = nowMs();
    setPhase({ kind: "answering", set: current.set });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
      <header className="mb-6">
        <Link
          href="/"
          className="text-tertiary hover:text-secondary -ml-1 rounded-sm px-1 py-1 text-xs transition-colors"
        >
          ← 回到今天
        </Link>
        <h1 className="text-primary mt-2 text-lg leading-none font-medium">练一篇完形</h1>
        <p className="text-secondary mt-2 text-xs leading-relaxed">
          十个空，每空四个选项。做完会逐个告诉你错在哪，答错的词会记进你的复习安排。
        </p>
      </header>

      <div data-animated className="flex flex-col gap-3">
        {phase.kind === "loading" && <Hint text="正在看看这个单元有没有现成的题…" />}

        {phase.kind === "idle" && <IdleCard onStart={() => void generate()} />}

        {phase.kind === "generating" && <GeneratingCard />}

        {phase.kind === "error" && (
          <section className="border-danger-600/30 bg-danger-50 rounded-lg border p-5">
            <p className="text-primary text-sm font-medium">没能出成这套题</p>
            <p className="text-secondary mt-1 text-xs break-words">{phase.message}</p>
            <button
              type="button"
              onClick={() => void generate()}
              className="border-strong bg-surface text-primary mt-4 rounded-md border px-4 py-2 text-xs transition-colors"
            >
              再试一次
            </button>
          </section>
        )}

        {(phase.kind === "answering" ||
          phase.kind === "checking" ||
          phase.kind === "graded") && (
          <>
            <QuestionCard
              set={phase.set}
              choices={choices}
              graded={phase.kind === "graded" ? phase.grade : null}
              onPick={pick}
            />

            {phase.kind === "graded" ? (
              <>
                <ScoreCard grade={phase.grade} saveNote={phase.saveNote} />
                <AnswerSheet
                  grade={phase.grade}
                  meanings={phase.meanings}
                  blanks={phase.set.blanks}
                />
                <div className="mt-1 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={retry}
                    className="bg-ink text-on-ink w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity"
                  >
                    再做一遍
                  </button>
                  <button
                    type="button"
                    onClick={() => void generate(true)}
                    className="border-strong bg-surface text-primary w-full rounded-md border px-4 py-3 text-sm transition-colors"
                  >
                    换一套题
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={phase.kind === "checking"}
                className="bg-ink text-on-ink w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity disabled:opacity-50"
              >
                {phase.kind === "checking" ? "正在对答案…" : "交卷"}
              </button>
            )}
          </>
        )}
      </div>

      <p className="text-tertiary mt-8 text-[11px] leading-relaxed">{DATA_HONEST_NOTE}</p>
    </main>
  );
}

/* ══════════════════════════ 各种卡片 ══════════════════════════ */

function Hint({ text }: { text: string }) {
  return <p className="text-secondary py-12 text-center text-sm">{text}</p>;
}

function IdleCard({ onStart }: { onStart: () => void }) {
  return (
    <section className="bg-feature rounded-lg px-6 pt-6 pb-5">
      <p className="text-secondary text-[11px] tracking-[0.08em]">这个单元还没出过题</p>
      <p className="text-primary mt-3 text-sm leading-relaxed">
        会按你这个单元的词汇表写一篇短文，挖十个空。
      </p>
      {/*
        耗时如实说在前面。写一篇 200 词短文是 10~25 秒，比背一个词慢一个量级；
        不提前讲，用户会以为卡住了。
      */}
      <p className="text-secondary mt-2 text-xs leading-relaxed">
        需要现写，大约等十几秒。写完会存在这台设备上，下次直接打开就有。
      </p>
      <button
        type="button"
        onClick={onStart}
        className="bg-ink text-on-ink mt-5 w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity"
      >
        出这一套
      </button>
    </section>
  );
}

function GeneratingCard() {
  return (
    <section className="border-subtle bg-surface rounded-lg border p-6">
      <p className="text-primary text-sm font-medium">正在写这一套题</p>
      <p className="text-secondary mt-2 text-xs leading-relaxed">
        要写一篇短文再挖十个空，比背一个词慢。这会儿别关页面。
      </p>
      {/* 只是呼吸提示，不做旋转动画 —— 产品里不用 bounce / 无限旋转 */}
      <div className="bg-sunken mt-4 h-1 w-full overflow-hidden rounded-full">
        <div className="bg-strong h-full w-1/2 animate-pulse rounded-full" />
      </div>
    </section>
  );
}

interface QuestionCardProps {
  set: QuestionSet;
  choices: Record<number, number>;
  /** 非 null = 已判分，短文里显示正确词而不是用户选的那个 */
  graded: ClozeGrade | null;
  onPick: (no: number, index: number) => void;
}

function QuestionCard({ set, choices, graded, onPick }: QuestionCardProps) {
  const resultByNo = new Map((graded?.blanks ?? []).map((b) => [b.no, b] as const));

  return (
    <>
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">{set.unitLabel}</p>
            <h2 className="text-primary mt-2 text-sm font-medium">{set.title}</h2>
          </div>
          {/*
            硬约束 10：AI 生成的内容必须在界面上标出来。
            兜底题标「通用题」而不是「AI 生成」—— 它确实不是 AI 写的。
          */}
          <span className="border-subtle text-tertiary shrink-0 rounded-sm border px-2 py-0.5 text-[11px]">
            {set.source === "ai" ? "AI 生成" : "通用题"}
          </span>
        </div>

        <p className="text-primary mt-4 text-[15px] leading-[1.95]">
          {splitPassage(set.passage).map((chunk, index) =>
            chunk.kind === "text" ? (
              <span key={index}>{chunk.text}</span>
            ) : (
              <BlankMark
                key={index}
                no={chunk.no}
                chosen={choices[chunk.no]}
                result={resultByNo.get(chunk.no) ?? null}
                options={set.blanks.find((b) => b.no === chunk.no)?.options ?? []}
              />
            ),
          )}
        </p>
      </section>

      {set.note && (
        <p className="text-secondary border-subtle bg-surface rounded-md border px-4 py-3 text-[11px] leading-relaxed">
          {set.note}
        </p>
      )}

      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-tertiary text-[11px] tracking-[0.08em]">选项</p>
        <ol className="mt-3 flex flex-col gap-3">
          {set.blanks
            .slice()
            .sort((a, b) => a.no - b.no)
            .map((blank) => (
              <li key={blank.no}>
                <p className="text-secondary text-[11px] tabular-nums">{blank.no}</p>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {blank.options.map((option, index) => (
                    <OptionButton
                      key={index}
                      text={option}
                      state={optionState(blank, index, choices[blank.no], resultByNo.get(blank.no))}
                      onClick={() => {
                        // 判分之后选项冻结 —— 否则用户会一直点，以为还能改答案
                        if (!graded) onPick(blank.no, index);
                      }}
                    />
                  ))}
                </div>
              </li>
            ))}
        </ol>
      </section>
    </>
  );
}

/**
 * 选项的状态。**四种，缺一种界面就会误导人**：
 *   `idle`       没选
 *   `picked`     用户选了它
 *   `right`      它是正确答案（判分后）
 *   `wrongPick`  用户选了它，但错了（判分后）
 *
 * 注意 `right` 与 `wrongPick` 在判分后**同时可能出现在一个空里**：
 * 用户选错了，那一项红、正确那项绿 —— 只看一个颜色是分不清"他选了什么"的。
 */
type OptionState = "idle" | "picked" | "right" | "wrongPick";

function optionState(
  blank: ClozeBlank,
  index: number,
  chosen: number | undefined,
  result: { correct: boolean; answer: number } | undefined,
): OptionState {
  if (!result) return chosen === index ? "picked" : "idle";
  if (index === result.answer) return "right";
  if (chosen === index) return "wrongPick";
  return "idle";
}

const OPTION_CLASS: Record<OptionState, string> = {
  idle: "border-subtle bg-surface text-primary",
  picked: "border-strong bg-sunken text-primary",
  right: "border-success-600 bg-success-50 text-primary",
  wrongPick: "border-danger-600 bg-danger-50 text-primary",
};

function OptionButton({
  text,
  state,
  onClick,
}: {
  text: string;
  state: OptionState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-left text-[13px] leading-snug transition-colors ${OPTION_CLASS[state]}`}
    >
      {text}
    </button>
  );
}

/** 短文里的空位。作答时显示编号（或已选词），判分后显示正确的词 */
function BlankMark({
  no,
  chosen,
  result,
  options,
}: {
  no: number;
  chosen: number | undefined;
  result: { correct: boolean; answer: number; answer_text: string } | null;
  options: string[];
}) {
  if (result) {
    const tone = result.correct ? "text-success-600" : "text-danger-600";
    return (
      <span className={`${tone} font-medium underline decoration-1 underline-offset-2`}>
        {result.answer_text || `(${no})`}
      </span>
    );
  }

  const picked = chosen !== undefined ? options[chosen] : null;
  return (
    <span
      className={
        picked
          ? "border-strong bg-sunken text-primary inline-block rounded-sm border px-1.5"
          : "border-strong text-tertiary inline-block rounded-sm border px-1.5 text-[12px] tabular-nums"
      }
    >
      {picked ?? no}
    </span>
  );
}

function ScoreCard({ grade, saveNote }: { grade: ClozeGrade; saveNote: string | null }) {
  return (
    <section className="bg-feature rounded-lg px-6 pt-6 pb-5">
      <p className="text-secondary text-[11px] tracking-[0.08em]">这一套</p>
      <p className="text-brand-800 mt-3 flex items-baseline text-[2.75rem] leading-none font-medium tabular-nums">
        {grade.correct_count}
        <span className="text-secondary ml-2 text-sm font-normal">/ {grade.total} 个空</span>
      </p>
      {saveNote && (
        <p className="text-secondary border-strong mt-5 border-t pt-4 text-xs leading-relaxed">
          {saveNote}
        </p>
      )}
    </section>
  );
}

/** 逐空对照。**这是这一页真正有价值的部分** —— 只给分数，用户不知道下次该看哪里 */
function AnswerSheet({
  grade,
  meanings,
  blanks,
}: {
  grade: ClozeGrade;
  meanings: Map<number, string>;
  blanks: ClozeBlank[];
}) {
  const blankByNo = new Map(blanks.map((b) => [b.no, b] as const));

  return (
    <section className="border-subtle bg-surface rounded-lg border p-5">
      <p className="text-tertiary text-[11px] tracking-[0.08em]">逐空看一遍</p>
      <ul className="divide-subtle mt-2 divide-y">
        {grade.blanks.map((row) => {
          const meaning = meanings.get(row.no);
          const word = blankByNo.get(row.no)?.word ?? "";
          return (
            <li key={row.no} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-primary truncate text-sm">
                  {row.no}. {word || row.answer_text}
                  {meaning ? <span className="text-secondary ml-2 text-xs">{meaning}</span> : null}
                </span>
                <span
                  className={`shrink-0 text-[11px] ${row.correct ? "text-success-600" : "text-danger-600"}`}
                >
                  {row.correct ? "对了" : "错了"}
                </span>
              </div>
              {!row.correct && (
                <p className="text-secondary mt-1 text-xs leading-relaxed">
                  你选了「{row.chosen_text ?? "没选"}」，应该是「{row.answer_text}」。
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ══════════════════════════ 词库查询 ══════════════════════════ */

interface WordInfo {
  wordId: string;
  meaning: string | null;
}

/**
 * 一次把这套题里所有词查出来：`word_id`（回流要用）与中文释义（结算页要用）。
 *
 * 三条注意：
 *   ① **一次 `anyOf` 查完**，不要 10 次单查 —— 每个空都等一次 IndexedDB 往返，
 *      十次就是肉眼能看出来的卡顿。
 *   ② 查不到就是查不到，**不编一个意思出来**。兜底题的词大概率不在词库里，
 *      这时界面上不显示释义，也不影响判分。
 *   ③ 用 `lemma_normalized` 匹配，不用 `lemma`：模型写的是 `Join` 还是 `join`
 *      我们管不了，而归一形是词表建库时统一的那个口径。
 */
async function lookupWords(blanks: readonly ClozeBlank[]): Promise<Map<number, WordInfo>> {
  const out = new Map<number, WordInfo>();
  try {
    await ensureSeeded(db);

    const keys = [...new Set(blanks.map((b) => normalizeLemma(b.word)))].filter(Boolean);
    if (keys.length === 0) return out;

    const rows = await db.words.where("lemma_normalized").anyOf(keys).toArray();
    if (rows.length === 0) return out;

    const byLemma = new Map(rows.map((w) => [w.lemma_normalized, w] as const));
    const senses = await db.senses.where("word_id").anyOf(rows.map((w) => w.id)).toArray();
    const primaryMeaning = new Map<string, string>();
    for (const s of senses) {
      if (s.is_primary && !primaryMeaning.has(s.word_id)) primaryMeaning.set(s.word_id, s.cn_meaning);
    }

    for (const blank of blanks) {
      const word = byLemma.get(normalizeLemma(blank.word));
      if (!word) continue;
      out.set(blank.no, {
        wordId: word.id,
        meaning: primaryMeaning.get(word.id) ?? null,
      });
    }
  } catch {
    // 词库读不出来不该让结算页打不开：拿不到词就少写几条记录，如实说就是
  }
  return out;
}
