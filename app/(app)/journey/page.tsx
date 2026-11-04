"use client";

/**
 * `/journey` —— 征途页（游戏化 · 掌控主线，规格书 §20.3.1）
 *
 * 这一页回答一个首页答不了的问题：**「698 个词，我走到哪了」**。
 * 规格书原话：698 是**资产不是负担**。多数背词软件不敢给分母（词库无限，
 * 永远学不完）；本产品词库有限且可数 —— 学完就是学完了，这是别人没有的
 * 终点感。这一页就是把这个终点摆到台面上。
 *
 * ── 数字口径（铁律：每个数字都要能回答"它代表什么记忆事实"）────
 *   · **已征服** = 爬上「熬过一次遗忘」及以上的词（isConquered，口径
 *     只在 `lib/study/milestone.ts` 一处）。判级输入是作答流水上的
 *     时间事实，不是 FSRS 的估计值 —— 数字是事实，不是算法意见。
 *   · 每个单元的进度 = 该单元词集里已征服的 / 该单元词数（placement
 *     按 word_id 去重 —— 一个词在同一单元可能有多条归属记录）。
 *   · 顶部总账 = 全库词的征服数。**格子加起来可能略大于总账**：
 *     跨单元的词在两格里都算，总账只算一次。这是事实的两面，不是 bug；
 *     但如果哪天差得多，先查 placements 的覆盖，别急着改口径。
 *
 * ── v1 的边界（故意做小）──────────────────────────────────
 *   · 单元行**不可点**：这一页只负责"看全局"，跳去练某个单元是首页
 *     换单元抽屉的事 —— 两个入口会让人不知道"从哪换"。
 *   · 没有四级分布图：格子只画"征服率"一个数。四级名字出现在总账
 *     卡的口径说明里，想看每级多少人属于"低频但必须可查"，
 *     等真有人问了再加 —— 极简 = 砍信息不是砍字号。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { db } from "@/lib/db/local";
import { getProfile, isOnboarded } from "@/lib/db/repo";
import { ensureSeeded } from "@/lib/db/seed";
import { loadReviewLogs } from "@/lib/db/studyRepo";
import { isConquered, milestonesByWord } from "@/lib/study/milestone";
import { unitDisplayLabel } from "@/lib/scope/schema";

/** 与首页 `TERM_RANK` 同一个排序口径：年级升序，同年级上册在前 */
const TERM_RANK: Record<string, number> = { 上: 0, 下: 1, 全: 2 };

interface UnitRow {
  id: string;
  label: string;
  /** 该单元词数（去重后）。这是分母 —— 真数，不是拍出来的 */
  total: number;
  /** 其中已征服的词数 */
  conquered: number;
}

interface VolumeGroup {
  id: string;
  title: string;
  units: UnitRow[];
}

interface JourneyData {
  /** 全库词数 —— 总账分母 */
  totalWords: number;
  /** 全库已征服 —— 总账分子 */
  conqueredWords: number;
  groups: VolumeGroup[];
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: JourneyData };

