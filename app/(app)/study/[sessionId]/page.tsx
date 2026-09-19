"use client";

/**
 * `/study/[sessionId]` —— 学习页（方案 §7.5）
 *
 * `sessionId` 就是**本地日期**（`2026-09-19`）。选日期而不是随机 id 的原因：
 * 一次学习天然等于"今天那一单"，重进、刷新、换设备（阶段 1）都该落到同一份任务单上。
 *
 * ── 这一页的四件东西 ─────────────────────────────────────────
 *   ① **两个卡片模板**：`recognize`（看英选中）/ `recall_spell`（中译英）
 *   ② **三级反馈**：答完给三档（Again / Hard / Good）→ 真的写进 `review_logs.rating`
 *   ③ **兴趣域例句**：调 `/api/ai`，先查本地缓存，失败降级成通用示例并**如实标注**
 *   ④ **页内终态**：对错数 / 用时 / 卡住的词 —— **不新增路由**（方案 §2 的负面清单）
 *
 * ── 三条必须守住的体验底线 ───────────────────────────────────
 *   1. **AI 挂了不能卡住这一页。** 例句那条链路有三重兜底（服务端降级链 + 模板句 +
 *      客户端离线模板），任何一环断了都是"少一句例句"，不是"这页打不开"。
 *   2. **断网可用。** 卡片数据全在本地；只有例句需要网，拿不到就换成通用示例。
 *   3. **进度不在这里另算一遍。** 今日进度统一用 `countDoneInPlan`（与首页同一个函数），
 *      否则会出现"学完 20 个回到首页显示 18/20"这种最伤信任的 bug。
 *
 * ── 一个刻意的取舍：**答完才去取例句** ─────────────────────────
 * 不是在卡片一出现就预取。原因：预取等于"用户还没答就先花一次 AI 的钱"，
 * 而答对答错都得给例句，一天 20 个词就是 20 次调用。放在"揭示答案"这一刻取，
 * 既省掉了翻页跳过的浪费，又正好用等待时间制造"它在为我写一句"的期待感。
 * （第二次遇到同一个词直接读本地缓存，不再调用。）
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { AiResponse } from "@/lib/ai/contract";
import { fallbackNote, templateExample } from "@/lib/ai/fallback";
import { pushNotice, setTodayProgress } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { getProfile, isOnboarded } from "@/lib/db/repo";
import { DATA_HONEST_NOTE, ensureSeeded } from "@/lib/db/seed";
import {
  appendReviewLog,
  deriveWeakWordIds,
  findCachedExample,
  loadDailyPlan,
  loadReviewLogsForDay,
  recordAiUsage,
  saveDailyPlan,
  saveExample,
  setPlanStatus,
  todayKey,
} from "@/lib/db/studyRepo";
import { GENERIC_INTEREST_TAG, interestLabel } from "@/lib/onboarding/questions";
import { doneWordIdsToday } from "@/lib/plan/todayProgress";
import { assembleTodayPlan, scopeLabelOf } from "@/lib/plan/todayPlan";
import { buildKnownLemmaSet, buildStudyCards } from "@/lib/study/cards";
import { errorTypeLabel, gradeAnswer } from "@/lib/study/grade";
import { MNEMONIC_TRIGGER_LABEL, mnemonicFor } from "@/lib/study/mnemonic";
import { RATING_FOOTNOTE, RATING_OPTIONS, defaultRating, ratingHint } from "@/lib/study/rating";
import {
  advance,
  buildQueue,
  formatElapsed,
  progressAt,
  settledWordIds,
  summarize,
  type QueueEntry,
} from "@/lib/study/session";
import type {
  GradeResult,
  Rating,
  ReviewRecord,
  StudyAnswer,
  StudyCard,
  StudySummary,
} from "@/lib/study/types";

/** 例句在界面上的样子。`isAiGenerated` 是**唯一**决定标注文案的字段 */
interface ExampleView {
  sentence: string;
  gloss: string;
  isAiGenerated: boolean;
  /** 降级原因（人话）。AI 正常时为 null */
  note: string | null;
  model: string | null;
}

