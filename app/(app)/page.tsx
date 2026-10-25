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
 * ── 2026-10-02：从「一本书」到「三本书」────────────────────────────
 * 八下 / 九上进来之后，`volumes` 里不再只有一条记录，所以选择抽屉改成
 * **按册分组**（见 lib/scope/selection.ts 与 components/scope/UnitPicker.tsx）。
 * 首页自身的逻辑一行没变 —— 它只认「当前这一条 unit 记录」，
 * 换册次和换单元走的是同一条路：改 `selectedUnitId`，整个 effect 重跑一遍。
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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { SignOutLink } from "@/components/auth/SignOutLink";
import { UnitPicker, type UnitGroup, type UnitOption } from "@/components/scope/UnitPicker";
import { pushNotice, setTodayProgress } from "@/lib/console/store";
import { db } from "@/lib/db/local";
import { getProfile, isOnboarded } from "@/lib/db/repo";
import { DATA_HONEST_NOTE, ensureSeeded } from "@/lib/db/seed";
import {
  deriveWeakWordIds,
  loadMemoryMap,
  loadReviewLogs,
  saveDailyPlan,
  todayKey,
} from "@/lib/db/studyRepo";
import { findGoal, interestLabel, isGoalSupported } from "@/lib/onboarding/questions";
import { countDoneInPlan } from "@/lib/plan/todayProgress";
import { assembleTodayPlan } from "@/lib/plan/todayPlan";
import {
  BUDGET_TIER_MINUTES,
  CUSTOM_MINUTE_MAX,
  CUSTOM_MINUTE_MIN,
  clampMinutes,
  isTierMinutes,
} from "@/lib/plan/timeBudget";
import { resolveBudgetMinutes, writeBudgetMinutes } from "@/lib/plan/timeBudgetStore";
import { resolveScope } from "@/lib/scope/resolveScope";
import { LIMITS, defaultScope, scopeForUnit, unitDisplayLabel } from "@/lib/scope/schema";
import { selectUnit, useSelectedUnitId } from "@/lib/scope/selection";

interface HomeData {
  perDay: number;
  perDayMinutes: number;
  /**
   * 这次选了多少分钟。**不是** `dailyMinutes`（画像里"每天多少分钟"）——
   * 后者是"我的日常节奏"，进库上云；这个是"这一次我有多少时间"，只在本机。
   * 两个都在页面上，但语义不同，别合并。
   */
  budgetMinutes: number;
  /** 今天已经练过多少个不同的词。B3 有学习页之前它恒为 0，但通路是通的 */
  doneToday: number;
  brief: string;
  summary: string;
  unitLabel: string;
  totalInUnit: number;
  /** 可选的单元，**按册分组**（选择抽屉里的每一组 / 每一行）。词数与 `totalInUnit` 同一个口径 */
  unitGroups: UnitGroup[];
  /** 这是哪套书，如「外研社版 初中英语（2024 版）」 —— 抽屉顶部要说清 */
  volumeLabel: string;
  /** 当前选中的单元 id（抽屉据此标出"现在就是它"） */
  currentUnitId: string;
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

/** 册次顺序：年级升序，同年级上册在前。与 `scripts/build-seed.mjs` 的册次排序同一口径 */
const TERM_RANK: Record<string, number> = { 上: 0, 下: 1, 全: 2 };

export default function HomePage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  /**
   * 用户选的单元（只存本机，见 lib/scope/selection.ts）。
   *
   * 它一变，下面那个 effect 就重跑 —— 「换单元」不需要另写一套刷新逻辑，
   * 把同样的流水线对着新范围再跑一遍，就是全部要做的事。
   */
  const selectedUnitId = useSelectedUnitId();
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 这次选了多少分钟。`null` = 还没选过 → 走 `resolveBudgetMinutes`（上次的 / 时段推断）。
   *
   * 为什么放在 state 而不是直接读 localStorage：它一变，下面那个 effect 就重跑 ——
   * 「改时长」不需要另写一套重排逻辑，把同一条流水线对着新预算再跑一遍就是全部。
   * 落盘交给 `writeBudgetMinutes`，本机记住下次用。
   */
  const [budget, setBudget] = useState<number | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  /**
   * 小词那条通知只在"换单元 / 换天"时播一次。
   * 不加这一层，用户来回点四个挡位就会看到四条一模一样的通知 —— 刷屏比不播更糟。
   */
  const announcedRef = useRef<string | null>(null);

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
        // 判定时刻只取一次，往下全用它 —— 排课、今日进度、日期标签必须是同一个"现在"。
        // 取两次的后果：跨零点那一秒里，排课按今天算、进度按昨天算。
        const now = new Date();
        const [units, words, senses, placements, volumes, curricula, goalProfiles, reviewLogs, memory] =
          await Promise.all([
            db.units.toArray(),
            db.words.toArray(),
            db.senses.toArray(),
            db.word_placements.toArray(),
            // 册次与课程体系：只用来给用户看"这是哪本书 / 哪个单元"，
            // 以及给范围描述提供 id（见 scopeForUnit）。
            db.volumes.toArray(),
            db.curricula.toArray(),
            db.goal_profiles.toArray(),
            // 走仓库层，不直接读表 —— 它只返回**属于当前用户**的作答记录。
            // 直接读全表会让"今日已练"把上一个人在这台设备上留下的记录也算进来。
            loadReviewLogs(),
            // 每个词的记忆状态。**读不出状态就等于"没有复习"这件事**，
            // 所以这一项不能省 —— 老用户第一次跑时会在这里自愈回填（见 loadWordMemories）。
            loadMemoryMap(),
          ]);
        const snapshot = { units, words, senses, placements };