export default function JourneyPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

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

        await ensureSeeded(db);
        const [units, words, placements, volumes, reviewLogs] = await Promise.all([
          db.units.toArray(),
          db.words.toArray(),
          db.word_placements.toArray(),
          db.volumes.toArray(),
          loadReviewLogs(),
        ]);
        if (cancelled) return;

        // 全量流水一次判完：word_id → 台阶。几千条流水毫秒级（首页已经
        // 在全量重放 FSRS，这不是新的性能点）。
        const milestones = milestonesByWord(reviewLogs);

        // 每个单元的词集（placement 按 word_id 去重 —— 一词多归属只算一个词）
        const wordIdsByUnit = new Map<string, Set<string>>();
        for (const p of placements) {
          const set = wordIdsByUnit.get(p.unit_id);
          if (set) set.add(p.word_id);
          else wordIdsByUnit.set(p.unit_id, new Set([p.word_id]));
        }

        const groups: VolumeGroup[] = [...volumes]
          .sort((a, b) => a.grade_num - b.grade_num || TERM_RANK[a.term] - TERM_RANK[b.term])
          .map((v) => ({
            id: v.id,
            // 组头用册名（「八年级上册」），与首页换单元抽屉同一口径 ——
            // 用书名的话三册三组头顶着同一行「外研社版 初中英语（2024 版）」，纯重复
            title: v.grade_label,
            units: units
              .filter((u) => u.volume_id === v.id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((u) => {
                const set = wordIdsByUnit.get(u.id) ?? new Set<string>();
                let conquered = 0;
                for (const wid of set) {
                  const m = milestones.get(wid);
                  if (m && isConquered(m)) conquered++;
                }
                return {
                  id: u.id,
                  label: unitDisplayLabel(v, u),
                  total: set.size,
                  conquered,
                };
              }),
          }))
          .filter((g) => g.units.some((u) => u.total > 0));

        // 总账：全库词里爬上征服级的。没查到台阶的词 = 还没交手，天然不算。
        let conqueredWords = 0;
        for (const w of words) {
          const m = milestones.get(w.id);
          if (m && isConquered(m)) conqueredWords++;
        }

        if (cancelled) return;
        setState({
          status: "ready",
          data: { totalWords: words.length, conqueredWords, groups },
        });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ status: "error", message });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    // pb-20 与首页同一口径：左下角常驻小词，留白不够会压住最后一行
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
      <header className="mb-7">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="text-tertiary hover:text-secondary -ml-1 rounded-sm px-1 py-1 text-xs transition-colors"
        >
          回今天
        </button>
        <h1 className="text-primary mt-2 text-lg leading-none font-medium">征途</h1>
        <p className="text-secondary mt-2 text-xs leading-relaxed">
          这些数字从你本机的作答记录里数出来的：隔了三天以上还记得，才算征服。
        </p>
      </header>

      {state.status === "loading" && (
        <p className="text-tertiary py-20 text-center text-[11px] tracking-[0.12em]">读取本机词库</p>
      )}

      {state.status === "error" && (
        <div className="border-danger-600/25 bg-danger-50 rounded-md border p-4">
          <p className="text-primary text-sm font-medium">征途读不出来</p>
          <p className="text-secondary mt-1 text-xs break-words">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <div data-stagger className="flex flex-col gap-2.5">
          {/* 总账卡：这一页唯一的视觉重心，与首页主卡同一套白卡描边 */}
          <section className="border-subtle bg-surface rounded-[26px] border px-5 pt-5 pb-5">
            <p className="text-secondary text-[11px] tracking-[0.06em]">已征服</p>
            <p className="text-brand-800 mt-3 flex items-baseline gap-2 text-[3rem] leading-none font-semibold tracking-[-0.03em]">
              {state.data.conqueredWords}
              <span className="text-secondary font-sans text-[13px] leading-none font-normal tracking-normal">
                / {state.data.totalWords} 词
              </span>
            </p>
            <div
              className="bg-strong/50 mt-4 h-1.5 overflow-hidden rounded-full"
              role="progressbar"
              aria-label="全词库征服进度"
              aria-valuemin={0}
              aria-valuemax={state.data.totalWords}
              aria-valuenow={state.data.conqueredWords}
            >
              <div
                className="bg-brand-600 ease-soft h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${
                    state.data.totalWords > 0
                      ? Math.min(100, (state.data.conqueredWords / state.data.totalWords) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
            <p className="text-tertiary mt-3 text-[11px] leading-relaxed">
              征服的意思：它以前打败过你，现在你赢了 —— 隔了三天以上还记得它。
            </p>
          </section>

          {/* 18 个单元，按册分组。格子只画一个数（征服率）——
              四级分布属于"低频但必须可查"，等真有人问了再加。 */}
          {state.data.groups.map((g) => (
            <section key={g.id} className="border-subtle bg-surface overflow-hidden rounded-lg border">
              <p className="text-tertiary border-subtle border-b px-4 py-2.5 text-[10px] tracking-[0.14em]">
                {g.title}
              </p>
              <ul className="divide-subtle divide-y">
                {g.units.map((u) => {
                  const pct = u.total > 0 ? Math.round((u.conquered / u.total) * 100) : 0;
                  return (
                    <li key={u.id} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-primary min-w-0 flex-1 truncate text-[13px]">{u.label}</span>
                        <span className="text-secondary shrink-0 text-[11px] tabular-nums">
                          {u.conquered} / {u.total}
                        </span>
                      </div>
                      <div
                        className="bg-strong/50 mt-2 h-1 overflow-hidden rounded-full"
                        role="progressbar"
                        aria-label={`${u.label} 征服进度`}
                        aria-valuemin={0}
                        aria-valuemax={u.total}
                        aria-valuenow={u.conquered}
                      >
                        <div
                          className="bg-brand-600 h-full rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          <p className="text-tertiary mt-1 px-0.5 text-[11px] leading-relaxed">
            想练哪个单元，回首页点今天的单元就能换。
          </p>
        </div>
      )}
    </main>
  );
}
