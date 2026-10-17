"use client";

/**
 * `/review` —— 回顾页（阶段 2 · B3）
 *
 * 这一页只做一件事：把**最近一段时间**的作答记录汇总成能读的几句话。
 * 数据全部来自本机 `review_logs`，不联网、不调 AI、不上传。
 *
 * ── 为什么敢单独占一个路由 ───────────────────────────────────
 * 阶段 2 的硬约束是「新增路由只有 `/review` 一个」（方案 §7 第 6 条）。
 * 敢让它独立成页，是因为它回答的是一个**只有在这里才问得出口**的问题：
 * 「这几天我一直在错什么」—— 首页要回答的是"今天做什么"，
 * 学完那一屏回答的是"刚才错在哪"。三者的时间尺度不同，塞在一起会互相稀释。
 *
 * ── 三条口径（与 `lib/study/attribution.ts` 一致，改之前先读那边注释）──
 *   ① **样本不足就不给结论**：不足 `MIN_SAMPLES` 条只说"还看不出规律"；
 *   ② **每个数字都带分母**：说"8 个错里 5 个是拼写"，不裸报百分比；
 *   ③ **窗口按自然日切**（含今天），不是按毫秒刨 —— 否则总数会随打开时间漂。
 *
 * ── 为什么把两种窗口的数据一次读全 ───────────────────────────
 * 切 7 / 30 天只是换个 `filter`，没必要为了它重读一次库。
 * 但**判断"哪一天"必须用同一个 `now`** —— 各自 `new Date()` 的话，
 * 正好卡在午夜那一下，两个窗口会算出互相矛盾的天数。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { db } from "@/lib/db/local";
import { getProfile, isOnboarded } from "@/lib/db/repo";
import { ensureSeeded } from "@/lib/db/seed";
import { loadReviewLogs } from "@/lib/db/studyRepo";
import { aggregateErrors, withinLocalDays, type ErrorAttribution } from "@/lib/study/attribution";
import { errorTypeLabel } from "@/lib/study/grade";
import type { ErrorType } from "@/lib/study/types";

/** 可选的两种窗口。7 天看"这周"，30 天看"这阵子" —— 再多就得自己算日子了 */
const WINDOWS = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
] as const;

type WindowDays = (typeof WINDOWS)[number]["days"];

interface WordBrief {
  lemma: string;
  meaning_zh: string | null;
}

interface ReadyData {
  /** 按窗口分好的结果 —— 切换时零等待，也保证两个窗口用的是**同一个现在** */
  byWindow: Record<WindowDays, ErrorAttribution>;
  /** 顽固词要显示成单词，不能只给 `w:suppose` 这种内部 id */
  words: Map<string, WordBrief>;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ReadyData };

