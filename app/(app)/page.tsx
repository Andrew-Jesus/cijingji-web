"use client";

/**
 * `/` —— 首页 / 今日任务单（方案 §7.4）
 *
 * 阶段 0 的两条硬要求：
 *   1. **首屏不等网络** —— 数据全在本地 IndexedDB，天然满足（阶段 2 的验收项）。
 *   2. **断网可用** —— 同上。
 *
 * 这一页**不自己装配任务单**：装配收在 `assembleTodayPlan` 一处，
 * 首页 / 结果页 / 学习页跑的是同一条流水线，所以三个地方说的数字永远一样。
 *
 * ════════════════════════════════════════════════════════════════
 * 2026-11-01 · 「极简化 / 科技化 / 动态化」重排
 *
 * 改版前这一屏有 16 块文字，但真正的动作只有两个：看今天几个词、点开始。
 * 剩下 14 块全是**解释**，而且有一半是写给我自己看的
 * （「点开就是第一个词，中途退出没关系」「改时长会重新排今天这一单」）。
 * 一个用户第二次看到这些话，它就不再是信息，是噪音。
 *
 * 所以这一版做的是**搬家，不是删内容**：
 *   · 「会怎么练」的四行参数、「数据说明」的两段话、「改我的情况」、「退出」
 *     → 全部收进右上角的「···」；
 *   · 页脚只留一行「词库与参数仍在完善」，点得开、看得见 ——
 *     「数据不完美要如实说」这条硬约束没有取消，只是不再占着首屏。
 *
 * 三条视觉决定，改之前先看理由：
 *   ① **进度环 → 细进度线**。环是"柔"的（它是治愈系的表情），
 *      线是"准"的（它是仪表的表情）。同一件事，两种语气。
 *   ② **大数字用等宽字**（`font-mono` + `tabular-nums`）。这不是装饰：
 *      比例字在数字从 0 数到 20 的过程中，整行会左右抖；等宽字纹丝不动。
 *      动态一旦建立在会抖的基础上，就只剩"晃"，没有"动"。
 *   ③ **交错入场**（`data-stagger`）：六个块依次落位，间隔 55ms。
 *      一次性整块淡入读起来是"页面加载完了"；依次落位读起来是"它在上菜"。
 *
 * ⚠️ 底衬 `bg-feature` 从暖砂换成了极淡钢蓝 —— 这**推翻了 2026-10-02 的硬规则**，
 * 但那条规则的理由（"暖白页面上放冷色会发青"）随底色一起失效了。
 * 详见 globals.css 顶部那段说明，别只看结论。
 * ════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState } from "react";
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
   * "开始"直接跳到 `/study/<它>`，学习页再用同一天的任务单把自己装满。
   * 用日期当 id 的好处：刷新、重进、明天再来，都不会出现"两份今天的单子"。
   */
  sessionId: string;
  /** "11月1日 周日"。只在客户端算 —— 服务端与客户端可能跨时区差一天。 */
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
  /** 「···」面板：装的全是低频但必须可查的东西（练习方式、数据说明、改设置、退出） */
  const [moreOpen, setMoreOpen] = useState(false);
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
            todayLabel: `${now.getMonth() + 1}月${now.getDate()}日 周${"日一二三四五六"[now.getDay()]}`,
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

  /** 进度线走多满（0~100）。分母为 0 时给 0，不给 NaN —— 那会让整条线消失 */
  const progressPct =
    state.status === "ready" && state.data.perDay > 0
      ? Math.min(100, Math.round((state.data.doneToday / state.data.perDay) * 100))
      : 0;

  return (
    // pb-24 而不是 pb-12：左下角常驻着小词（44px 高 + 20px 边距），
    // 底部留白不够的话，滚到最后一行时球会压住文字。
    <main className="relative mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-5 pb-24">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-primary text-[15px] leading-none font-medium tracking-[-0.01em]">
          词径记
        </h1>
        {/* 原来这里是两条文字链（"改我的情况 / 退出"）+ 页尾两段说明。
            它们没有消失，只是**搬进这个点里面** —— 首屏上的动作越少，剩下的那个越清楚。 */}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-label="更多"
          className="text-tertiary hover:text-primary ease-snap -mr-1.5 flex h-9 w-9 items-center justify-center rounded-sm transition-colors duration-140"
        >
          <Dots />
        </button>
      </header>

      {state.status === "loading" && (
        <p className="text-tertiary py-20 text-center font-mono text-[11px] tracking-[0.12em]">
          读取本机词库
        </p>
      )}

      {state.status === "error" && (
        <div className="border-danger-600/25 bg-danger-50 rounded-md border p-4">
          <p className="text-primary text-sm font-medium">没能排今天的任务</p>
          <p className="text-secondary mt-1 text-xs break-words">{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <div data-stagger className="flex flex-col gap-2.5">
          {/* ① 主卡：今天的量。整页唯一的视觉重心 */}
          <section className="bg-feature rounded-lg px-5 pt-5 pb-5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-secondary pt-1 font-mono text-[11px] tracking-[0.06em] tabular-nums">
                {state.data.todayLabel}
              </p>
              {/* 时长入口做成一枚只有数字的方牌：它是"参数"，不是"步骤"。
                  写「这次 25 分钟」会跟下面那行「约 12 分钟」撞车，读者要在两个
                  分钟数之间做一次换算 —— 极简的第一条就是**别让人比较**。
                  （下面那行"约 X 分钟"已经删掉了：预算和预计本来就该是同一个数，
                  两个并排只会让人以为哪里对不上。） */}
              <button
                type="button"
                onClick={() => setBudgetOpen((v) => !v)}
                aria-expanded={budgetOpen}
                aria-label={`这次 ${state.data.budgetMinutes} 分钟，点开调整`}
                className={`ease-snap -mt-0.5 -mr-1 flex shrink-0 items-center gap-1 rounded-sm border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors duration-140 ${
                  budgetOpen
                    ? "border-brand-600 text-brand-800 bg-surface"
                    : "border-strong/60 text-secondary hover:border-strong"
                }`}
              >
                {state.data.budgetMinutes} 分钟
                <ChevronDown />
              </button>
            </div>

            <p className="text-brand-800 mt-5 flex items-baseline gap-2 font-mono text-[4rem] leading-[0.8] font-medium tracking-[-0.05em]">
              <CountUp value={state.data.perDay} />
              <span className="text-secondary font-sans text-[13px] leading-none font-normal tracking-normal">
                个词
              </span>
            </p>

            {/* 进度线：比进度环"准"。环是柔感的表情，线是仪表的表情。
                ⚠️ 高度 3px、底色半透明那一版在真机上几乎看不见（截图里就是一条空白）——
                指示器看不见，等于没有。**未完成那一截必须是实色的。** */}
            <div
              className="mt-6 flex items-center gap-3"
              role="img"
              aria-label={`今日进度：${state.data.doneToday} / ${state.data.perDay}`}
            >
              <div className="bg-strong h-1 flex-1 overflow-hidden rounded-full">
                <div
                  className="bg-brand-600 ease-soft h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-secondary shrink-0 font-mono text-[11px] tabular-nums">
                {state.data.doneToday}/{state.data.perDay}
              </span>
            </div>

            {/* 主按钮：深墨实体键，不是饱和蓝。
                一整块 100% 宽的蓝，视觉重量压过整页所有内容 —— 页面会读成
                "一个蓝按钮配了一点字"。深墨安静，但按下去有分量。
                蓝色只剩两个落点（大数字、进度条），这就是"一屏一个彩色"。 */}
            <button
              type="button"
              onClick={() => router.push(`/study/${state.data.sessionId}`)}
              className="bg-cta text-on-ink ease-snap mt-6 w-full rounded-md px-4 py-3.5 text-sm font-medium transition-[background-color,transform] duration-140 hover:bg-cta-hover active:scale-[0.985]"
            >
              {state.data.doneToday > 0 ? "继续" : "开始"}
            </button>
          </section>

          {/* 挡位条：展开在卡内，不遮挡、不跳页。选完立即重排 ——
              用户此刻就知道"时间不够就少练点"，不用去设置页翻。 */}
          {budgetOpen && (
            <section className="border-subtle bg-surface rounded-lg border p-4">
              <div className="grid grid-cols-5 gap-1.5">
                {BUDGET_TIER_MINUTES.map((m) => {
                  const on = state.data.budgetMinutes === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => pickBudget(m)}
                      aria-pressed={on}
                      className={`ease-snap rounded-sm border py-2.5 text-center font-mono text-[11px] tabular-nums transition-colors duration-140 ${
                        on
                          ? "border-brand-600 bg-brand-50 text-brand-800 font-medium"
                          : "border-subtle text-secondary hover:border-strong"
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={toggleCustom}
                  aria-pressed={customActive}
                  className={`ease-snap rounded-sm border py-2.5 text-center text-[11px] transition-colors duration-140 ${
                    customActive
                      ? "border-brand-600 bg-brand-50 text-brand-800 font-medium"
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
                    className="border-subtle text-primary w-16 rounded-sm border px-2 py-1.5 font-mono text-[11px] tabular-nums"
                  />
                  <span className="text-secondary text-[11px]">分钟</span>
                  <button
                    type="button"
                    onClick={applyCustom}
                    className="bg-brand-600 text-on-brand ease-snap rounded-sm px-3 py-1.5 text-[11px] font-medium transition-[opacity,transform] duration-140 active:scale-[0.985]"
                  >
                    照这个排
                  </button>
                </div>
              )}

              {/* 时长给得特别长时，词量会被「一天最多多少个」这道安全阀截住 ——
                  不说清楚，用户会以为时长没生效。只在真被截住时才出现。 */}
              {state.data.budgetMinutes - state.data.perDayMinutes >= 3 && (
                <p className="text-tertiary mt-2.5 text-[11px] leading-relaxed">
                  一天最多 {LIMITS.daily_cap} 个词，这一单实际约 {state.data.perDayMinutes} 分钟。
                </p>
              )}
            </section>
          )}

          {/* ② 今天从哪几个词开始。单元的入口就在这一行的标题上 ——
              「我今天想背 Unit 3」是个真实动作，不该藏在设置里。 */}
          <section className="border-subtle bg-surface overflow-hidden rounded-lg border">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
              className="ease-snap flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-140 hover:bg-sunken/40"
            >
              <span className="text-secondary min-w-0 flex-1 truncate text-[11px] tracking-[0.04em]">
                {state.data.unitLabel}
              </span>
              <span className="text-tertiary flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
                {state.data.totalInUnit}
                <ChevronRight />
              </span>
            </button>
            <ul className="divide-subtle divide-y">
              {state.data.firstWords.map((w) => (
                <li
                  key={w.word_id}
                  className="grid grid-cols-[minmax(0,6.75rem)_1fr] items-baseline gap-x-4 px-4 py-2.5"
                >
                  {/* 英文词走等宽：它本来就是"一串字母"，等宽让首字母对齐成一条直线 */}
                  <span className="text-primary truncate font-mono text-[13px]">{w.lemma}</span>
                  <span className="text-secondary truncate text-[12px]">{w.meaning_zh}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ③ 另外两条路。并排两块，而不是两条整行卡片 ——
              整行卡片每个要吃掉 80px 高度，换来的信息只有八个字。 */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => router.push("/review")}
              className="border-subtle bg-surface hover:border-strong ease-snap flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3.5 text-left transition-colors duration-140"
            >
              <span className="text-primary text-[13px]">错题</span>
              <span className="text-tertiary text-[11px]">按错因归类</span>
            </button>
            <button
              type="button"
              onClick={() => router.push("/cloze")}
              className="border-subtle bg-surface hover:border-strong ease-snap flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3.5 text-left transition-colors duration-140"
            >
              <span className="text-primary text-[13px]">完形</span>
              <span className="text-tertiary text-[11px]">把词放进文章</span>
            </button>
          </div>

          {/* ④ 一条永远看得见的底线，点得开。
              「数据不完美要如实说」没有取消 —— 只是把那段话从首屏搬到了它该在的地方：
              用户想核对的时候找得到，不想看的时候不挡路。
              **这一行不许删。** 它撑着的不只是一个链接，是这个产品对数据的态度。 */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="text-secondary hover:text-primary ease-snap mt-1 self-start px-0.5 py-1 text-[11px] underline-offset-4 transition-colors duration-140 hover:underline"
          >
            词库与练习参数仍在完善 · 详情
          </button>
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

      {/* 「···」面板：所有低频信息都在这里 */}
      {moreOpen && (
        <MoreSheet
          onClose={() => setMoreOpen(false)}
          onEditProfile={() => router.push("/onboarding")}
          summary={state.status === "ready" ? state.data.summary : null}
          plan={
            state.status === "ready"
              ? [
                  { label: "目标", value: state.data.goalLabel },
                  { label: "每天", value: `${state.data.dailyMinutes} 分钟` },
                  {
                    label: "兴趣",
                    value:
                      state.data.interests.length > 0
                        ? state.data.interests.map(interestLabel).join("、")
                        : "还没选",
                  },
                  { label: "起点", value: state.data.level ? `第 ${state.data.level} 档` : "未测" },
                ]
              : []
          }
          unsupportedGoal={
            state.status === "ready" && !state.data.goalSupported ? state.data.goalLabel : null
          }
        />
      )}
    </main>
  );
}

/**
 * 数字从 0 数到目标值。
 *
 * 为什么值得写 20 行：这一屏唯一会变的数是它。静态地"啪"一下出现 20，
 * 页面是死的；从 0 滚到 20，用户读到的信息是**"今天这一单是刚排好的"** ——
 * 这是真信息，不是装饰。反过来说，**不要给不会变的东西加动效**（标题、说明、图标）。
 *
 * 三条约束：
 *   · 降级（`data-motion="reduced"`）直接给终值 —— 不演，但也不给 0；
 *   · 初值就是 0，SSR 与首帧一致，不会水合打架；
 *   · 曲线用 easeOutQuart：开头快、结尾几乎不动，落位比线性干净。
 */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (document.documentElement.dataset.motion === "reduced") {
      /* 降级时直接给终值，但**推一帧再给** —— 在 effect 体内同步 setState 会触发
         级联渲染（eslint 的 react-hooks/set-state-in-effect 拦的就是这个）。
         一帧 16ms，人眼读不出延迟，数字也不会停在 0。 */
      const raf = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(raf);
    }
    const DURATION = 620;
    const started = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min((t - started) / DURATION, 1);
      setShown(Math.round(value * (1 - (1 - k) ** 4)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{shown}</>;
}

/** 三个点 —— 「更多」的符号。手画，禁 emoji 是产品级约束 */
function Dots() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
      <circle cx="3" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="13" cy="8" r="1.35" />
    </svg>
  );
}

/** 一个朝下的细箭头 —— 「这一行可以点」的标记。手画的：为一个 2.5px 的箭头引图标库不划算 */
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

/** 朝右的细箭头 —— 与 `ChevronDown` 同一套笔画参数，只是转了方向 */
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
 * 「···」面板。从右上角展开，浮在内容之上。
 *
 * 里面装的全是**低频但必须可查**的东西：练习方式、四个参数、数据说明、改设置、退出。
 * 判断一条信息该不该留首屏，只有一把尺子：
 * **用户每天要因为它做一个决定吗？** 要 → 留在屏幕上；不要 → 搬到这里。
 *
 * 面板一出就占了半个屏幕，所以点空白处要能关掉 —— 但**不能靠 escdismiss 那种花活**，
 * 一层透明遮罩最稳（移动端没有 Esc 键）。
 */
function MoreSheet({
  onClose,
  onEditProfile,
  summary,
  plan,
  unsupportedGoal,
}: {
  onClose: () => void;
  onEditProfile: () => void;
  summary: string | null;
  plan: { label: string; value: string }[];
  unsupportedGoal: string | null;
}) {
  return (
    <>
      {/* 遮罩：点掉关面板。z-30 在面板之下、正文之上。
          0.18 那版在真机上几乎不起作用 —— 背景照样清楚，"浮起来"这件事没发生。
          遮罩不是为了好看，是为了**让后面那层退到背景里**。 */}
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        aria-hidden
        style={{ background: "rgb(22 26 34 / 0.26)" }}
      />
      <div
        role="dialog"
        aria-label="更多"
        data-animated
        data-rise="down"
        className="border-subtle bg-surface absolute top-16 right-5 z-40 max-h-[calc(100dvh-6rem)] w-[17.5rem] overflow-y-auto rounded-lg border p-4 shadow-[0_16px_40px_-20px_rgb(22_26_34/0.35)]"
      >
        {summary && (
          <>
            <p className="text-tertiary font-mono text-[10px] tracking-[0.14em]">会怎么练</p>
            <p className="text-secondary mt-2 text-[12px] leading-relaxed">{summary}</p>
            <dl className="border-subtle mt-3 space-y-1.5 border-t pt-3">
              {plan.map((row) => (
                <div key={row.label} className="flex gap-3 text-[11px]">
                  <dt className="text-tertiary w-9 shrink-0">{row.label}</dt>
                  <dd className="text-secondary min-w-0 flex-1">{row.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {unsupportedGoal && (
          <p className="text-tertiary border-warning-600/30 mt-3 border-l-2 pl-2.5 text-[11px] leading-relaxed">
            你选了「{unsupportedGoal}」，我们还没收录 —— 现在按中考的方案安排，等你要用时再补上。
          </p>
        )}

        {/* 数据说明用原生 <details> 折叠 —— 零 JS、零状态、点一下展开。
            摘要那一行是**结论**（"逐条核过、参数是默认值"），展开才是全文。
            这样它既不是"藏起来"（结论一直在），也不是"糊一墙字"（打开面板时看不到全文）。
            ⚠️ 别改成默认展开：一展开，这个面板就又变成改版前那个"两段说明"。 */}
        <details className="border-subtle group mt-3 border-t pt-3">
          <summary className="ease-snap flex cursor-pointer list-none items-baseline justify-between gap-2 transition-colors duration-140 [&::-webkit-details-marker]:hidden">
            <span className="text-tertiary font-mono text-[10px] tracking-[0.14em]">数据说明</span>
            <span className="text-tertiary flex items-center gap-1 text-[10px] group-open:hidden">
              三册逐条核过
              <ChevronDown />
            </span>
          </summary>
          <p className="text-tertiary mt-2 text-[11px] leading-relaxed">
            {DATA_HONEST_NOTE}
            <br />
            复习顺序按 FSRS 排：谁快忘了谁先上，答错的词会更快回来。参数是通用默认值，还没按你个人调过 ——
            比固定顺序准，但还不是为你量身调的。
          </p>
        </details>

        <div className="border-subtle mt-3 flex items-center justify-between border-t pt-3">
          <button
            type="button"
            onClick={onEditProfile}
            className="text-secondary hover:text-primary ease-snap text-[11px] underline-offset-4 transition-colors duration-140 hover:underline"
          >
            改我的情况
          </button>
          <SignOutLink />
        </div>
      </div>
    </>
  );
}