        const goalProfile = goalProfiles.find((p) => p.goal_code === "zhongkao");
        if (!goalProfile) throw new Error("本地库缺少 goal_profiles（中考）配置");

        // ── 今天学哪个单元 ─────────────────────────────────────────
        // 优先用用户选过的那个；没选过、或选过的已不在库里（例如换了册次）→ 回落默认单元。
        // 回落是静默的，但**绝不编造**：库里没有的 unit id 不会被当成有效选择。
        const unitById = new Map(units.map((u) => [u.id, u]));
        const selected = selectedUnitId ? unitById.get(selectedUnitId) : undefined;
        const fallbackUnitId = defaultScope().include[0]?.units?.[0];
        const currentUnit =
          selected ?? (fallbackUnitId ? unitById.get(fallbackUnitId) : undefined) ?? units[0];
        if (!currentUnit) throw new Error("本地库缺少单元数据（ensureSeeded 没跑成功？）");

        const currentVolume = volumes.find((v) => v.id === currentUnit.volume_id);
        if (!currentVolume) throw new Error(`本地库缺少册次 ${currentUnit.volume_id}`);

        // 范围只由「这一条单元记录」决定 —— 课程 / 册次 id 都取自记录本身，
        // 不在页面里另写字面量（换教材 / 换册次时这个文件一行都不用改）。
        const scope = scopeForUnit(currentVolume, currentUnit);

        // 错词本：从 review_logs 派生 —— "最后一次没答对"的词，最近的排前面。
        // 这是阶段 0 里"复习"这件事的**全部**实现（真正的间隔调度归阶段 2 的 FSRS）。
        const weakWordIds = await deriveWeakWordIds();

        // 「这次有多少时间」：用户点了挡位就用他的选择，否则按上次的 / 时段推断。
        // 注意它只是**换了个每日词量的分母**，排课规则（到期优先、新词上限）一点没变。
        const budgetMinutes = budget ?? resolveBudgetMinutes(profile.daily_minutes);

        // 装配口径收在 assembleTodayPlan 一处：首页 / 结果页 / 学习页跑的是同一条流水线，
        // 所以"每天几个词"这三个地方永远说得一样。
        const assembled = assembleTodayPlan({
          snapshot,
          goalProfile,
          dailyMinutes: budgetMinutes,
          weakWordIds,
          scope,
          // 传了 clock 才走"到期优先"。不传就是老排法 —— 那是给测试和
          // "状态读不出来"的降级场景留的路，页面这里必须传。
          clock: { memory, now },
        });
        if (!assembled.ok) throw new Error(`[${assembled.code}] ${assembled.message}`);