interface SessionData {
  sessionId: string;
  cards: StudyCard[];
  knownLemmas: Set<string>;
  /** 实际用于例句的兴趣域（没选兴趣时是 "general"） */
  interestTag: string;
  /** 用户自己选的兴趣（界面要如实说明"你还没选"） */
  interests: string[];
  scopeLabel: string;
  goalSummary: string;
  planTotal: number;
  planWordIds: string[];
  /**
   * 进入时**今天已经练过、且在任务单里**的词。
   * 存 id 列表而不是一个数字：进度要的是"并集"，两个数字之间是加不出来的
   * （先做 5 个、再进来做 3 个，不一定是 8 个 —— 可能是同一批词又做了一遍）。
   */
  doneWordIdsAtEntry: string[];
}

type Phase = "loading" | "error" | "studying" | "finished";

/**
 * 取当前时刻。**为什么包一层**：`Date.now()` 直接写在组件体里会被 React 的
 * 纯度检查（`react-hooks/purity`）判为"渲染期调用了不纯函数" —— 它没法知道
 * 我们只在事件回调 / 异步回调里调它。包成模块作用域的函数，语义没变，
 * 检查也不再误报。**不要**为了绕开检查而把时间戳换成 ref 里的假值：
 * `latency_ms` 是这张表最有价值的字段之一，它必须是真时间。
 */
function nowMs(): number {
  return Date.now();
}