export default function ReviewPage() {
  const router = useRouter();
  const [days, setDays] = useState<WindowDays>(7);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const profile = await getProfile();
        if (cancelled) return;

        // 没走完引导就回引导页 —— 口径只认 `isOnboarded`，不在这里另写一套
        if (!profile || !isOnboarded(profile)) {
          router.replace("/onboarding");
          return;
        }

        await ensureSeeded(db);

        // 一个 `now` 贯穿全部窗口：跨午夜时才会出现的分歧不能在这里发生
        const now = new Date();
        const all = await loadReviewLogs();

        const byWindow = {
          7: aggregateErrors(withinLocalDays(all, 7, now)),
          30: aggregateErrors(withinLocalDays(all, 30, now)),
        } as Record<WindowDays, ErrorAttribution>;

        // 顽固词取 30 天那份的并集：切到 7 天时也一定有词可显示
        const ids = Array.from(
          new Set([...byWindow[7].stubborn, ...byWindow[30].stubborn].map((w) => w.word_id)),
        );
        const words = await loadWordBriefs(ids);
        if (cancelled) return;

        setState({ status: "ready", data: { byWindow, words } });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const attribution = state.status === "ready" ? state.data.byWindow[days] : null;

  return (
    // pb-20 与首页同一口径：左下角常驻小词（44px + 20px 边距），留白不够会压住最后一行
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
      <header className="mb-7">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="text-tertiary hover:text-secondary -ml-1 rounded-sm px-1 py-1 text-xs transition-colors"
        >
          回今天
        </button>
        <h1 className="text-primary mt-2 text-lg leading-none font-medium">回头看</h1>
        <p className="text-secondary mt-2 text-xs leading-relaxed">
          这些数字是从你本机的作答记录里数出来的，不联网、不调 AI。
        </p>
      </header>

      {state.status === "loading" && (
        <p className="text-secondary py-16 text-center text-sm">正在数你的作答记录…</p>
      )}

      {state.status === "error" && (
        <div className="border-danger-600/30 bg-danger-50 rounded-lg border p-4">
          <p className="text-primary text-sm font-medium">没能读出记录</p>
          <p className="text-secondary mt-1 text-xs break-words">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && attribution && (
        <div data-animated className="flex flex-col gap-3">
          {/* 窗口切换：只有两个选项，所以用一排小按钮，不引下拉 */}
          <div className="flex items-center gap-1" role="group" aria-label="时间范围">
            {WINDOWS.map((w) => {
              const active = w.days === days;
              return (
                <button
                  key={w.days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDays(w.days)}
                  className={
                    active
                      ? "bg-brand-600 text-on-brand rounded-md px-3 py-1.5 text-xs transition-colors"
                      : "text-secondary hover:text-primary border-subtle rounded-md border px-3 py-1.5 text-xs transition-colors"
                  }
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          {/* 主卡：这段时间的总体量。数字先给，说明跟在后面 */}
          <section className="bg-feature rounded-lg px-6 pt-6 pb-5">
            <p className="text-secondary text-[11px] tracking-[0.08em]">最近 {days} 天</p>
            <p className="text-brand-800 mt-3 flex items-baseline text-[2.75rem] leading-none font-medium tabular-nums">
              {attribution.total}
              <span className="text-secondary ml-2 text-sm font-normal">次作答</span>
            </p>
            <p className="text-secondary mt-3 text-xs">
              其中 {attribution.wrong} 次没答对
              {attribution.total > 0
                ? ` · ${attribution.total - attribution.wrong} 次答对`
                : ""}
            </p>
            <p className="text-secondary border-strong mt-5 border-t pt-4 text-xs leading-relaxed">
              同一个词练两遍就算两次 —— 所以这里的「次」比「词」多。
            </p>
          </section>

          {/* 错因分布 */}
          <section className="border-subtle bg-surface rounded-lg border p-5">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">错在哪</p>
            {attribution.confidence === "too_few_samples" ? (
              <>
                <p className="text-primary mt-3 text-sm leading-relaxed">
                  这 {days} 天只做了 {attribution.total} 道，还看不出规律。
                </p>
                <p className="text-secondary mt-2 text-xs leading-relaxed">
                  样本太少时下结论等于瞎猜 —— 多练几次再回来看这一块。
                </p>
              </>
            ) : attribution.wrong === 0 ? (
              <p className="text-primary mt-3 text-sm leading-relaxed">
                这 {days} 天一个都没错，没有可归因的错题。
              </p>
            ) : (
              <>
                <p className="text-primary mt-3 text-sm leading-relaxed">
                  {attribution.wrong} 个错，分别长这样：
                </p>
                <ul className="divide-subtle mt-3 divide-y">
                  {sortByCount(attribution).map((row) => (
                    <li
                      key={row.type}
                      className="flex items-baseline justify-between gap-3 py-2.5"
                    >
                      <span className="text-primary text-sm">{errorTypeLabel(row.type)}</span>
                      {/* 分母写在旁边：说「5 个」而不说「62%」，用户能自己对上号 */}
                      <span className="text-tertiary shrink-0 text-[11px] tabular-nums">
                        {attribution.wrong} 个错里 {row.count} 个
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-tertiary mt-3 text-[11px] leading-relaxed">
                  {attribution.unclassified > 0
                    ? `另有 ${attribution.unclassified} 个错没记清原因，没有算进上面。`
                    : "每一条错都记了原因，所以上面加起来正好是全部。"}
                </p>
              </>
            )}
          </section>

          {/* 顽固词：错 ≥2 次的词才是"该单独处理"的，错 1 次可能只是手滑 */}
          <section className="border-subtle bg-surface rounded-lg border p-5">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">反复错的词</p>
            {attribution.stubborn.length === 0 ? (
              <p className="text-primary mt-3 text-sm leading-relaxed">
                {/* 三种"空"的原因不同，说的也得不同 ——
                    曾经在这里把所有空都写成「错的都是一次性的」，
                    结果零错题时也这么讲，等于凭空说用户错过。 */}
                {attribution.confidence === "too_few_samples"
                  ? "练得还太少，暂时看不出哪个词在反复错。"
                  : attribution.wrong === 0
                    ? `这 ${days} 天没有错词，也就没有要单独盯的词。`
                    : `这 ${days} 天没有反复错的词 —— 错的都是一次性的。`}
              </p>
            ) : (
              <>
                <p className="text-primary mt-3 text-sm leading-relaxed">
                  这 {attribution.stubborn.length} 个词错了不止一次：
                </p>
                <ul className="divide-subtle mt-3 divide-y">
                  {attribution.stubborn.map((w) => {
                    const brief = state.data.words.get(w.word_id);
                    return (
                      <li key={w.word_id} className="py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          {/* 查不到就显示 id 的尾巴 —— 宁可露出内部 id，也不留一个空位 */}
                          <span className="text-primary truncate text-sm">
                            {brief?.lemma ?? w.word_id.replace(/^w:/, "")}
                          </span>
                          <span className="text-tertiary shrink-0 text-[11px] tabular-nums">
                            错 {w.wrong} 次 / 共答 {w.attempts} 次
                          </span>
                        </div>
                        {brief?.meaning_zh ? (
                          <p className="text-secondary mt-1 text-xs leading-relaxed">
                            {brief.meaning_zh}
                          </p>
                        ) : null}
                        {/* 错法也说出来：同一个词反复错，是"释义没记住"还是"拼不出来"，补法不一样 */}
                        {w.kinds.length > 0 && (
                          <p className="text-tertiary mt-1 text-[11px] leading-relaxed">
                            错法：{w.kinds.map((k) => errorTypeLabel(k)).join("、")}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          {/* 诚实说明：窗口口径 + 脏记录。静默吞掉会让"我练了 10 条怎么只算 7 条"没有答案 */}
          <section className="border-warning-600/40 border-l-2 py-0.5 pl-4">
            <p className="text-tertiary text-[11px] tracking-[0.08em]">关于这些数字</p>
            <p className="text-tertiary mt-2 text-xs leading-relaxed">
              「近 {days} 天」按你本机的自然日算，含今天。只统计这里存下的作答，
              换台设备、或者清了浏览器数据，旧的记录就不在这里了。
              {attribution.ignored > 0
                ? ` 另有 ${attribution.ignored} 条记录的时间坏了，没能算进来。`
                : ""}
            </p>
          </section>

          <button
            type="button"
            onClick={() => router.push("/")}
            className="border-subtle text-primary ease-soft w-full rounded-md border px-4 py-3 text-sm transition-colors duration-200 active:scale-[0.99]"
          >
            回今天
          </button>
        </div>
      )}
    </main>
  );
}

/**
 * 三类错因按条数从多到少；同分时保持固定顺序（拼写 → 释义 → 混词）。
 *
 * 只列**真的出现过**的：把 0 条的那行也画出来，用户会以为"我这一类没问题"，
 * 其实只是这次没考到过。
 */
function sortByCount(attribution: ErrorAttribution): { type: ErrorType; count: number }[] {
  return (["spelling", "meaning", "confusion"] as const)
    .map((type) => ({ type, count: attribution.byType[type].count }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * 把内部 `word_id` 换成人看得懂的「单词 + 主要释义」。
 *
 * 一次批量取，不要循环里逐条查 —— 30 个顽固词就是 60 次往返。
 * 查不到的词**不编内容**：调用方会退回显示 id 尾巴。
 */
async function loadWordBriefs(ids: string[]): Promise<Map<string, WordBrief>> {
  const map = new Map<string, WordBrief>();
  if (ids.length === 0) return map;

  const [words, senses] = await Promise.all([
    db.words.bulkGet(ids),
    db.senses.where("word_id").anyOf(ids).toArray(),
  ]);

  const primary = new Map<string, string>();
  for (const s of senses) {
    if (s.is_primary && !primary.has(s.word_id)) primary.set(s.word_id, s.cn_meaning);
  }

  for (const w of words) {
    if (!w) continue;
    map.set(w.id, { lemma: w.lemma, meaning_zh: primary.get(w.id) ?? null });
  }
  return map;
}