        // 选择抽屉里的每一行。词数**走同一个 resolveScope**，
        // 所以抽屉里写"48 词"、选完首页也一定写 48 —— 两处只有一个口径。
        // 一个词都没解析出来的单元不列出来：点了只会得到一张空任务单。
        const volumeLabel =
          curricula.find((c) => c.id === currentVolume.curriculum_id)?.display_name ??
          currentVolume.grade_label;
        const unitGroups: UnitGroup[] = [...volumes]
          .sort((a, b) => a.grade_num - b.grade_num || TERM_RANK[a.term] - TERM_RANK[b.term])
          .map((v) => ({
            id: v.id,
            title: v.grade_label,
            options: units
              .filter((u) => u.volume_id === v.id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .flatMap((u) => {
                const resolved = resolveScope(scopeForUnit(v, u), snapshot);
                if (!resolved.ok) return [];
                return [
                  { id: u.id, label: unitDisplayLabel(v, u), count: resolved.words.length },
                ] as UnitOption[];
              }),
          }))
          .filter((g) => g.options.length > 0);

        const plan = assembled.plan;
        const goalOption = findGoal(profile.goal);
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
        // 排好了就往小词报一声 —— 用户不会盯着加载过程，但翻小词时能看见。
        // 只在"换单元 / 换天"时播：改时长也会重跑这个 effect，不加判断会连着刷屏。
        const noticeSig = `${currentUnit.id}|${sessionId}`;
        if (announcedRef.current !== noticeSig) {
          announcedRef.current = noticeSig;
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
        }
        // 小词外圈那道进度环读的就是这个数。由首页写入而不是小词自己去算 ——
        // 排计划要跑一整套 resolveScope，为了一个环再跑一遍纯属浪费。
        setTodayProgress(doneToday, plan.items.length, sessionId);
        setState({
          status: "ready",
          data: {
            perDay: plan.items.length,
            perDayMinutes: plan.estimated_minutes,
            budgetMinutes,
            doneToday,
            brief: plan.brief,
            summary: goalProfile.user_facing_summary,
            unitLabel: assembled.scopeLabel,
            totalInUnit: assembled.wordsInScope,
            unitGroups,
            volumeLabel,
            currentUnitId: currentUnit.id,
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
  }, [router, selectedUnitId, budget]);

  /** 选定一个挡位：立即重排 + 本机记住。不弹窗、不跳页、不等确认 */
  function pickBudget(minutes: number) {
    const next = clampMinutes(minutes);
    setBudget(next);
    writeBudgetMinutes(next);
    setBudgetOpen(false);
    setCustomOpen(false);
  }

  /** 自定义时长。空输入不当作 0 —— `Number("") === 0`，会把它夹成 1 分钟 */
  function applyCustom() {
    const raw = customDraft.trim();
    if (raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    pickBudget(n);
    setCustomDraft("");
  }

  /** 打开自定义面板时把当前分钟数填进去 —— 让用户"改一个数"，而不是"从空框开始写" */
  function toggleCustom() {
    if (customOpen) {
      setCustomOpen(false);
      return;
    }
    setCustomDraft(state.status === "ready" ? String(state.data.budgetMinutes) : "");
    setCustomOpen(true);
  }

  /**
   * 「自定义」这一格什么时候算选中：面板开着，或者当前分钟数本来就不在四个预设里。
   * 少了后半句，选了 15 分钟之后五格全不亮 —— 用户看不出自己选的是哪个。
   */
  const customActive =
    state.status === "ready" && (customOpen || !isTierMinutes(state.data.budgetMinutes));

  return (
    // pb-20 而不是 pb-12：左下角常驻着小词（44px 高 + 20px 边距），
    // 底部留白不够的话，滚到最后一行时球会压住文字。
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-7 pb-20">
      <header className="mb-7 flex items-start justify-between gap-4">
        <h1 className="text-primary text-lg leading-none font-medium">词径记</h1>
        {/* 两个小文字链共用一份内边距，靠外层的 -mr-2 把最后一个贴到页边 ——
            这样"有没有退出"两种情况下的右边缘都是齐的 */}
        <div className="-mt-1 -mr-2 flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => router.push("/onboarding")}
            className="text-tertiary shrink-0 px-2 py-1 text-xs underline-offset-4 hover:underline"
          >
            改我的情况
          </button>
          <SignOutLink />
        </div>
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
                {/* 「这次有多少时间」的唯一入口。做成一枚可点的小字，而不是弹窗 ——
                    打开后要尽快看到词，绝不能用一次选择把人挡在外面。 */}
                <button
                  type="button"
                  onClick={() => setBudgetOpen((v) => !v)}
                  aria-expanded={budgetOpen}
                  className="text-secondary hover:text-primary ease-soft -ml-1 mt-3 flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs tabular-nums transition-colors duration-200"
                >
                  这次 {state.data.budgetMinutes} 分钟
                  <ChevronDown />
                </button>
              </div>
              <ProgressRing value={state.data.doneToday} total={state.data.perDay} />
            </div>

            {/* 挡位条：展开在卡内，不遮挡、不跳页。选完立即重排 ——
                用户此刻就知道"时间不够就少练点"，不用去设置页翻。 */}
            {budgetOpen && (
              <div className="mt-4">
                {/* 五格等宽成一行 —— 用 flex-wrap 时「自定义」会被挤到第二行，
                    看着像掉出来的。等宽也让它读起来像一排刻度，而不是五个按钮。 */}
                <div className="grid grid-cols-5 gap-1.5">
                  {BUDGET_TIER_MINUTES.map((m) => {
                    const on = state.data.budgetMinutes === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => pickBudget(m)}
                        aria-pressed={on}
                        className={`ease-soft rounded-md border px-1 py-2.5 text-center text-xs tabular-nums transition-colors duration-200 ${
                          on
                            ? "border-brand-600 bg-surface text-brand-800 font-medium"
                            : "border-subtle text-secondary hover:border-strong"
                        }`}
                      >
                        {m} 分钟
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={toggleCustom}
                    aria-pressed={customActive}
                    className={`ease-soft rounded-md border px-1 py-2.5 text-center text-xs transition-colors duration-200 ${
                      customActive
                        ? "border-brand-600 bg-surface text-brand-800 font-medium"
                        : "border-subtle text-secondary hover:border-strong"
                    }`}
                  >
                    自定义
                  </button>
                </div>

                {customOpen && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={CUSTOM_MINUTE_MIN}
                      max={CUSTOM_MINUTE_MAX}
                      value={customDraft}
                      onChange={(e) => setCustomDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyCustom();
                      }}
                      placeholder="15"
                      aria-label="自定义分钟数"
                      className="border-subtle text-primary w-16 rounded-md border px-2 py-1.5 text-xs tabular-nums"
                    />
                    <span className="text-secondary text-xs">分钟</span>
                    <button
                      type="button"
                      onClick={applyCustom}
                      className="bg-brand-600 text-on-brand ease-soft rounded-md px-3 py-1.5 text-xs font-medium transition-opacity duration-200 active:scale-[0.99]"
                    >
                      照这个排
                    </button>
                  </div>
                )}

                {/* 时长给得特别长时，词量会被「一天最多多少个」这道安全阀截住 ——
                    不说清楚，用户会以为时长没生效。 */}
                <p className="text-tertiary mt-2 text-[11px] leading-relaxed">
                  改时长会重新排今天这一单。
                  {state.data.budgetMinutes - state.data.perDayMinutes >= 3
                    ? ` 一天最多 ${LIMITS.daily_cap} 个词，所以这一单实际约 ${state.data.perDayMinutes} 分钟 —— 再多就只剩疲劳了。`
                    : ""}
                </p>
              </div>
            )}

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
            {/* flex-wrap：单元名带上课本目录的英文标题后变长了，
                窄屏上「今天从这些开始」会被挤断成"今天从这些开 / 始"。
                一行放不下就让右边的整块换到下一行，而不是把左边的字压碎。
                `max-w-full`：320px 那种极窄屏连单独一行都放不下时，让单元名在按钮内部换行，
                绝不让它撑破卡片（`shrink-0` 会阻止它自己缩，所以必须靠 max-width 兜住）。 */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-tertiary shrink-0 text-[11px] tracking-[0.08em]">今天从这些开始</p>
              {/* 这一行就是「换单元」的入口（Andy 2026-10-02 拍板 = 方案①）：
                  改动最小，也最贴真实动作（"我今天想背 Unit 3"），不用去翻设置页。
                  样式沿用原来那行文字，只多了可点的手感与一个下箭头。 */}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-haspopup="dialog"
                className="text-tertiary hover:text-secondary -mr-1 flex max-w-full shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] tabular-nums transition-colors"
              >
                {state.data.unitLabel} · 共 {state.data.totalInUnit} 词
                <ChevronDown />
              </button>
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

          {/* ③.5 两条入口（阶段 2 · B3 / 阶段 3.5 · 完形）
              放在方案摘要之后、说明之前：用户读完"今天怎么练"，
              下一个自然的念头就是"那前几天我练得怎么样"和"还有没有别的练法"。
              做成整块可点的行，而不是又一个小文字链 —— 页头已经有两条文字链了。

              完形那个入口**不预先出题**（`/cloze` 里才出）。
              首页挂在这里的意义只是"让人知道有这条路"，不该在这里就花一次 AI 调用：
              用户可能只是想看看今天练什么，点进来又退出去，那一次生成就白花了。 */}
          <button
            type="button"
            onClick={() => router.push("/review")}
            className="border-subtle bg-surface hover:border-strong ease-soft flex w-full items-center justify-between gap-3 rounded-lg border p-5 text-left transition-colors duration-200"
          >
            <span className="min-w-0">
              <span className="text-tertiary block text-[11px] tracking-[0.08em]">回头看</span>
              <span className="text-primary mt-2 block text-sm">这几天我一直在错什么</span>
            </span>
            <span className="text-tertiary shrink-0">
              <ChevronRight />
            </span>
          </button>

          <button
            type="button"
            onClick={() => router.push("/cloze")}
            className="border-subtle bg-surface hover:border-strong ease-soft flex w-full items-center justify-between gap-3 rounded-lg border p-5 text-left transition-colors duration-200"
          >
            <span className="min-w-0">
              <span className="text-tertiary block text-[11px] tracking-[0.08em]">练一篇完形</span>
              <span className="text-primary mt-2 block text-sm">把这个单元的词放进一篇文章里</span>
            </span>
            <span className="text-tertiary shrink-0">
              <ChevronRight />
            </span>
          </button>

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
            复习顺序现在按 FSRS 排：谁快忘了谁先上，答错的词会更快回来。
            这套参数是通用默认值，还没按你个人的记忆调过 —— 比固定顺序准，但还不是为你量身调的。
          </QuietNote>
        </div>
      )}

      {/* 换单元的抽屉。按钮长在 ready 分支里，所以这里不必再判一次状态 */}
      {pickerOpen && state.status === "ready" && (
        <UnitPicker
          subtitle={state.data.volumeLabel}
          groups={state.data.unitGroups}
          currentId={state.data.currentUnitId}
          onPick={(unitId) => {
            selectUnit(unitId);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </main>
  );
}

/**
 * 一个朝下的细箭头 —— 「这一行可以点」的标记。
 * 手画的：禁 emoji 是产品级硬约束，而它只有 2.5 × 2.5，为它引一整套图标库不划算。
 */
function ChevronDown() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

/**
 * 朝右的细箭头 —— 与 `ChevronDown` 同一套笔画参数，只是转了方向。
 * 仍然手画：为一个 10px 的箭头引图标库不划算（禁 emoji 是产品级约束，但这不是 emoji）。
 */
function ChevronRight() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 3 7.5 6 4.5 9" />
    </svg>
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