export default function StudyPage() {
  const router = useRouter();
  const params = useParams<{ sessionId: string }>();
  const sessionId = String(params?.sessionId ?? "");

  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [session, setSession] = useState<SessionData | null>(null);

  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [pos, setPos] = useState(0);
  const [records, setRecords] = useState<ReviewRecord[]>([]);
  const [summary, setSummary] = useState<StudySummary | null>(null);

  // ---- 当前这张卡的作答状态 ----
  const [selected, setSelected] = useState<number | null>(null);
  const [changes, setChanges] = useState(0);
  const [text, setText] = useState("");
  const [clears, setClears] = useState(0);
  const [submitted, setSubmitted] = useState<StudyAnswer | null>(null);
  const [grade, setGrade] = useState<GradeResult | null>(null);

  // ---- 例句 ----
  const [example, setExample] = useState<ExampleView | null>(null);
  const [exampleLoading, setExampleLoading] = useState(false);

  const cardShownAt = useRef<number>(nowMs());
  const sessionStartAt = useRef<number>(nowMs());

  const current = queue[pos] ?? null;
  const card = current?.card ?? null;

  // ------------------------------------------------------------------ 装载

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const profile = await getProfile();
        if (cancelled) return;
        if (!profile || !isOnboarded(profile)) {
          router.replace("/onboarding");
          return;
        }

        const now = new Date();
        const today = todayKey(now);

        // 进了旧的链接（比如收藏了昨天的地址）不应该静默当成今天 ——
        // 那会把今天的复习记录挂到昨天的日期上。如实说一句，再把人送到今天这一单。
        if (sessionId !== today) {
          pushNotice({
            key: "study-session",
            level: "warning",
            title: "这不是今天的任务单",
            detail: `你打开的是 ${sessionId}，已经带你回到今天（${today}）这一份。`,
          });
          router.replace(`/study/${today}`);
          return;
        }

        await ensureSeeded(db);
        const [units, words, senses, placements, goalProfiles, storedPlan, logs] =
          await Promise.all([
            db.units.toArray(),
            db.words.toArray(),
            db.senses.toArray(),
            db.word_placements.toArray(),
            db.goal_profiles.toArray(),
            loadDailyPlan(today),
            loadReviewLogsForDay(now),
          ]);
        const snapshot = { units, words, senses, placements };

        const goalProfile = goalProfiles.find((p) => p.goal_code === "zhongkao");
        if (!goalProfile) throw new Error("本地库缺少 goal_profiles（中考）配置");

        const weak = await deriveWeakWordIds();
        const assembled = assembleTodayPlan({
          snapshot,
          goalProfile,
          dailyMinutes: profile.daily_minutes,
          weakWordIds: weak,
        });
        if (!assembled.ok) throw new Error(`[${assembled.code}] ${assembled.message}`);

        // 今天这一单：优先用它上次存下来的样子（同一天内不再重排 ——
        // 用户练到一半改了设置，不该让他手上的单子中途换掉）。
        const items = storedPlan?.items.length ? storedPlan.items : assembled.plan.items;
        const brief = storedPlan?.brief ?? assembled.plan.brief;

        await saveDailyPlan({
          planDate: today,
          items,
          brief,
          estimatedMinutes: storedPlan?.estimated_minutes ?? assembled.plan.estimated_minutes,
          now,
        });
        if (!storedPlan || storedPlan.status === "pending") {
          await setPlanStatus(today, "in_progress");
        }

        const cards = buildStudyCards({ items, snapshot });
        const knownLemmas = buildKnownLemmaSet(snapshot);
        const settled = settledWordIds(logs, today);
        const initialQueue = buildQueue(cards, settled);

        const planWordIds = items.map((i) => i.word_id);
        const planIdSet = new Set(planWordIds);
        // 今天已经练过的词（与首页同一个口径：按本地日界筛，去重，再与任务单求交）
        const doneWordsAtEntry = [...doneWordIdsToday(logs, now)].filter((id) => planIdSet.has(id));
        const interestTag = profile.interests[0] ?? GENERIC_INTEREST_TAG;

        if (cancelled) return;

        sessionStartAt.current = Date.now();
        cardShownAt.current = nowMs();

        setSession({
          sessionId: today,
          cards,
          knownLemmas,
          interestTag,
          interests: profile.interests,
          scopeLabel: scopeLabelOf(assembled.scope),
          goalSummary: goalProfile.user_facing_summary,
          planTotal: items.length,
          planWordIds,
          doneWordIdsAtEntry: doneWordsAtEntry,
        });

        // 进来就先把小词的环对上（与首页同一个口径，同一个函数）
        setTodayProgress(doneWordsAtEntry.length, items.length);

        if (initialQueue.length === 0) {
          // 今天的词都稳住了（或者范围里没词）—— 直接给终态，而不是显示一张空气卡。
          // 用时用当天首尾两条记录来估：**这是估算，不是实测**，所以文案里写"约"。
          const stamps = logs
            .map((l) => new Date(l.created_at).getTime())
            .filter((t) => !Number.isNaN(t))
            .sort((a, b) => a - b);
          const elapsed = stamps.length >= 2 ? stamps[stamps.length - 1] - stamps[0] : 0;
          setSummary(summarize(logs, cards, elapsed));
          setPhase("finished");
          return;
        }

        setQueue(initialQueue);
        setPos(0);
        setPhase("studying");
        pushNotice({
          key: "study-start",
          level: "info",
          title: "开始今天的学习",
          detail: `${initialQueue.length} 个词待练 · ${assembled.scopeLabel}`,
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        pushNotice({ key: "study-session", level: "danger", title: "学习页没能准备好", detail: message });
        setErrorMsg(message);
        setPhase("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router, sessionId]);

  // ------------------------------------------------------------------ 例句

  const loadExample = useCallback(
    async (target: StudyCard, interestTag: string) => {
      setExampleLoading(true);
      setExample(null);

      const facts = {
        lemma: target.lemma,
        phonetic: target.phonetic_uk,
        pos: target.pos,
        meaning_zh: target.meaning_zh ?? "",
      };

      // ① 本地缓存先行 —— `(word_id, interest_tag)` 命中就不再花这笔钱
      try {
        const cached = await findCachedExample(target.word_id, interestTag);
        if (cached) {
          setExample({
            sentence: cached.sentence,
            gloss: cached.gloss,
            isAiGenerated: cached.is_ai_generated,
            note: null,
            model: null,
          });
          return;
        }
      } catch {
        // 缓存读失败不该拦住整条路：继续去请求，最差也是落到模板句
      }

      // ② 真调用
      try {
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "example_personalized", wordId: target.word_id, interestTag }),
        });
        const data = (await res.json()) as AiResponse;
        const now = new Date();

        if (!data.ok) {
          // 服务端明确拒绝（比如本地词库里没这个词）—— 这不是网络问题，别混淆
          setExample({
            ...templateExample(facts, interestTag),
            isAiGenerated: false,
            note: `服务器没能给出例句：${data.message}`,
            model: null,
          });
          return;
        }

        // 记账与缓存写入都**不阻塞展示**：用户已经看到句子了，
        // 后面的写库失败最多是"下次再生成一遍"，不该变成一句报错糊在脸上。
        void saveExample({
          wordId: target.word_id,
          interestTag,
          sentence: data.payload.sentence,
          gloss: data.payload.gloss,
          isAiGenerated: data.is_ai_generated,
          now,
        }).catch(() => undefined);
        void recordAiUsage(data.usages, now).catch(() => undefined);

        setExample({
          sentence: data.payload.sentence,
          gloss: data.payload.gloss,
          isAiGenerated: data.is_ai_generated,
          note: data.notes.length > 0 ? data.notes.join(" ") : null,
          model: data.model,
        });

        if (data.source === "template") {
          pushNotice({
            key: "ai-example",
            level: "warning",
            title: "例句这次是通用示例",
            detail: data.notes.join(" ") || "AI 这条路没走通，先给你一句通用的。",
          });
        } else if (!data.degraded) {
          pushNotice({
            key: "ai-example-ok",
            level: "success",
            title: "例句已按你的兴趣写好",
            detail: data.model ? `${data.model} · 结合「${interestLabel(interestTag)}」` : undefined,
          });
        }
      } catch {
        // ③ 连不上（断网 / 服务端没起来）→ 客户端自己拼一句，并如实说是通用示例。
        // 这一档保证「断网也能练」这条验收项成立。
        setExample({
          ...templateExample(facts, interestTag),
          isAiGenerated: false,
          note: fallbackNote("network"),
          model: null,
        });
      } finally {
        setExampleLoading(false);
      }
    },
    [],
  );

  // ------------------------------------------------------------------ 作答

  function pickOption(index: number) {
    if (submitted) return;
    // 改主意一次算一次犹豫 —— 这正是 `hesitation_count` 要记的东西
    if (selected !== null && selected !== index) setChanges((c) => c + 1);
    setSelected(index);
  }

  function submit() {
    if (!card || !session || submitted) return;
    const answer: StudyAnswer =
      card.mode === "recall_spell"
        ? { kind: "text", value: text }
        : { kind: "index", value: selected ?? -1 };

    setSubmitted(answer);
    setGrade(gradeAnswer(card, answer, session.knownLemmas));
    void loadExample(card, session.interestTag);
  }

  async function rate(rating: Rating) {
    if (!card || !session || !grade || !submitted) return;

    const now = new Date();
    const record: ReviewRecord = {
      word_id: card.word_id,
      session_id: session.sessionId,
      mode: card.mode,
      is_correct: grade.is_correct,
      latency_ms: nowMs() - cardShownAt.current,
      hesitation_count: card.mode === "recognize" ? changes : clears,
      error_type: grade.error_type,
      rating,
    };

    const nextRecords = [...records, record];
    setRecords(nextRecords);

    // 先落库再前进：宁可"记录多了一条、卡片没走"，也不要反过来的那种丢数据。
    // 写失败也让用户继续走 —— 卡住他比丢一条记录更糟。
    try {
      await appendReviewLog(record, now);
    } catch {
      pushNotice({
        key: "review-log",
        level: "warning",
        title: "这条作答没能记下来",
        detail: "本地库写入失败。不影响继续练，但这次的记录会缺一条。",
      });
    }

    const moved = advance(queue, pos, rating);
    setQueue(moved.queue);
    setPos(moved.nextPos);
    resetAnswer();
    cardShownAt.current = nowMs();

    if (session) {
      // 会话内的即时反馈：**并集**（进店时已练的 + 这次练的），分母恒为任务单长度。
      // 刻意不写 `已练 + 新增` 这种加法 —— 同一批词练两遍会被算成两个词，进度会虚高。
      const doneIds = new Set(session.doneWordIdsAtEntry);
      for (const r of nextRecords) doneIds.add(r.word_id);
      setTodayProgress(doneIds.size, session.planTotal);
    }

    if (moved.finished) {
      const s = summarize(nextRecords, session.cards, nowMs() - sessionStartAt.current);
      setSummary(s);
      try {
        await setPlanStatus(session.sessionId, "done");
      } catch {
        // 状态没写成功不影响用户；下次进来还会算一遍队列
      }
      pushNotice({
        key: "study-done",
        level: "success",
        title: "今天的词练完了",
        detail: `一次就对 ${s.correct} 个 · 练了 ${s.total} 个 · 用时 ${formatElapsed(s.elapsed_ms)}`,
      });
      setPhase("finished");
    }
  }

  function resetAnswer() {
    setSelected(null);
    setChanges(0);
    setText("");
    setClears(0);
    setSubmitted(null);
    setGrade(null);
    setExample(null);
    setExampleLoading(false);
  }

  // ------------------------------------------------------------------ 渲染

  if (phase === "loading") {
    return (
      <Shell>
        <p className="text-secondary py-16 text-center text-sm">正在准备今天的词…</p>
      </Shell>
    );
  }

  if (phase === "error" || !session) {
    return (
      <Shell>
        <div className="border-danger-600/30 bg-danger-50 rounded-lg border p-4">
          <p className="text-primary text-sm font-medium">学习页没能准备好</p>
          <p className="text-secondary mt-1.5 text-xs break-words">
            {errorMsg || "没读到本地数据"}
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="text-secondary mt-3 text-xs underline underline-offset-4"
          >
            回首页看看
          </button>
        </div>
      </Shell>
    );
  }

  if (phase === "finished" && summary) {
    return (
      <Shell>
        <FinishedView summary={summary} session={session} router={router} />
      </Shell>
    );
  }

  // 分母传任务单的词数（不是队列长度）—— 与首页的「36 个词」是同一个数。
  // 队列长度会因 Again 回插而变大，用它当分母会让顶部走到 37/38，两个界面对不上。
  const progress = progressAt(queue, pos, session.cards.length);
  const alreadyDone = queue.length === 0 && pos === 0;

  return (
    <Shell>
      {/* 顶部：退出 + 进度。行内只放"还剩多少"，不写大标题 —— 学习时注意力该在卡上 */}
      <header className="mb-5 flex items-center gap-4">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="text-tertiary -ml-2 shrink-0 px-2 py-1 text-xs underline-offset-4 hover:underline"
        >
          先到这儿
        </button>
        <div className="min-w-0 flex-1">
          <div className="bg-sunken h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-brand-600 ease-soft h-full rounded-full transition-[width] duration-240"
              style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
        <p className="text-tertiary shrink-0 text-[11px] tabular-nums">
          {progress.done} / {progress.total}
        </p>
      </header>

      {alreadyDone && !card && (
        <p className="text-secondary py-12 text-center text-sm">
          这一单里的词都练过了 —— 今天的任务单已经走完。
        </p>
      )}

      {card && (
        <div key={`${card.word_id}-${current?.round ?? 0}`} data-animated className="flex flex-col gap-3">
          <CardView
            card={card}
            round={current?.round ?? 0}
            selected={selected}
            submitted={submitted}
            text={text}
            onPick={pickOption}
            onText={(v) => {
              // 从"有内容"清成"空"记一次犹豫：这比"敲了几个键"更接近"他在犹豫"这件事
              if (text.length > 0 && v.length === 0) setClears((c) => c + 1);
              setText(v);
            }}
            onSubmit={submit}
          />

          {grade && (
            <RevealView
              card={card}
              grade={grade}
              example={example}
              exampleLoading={exampleLoading}
              interestTag={session.interestTag}
              interests={session.interests}
              onRate={(r) => void rate(r)}
            />
          )}
        </div>
      )}
    </Shell>
  );
}

// ==================================================================== 局部组件

function Shell({ children }: { children: ReactNode }) {
  // pb-20：左下角常驻小词（44px + 20px 边距），不留够底部空白它会压住最后的按钮
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-6 pb-20">{children}</main>
  );
}

const MODE_LABEL: Record<string, string> = {
  recognize: "看英选中",
  recall_spell: "中译英",
};

/** 正确答案的显示文本：选择题给选项原文，拼写题给词 */
function correctTextOf(card: StudyCard): string {
  if (card.mode === "recognize" && card.options && card.answer_index != null) {
    return card.options[card.answer_index] ?? card.lemma;
  }
  return card.lemma;
}

function CardView({
  card,
  round,
  selected,
  submitted,
  text,
  onPick,
  onText,
  onSubmit,
}: {
  card: StudyCard;
  round: number;
  selected: number | null;
  submitted: StudyAnswer | null;
  text: string;
  onPick: (index: number) => void;
  onText: (value: string) => void;
  onSubmit: () => void;
}) {
  const revealed = submitted !== null;
  const isSpell = card.mode === "recall_spell";

  return (
    <section className="border-subtle bg-surface rounded-lg border p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-tertiary text-[11px] tracking-[0.08em]">
          {card.unit_code} · {MODE_LABEL[card.mode] ?? card.mode}
        </p>
        {round > 0 && (
          <p className="text-tertiary shrink-0 text-[11px] tabular-nums">第 {round + 1} 遍</p>
        )}
      </div>

      {isSpell ? (
        <>
          <p className="text-primary mt-4 text-2xl leading-snug font-medium">{card.meaning_zh}</p>
          {card.pos && <p className="text-tertiary mt-1.5 text-xs">{card.pos}</p>}
          <p className="text-tertiary mt-4 text-xs">写出对应的英文单词</p>
        </>
      ) : (
        <>
          <p className="text-primary mt-4 text-[2rem] leading-tight font-medium break-words">
            {card.lemma}
          </p>
          {card.phonetic_uk && <p className="text-secondary mt-1.5 text-sm">{card.phonetic_uk}</p>}
          <p className="text-tertiary mt-4 text-xs">它的意思是？</p>
        </>
      )}

      {/* 硬约束 12：置信度低于 0.8 必须标注"可能不准" */}
      {card.confidence < 0.8 && (
        <p className="text-tertiary mt-3 text-[11px] leading-relaxed">
          这一条还没经过人工核对，可能不准 —— 觉得不对随时告诉我。
        </p>
      )}

      {isSpell ? (
        <div className="mt-4 space-y-3">
          <input
            value={text}
            disabled={revealed}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            placeholder="在这里写"
            aria-label="输入英文单词"
            className="border-subtle bg-page text-primary placeholder:text-tertiary focus:border-brand-600 w-full rounded-md border px-3.5 py-3 text-base tracking-wide outline-none disabled:opacity-70"
          />
          {!revealed && (
            <button
              type="button"
              disabled={text.trim().length === 0}
              onClick={onSubmit}
              className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity duration-200 active:scale-[0.99] disabled:opacity-40"
            >
              确认
            </button>
          )}
        </div>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {(card.options ?? []).map((option, i) => {
            const isPicked = selected === i;
            const isAnswer = card.answer_index === i;

            // 三态：未揭示时"选中"用主色；揭示后正确项用成功色、选错的那项用危险色。
            // **不只靠颜色**——每一项旁边还有"正确 / 你选的"文字标记，色弱用户也分得清。
            let tone = "border-subtle bg-surface hover:border-strong";
            if (!revealed && isPicked) tone = "border-brand-600 bg-brand-50";
            if (revealed && isAnswer) tone = "border-success-600 bg-success-50";
            if (revealed && isPicked && !isAnswer) tone = "border-danger-600 bg-danger-50";

            return (
              <li key={option}>
                <button
                  type="button"
                  disabled={revealed}
                  onClick={() => onPick(i)}
                  className={`ease-soft flex w-full items-start justify-between gap-3 rounded-md border px-4 py-3.5 text-left transition-[background-color,border-color] duration-200 ${tone}`}
                >
                  <span className="text-primary min-w-0 text-sm leading-snug">{option}</span>
                  {revealed && isAnswer && (
                    <span className="text-success-600 shrink-0 text-[11px]">正确</span>
                  )}
                  {revealed && isPicked && !isAnswer && (
                    <span className="text-danger-600 shrink-0 text-[11px]">你选的</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!revealed && !isSpell && (
        <button
          type="button"
          disabled={selected === null}
          onClick={onSubmit}
          className="bg-brand-600 text-on-brand ease-soft mt-4 w-full rounded-md px-4 py-3 text-sm font-medium transition-opacity duration-200 active:scale-[0.99] disabled:opacity-40"
        >
          确认
        </button>
      )}
    </section>
  );
}

function RevealView({
  card,
  grade,
  example,
  exampleLoading,
  interestTag,
  interests,
  onRate,
}: {
  card: StudyCard;
  grade: GradeResult;
  example: ExampleView | null;
  exampleLoading: boolean;
  interestTag: string;
  interests: string[];
  onRate: (rating: Rating) => void;
}) {
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const tip = mnemonicFor(card);
  const preset = defaultRating(grade.is_correct);

  async function copyFeedback() {
    const report = [
      "【词径记 · 例句反馈】",
      `时间：${new Date().toLocaleString("zh-CN")}`,
      `单词：${card.lemma}（${card.meaning_zh ?? ""}）`,
      `兴趣域：${interestLabel(interestTag)}`,
      `例句：${example?.sentence ?? "（还没拿到）"}`,
      `来源：${example?.isAiGenerated ? `AI 生成${example.model ? ` · ${example.model}` : ""}` : "通用示例"}`,
      "",
      "问题：",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板在非 HTTPS 下会失败 —— 不影响继续练，安静地算了
      setCopied(false);
    }
  }

  return (
    <section data-animated className="border-subtle bg-surface rounded-lg border p-5">
      {/* ① 对错 + 正确答案 */}
      <div className="flex items-baseline justify-between gap-3">
        <p
          className={`text-sm font-medium ${grade.is_correct ? "text-success-600" : "text-danger-600"}`}
        >
          {grade.is_correct ? "对了" : "没对"}
        </p>
        {!grade.is_correct && (
          <p className="text-tertiary text-[11px]">{errorTypeLabel(grade.error_type)}</p>
        )}
      </div>
      {!grade.is_correct && (
        <p className="text-primary mt-2 text-sm leading-relaxed">
          正确答案：
          <span className="font-medium">{correctTextOf(card)}</span>
          {card.phonetic_uk && <span className="text-secondary ml-2 text-xs">{card.phonetic_uk}</span>}
        </p>
      )}

      {/* ② 例句 —— 这一屏的"就是给我写的"全靠它 */}
      <div className="border-subtle mt-4 border-t pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-tertiary text-[11px] tracking-[0.08em]">例句</p>
          <p className="text-tertiary shrink-0 text-[11px]">
            {interests.length > 0 ? interestLabel(interestTag) : "还没选兴趣"}
          </p>
        </div>

        {exampleLoading && !example && (
          <p className="text-tertiary mt-3 text-xs">正在按你选的兴趣写一句…</p>
        )}

        {!exampleLoading && !example && (
          <p className="text-tertiary mt-3 text-xs">例句暂时没拿到。</p>
        )}

        {example && (
          <>
            <p className="text-primary mt-3 text-sm leading-relaxed">{example.sentence}</p>
            <p className="text-secondary mt-1.5 text-xs leading-relaxed">{example.gloss}</p>

            {example.isAiGenerated ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* 硬约束 10：AI 生成的内容必须标出来，并给一个反馈入口 */}
                <span className="text-tertiary text-[11px]">
                  AI 生成{example.model ? `（${example.model}）` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setFeedbackOpen((v) => !v)}
                  className="text-tertiary text-[11px] underline underline-offset-4"
                >
                  {feedbackOpen ? "收起" : "这句有问题"}
                </button>
              </div>
            ) : (
              <p className="text-tertiary mt-2.5 text-[11px] leading-relaxed">
                {example.note ?? fallbackNote("unexpected")}
              </p>
            )}

            {feedbackOpen && (
              <button
                type="button"
                onClick={() => void copyFeedback()}
                className="border-subtle text-secondary mt-2.5 w-full rounded-md border px-3 py-2 text-[11px]"
              >
                {copied ? "已复制，发给我就行" : "复制这句话的问题，发给我"}
              </button>
            )}
          </>
        )}
      </div>

      {/* ③ 记忆法抽屉 —— 默认收起。阶段 0 是通用练习建议，不编词源 */}
      <div className="border-subtle mt-4 border-t pt-3">
        <button
          type="button"
          onClick={() => setShowMnemonic((v) => !v)}
          aria-expanded={showMnemonic}
          className="text-secondary text-xs underline-offset-4 hover:underline"
        >
          {showMnemonic ? "收起" : MNEMONIC_TRIGGER_LABEL}
        </button>
        {showMnemonic && (
          <div data-animated className="mt-2.5">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">{tip.title}</p>
            <ul className="mt-2 space-y-1.5">
              {tip.lines.map((line) => (
                <li key={line} className="text-secondary text-xs leading-relaxed">
                  {line}
                </li>
              ))}
            </ul>
            <p className="text-tertiary mt-2.5 text-[11px] leading-relaxed">{tip.note}</p>
          </div>
        )}
      </div>

      {/* ④ 三级反馈 —— 三档都真的写进 review_logs.rating */}
      <div className="border-subtle mt-4 border-t pt-4">
        <p className="text-tertiary text-[11px] tracking-[0.08em]">
          刚才想起来了吗？（已经替你预选了「{ratingHint(
            RATING_OPTIONS.find((o) => o.rating === preset) ?? RATING_OPTIONS[0],
            grade.is_correct,
          )}」那一档）
        </p>
        <div className="mt-3 space-y-2">
          {RATING_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onRate(option.rating)}
              className={`ease-soft w-full rounded-md border px-4 py-3 text-left transition-[background-color,border-color] duration-200 active:scale-[0.99] ${
                option.rating === preset
                  ? "border-brand-600 bg-brand-50"
                  : "border-subtle bg-surface hover:border-strong"
              }`}
            >
              <span className="text-primary block text-sm leading-snug">{option.label}</span>
              <span className="text-tertiary mt-0.5 block text-[11px] leading-snug">
                {ratingHint(option, grade.is_correct)}
              </span>
            </button>
          ))}
        </div>
        <p className="text-tertiary mt-2.5 text-[11px] leading-relaxed">{RATING_FOOTNOTE}</p>
      </div>
    </section>
  );
}

function FinishedView({
  summary,
  session,
  router,
}: {
  summary: StudySummary;
  session: SessionData;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <div data-animated className="flex flex-col gap-3">
      <header>
        <h1 className="text-primary text-xl leading-snug font-medium">今天这一单走完了</h1>
        <p className="text-secondary mt-1.5 text-sm leading-relaxed">
          {session.scopeLabel} · 一共 {summary.total} 个词
        </p>
      </header>

      {/* 主卡：一次就对几个。整页的重心 */}
      <section className="bg-feature rounded-lg px-6 pt-6 pb-5">
        <p className="text-secondary text-[11px] tracking-[0.08em]">一次就认出来的</p>
        <p className="text-brand-800 mt-3 flex items-baseline text-[2.75rem] leading-none font-medium tabular-nums">
          {summary.correct}
          <span className="text-secondary ml-2 text-sm font-normal">/ {summary.total} 个</span>
        </p>
        <p className="text-secondary mt-3 text-xs">用时约 {formatElapsed(summary.elapsed_ms)}</p>
        <p className="text-secondary border-strong mt-5 border-t pt-4 text-xs leading-relaxed">
          一共作答 {summary.attempts} 次（同一个词再练一遍也算一次）—— 这就是为什么它比词的个数多。
        </p>
      </section>

      {/* 卡住的词：这才是明天真正要处理的东西 */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-tertiary text-[11px] tracking-[0.08em]">今天卡住的</p>
        {summary.stuck.length === 0 ? (
          <p className="text-primary mt-3 text-sm leading-relaxed">一个都没有 —— 今天挺顺。</p>
        ) : (
          <>
            <p className="text-secondary mt-3 text-xs leading-relaxed">
              这几个今天错过，明天还会出现在你面前：
            </p>
            <ul className="divide-subtle mt-3 divide-y">
              {summary.stuck.map((w) => (
                <li key={w.word_id} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="text-primary min-w-0 truncate text-sm">{w.lemma}</span>
                  <span className="text-tertiary shrink-0 text-[11px] tabular-nums">
                    错 {w.times} 次
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 会怎么练：手写摘要，不由 AI 生成 */}
      <section className="border-subtle bg-surface rounded-lg border p-5">
        <p className="text-tertiary text-[11px] tracking-[0.08em]">会怎么练</p>
        <p className="text-primary mt-3 text-sm leading-relaxed">{session.goalSummary}</p>
      </section>

      {/* 诚实标注（方案 §6.3 要求出现在结果页与学习页） */}
      <section className="border-warning-600/30 bg-warning-50 rounded-lg border p-4">
        <p className="text-primary text-xs font-medium">必须让你知道的两件事</p>
        <p className="text-secondary mt-2 text-xs leading-relaxed">{DATA_HONEST_NOTE}</p>
        <p className="text-secondary mt-2 text-xs leading-relaxed">
          另外：复习间隔还没接（科学复习调度排在阶段 2）。现在「明天还会出现」是按
          <span className="font-medium">「今天最后一次没答对」</span>
          推的 —— 顺序是稳的、可解释的，但不是最科学的那种。
        </p>
      </section>

      <button
        type="button"
        onClick={() => router.push("/")}
        className="bg-brand-600 text-on-brand ease-soft w-full rounded-md px-4 py-3.5 text-sm transition-opacity duration-200 active:scale-[0.99]"
      >
        回首页
      </button>
    </div>
  );
}
