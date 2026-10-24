/**
 * buildDailyPlan —— 从「一批词」到「今日任务单」
 *
 * 铁律：**纯函数，不含 AI 调用，无副作用，可单测；同输入两次结果必须一致（幂等）。**
 *
 * ── 两条路径（2026-10-24 接入 FSRS 后）──────────────────────
 * **旧路径**：不传 `clock` 时走它 —— 规则一个字没改（错词优先 → 其余按原序）。
 *   保留它的理由：现有测试和"还没接状态"的场景都靠它，而且它证明了
 *   "不接排期时产品仍然能用"。**改动旧路径 = 制造回归**，所以一行都不动。
 *
 * **新路径**：传了 `clock`（记忆状态 + 判定时刻）时走它，按到期优先取词：
 *   ① 到期词优先，按**逾期天数从多到少** —— 欠得最久的先还
 *   ② 新词受 `pace.new_ratio` 硬上限约束（防"复习雪崩"）
 *   ③ 还不够填满额度时，用"还没到期"的词按 `due` 升序补位
 *
 * ── 为什么新词要设硬上限（这条最容易被当成多余）──────────────
 * 如果只按"到期优先、剩下的全给新词"：某天到期只有 2 个词，当天就会推 22 个新词；
 * 第二天这 22 个全部变成复习，再过一天更多 —— 这叫**复习雪崩**，
 * 背单词软件里最常见的崩溃方式，用户会在第七天被一百多个待复习压垮然后卸载。
 * `new_ratio` 就是那道闸门。它不该被"今天很闲"的短期感受绕过。
 */
import { isDue, overdueDays } from "@/lib/study/memory";
import { secondsForMode } from "./estimate";
import type { WordRef } from "@/lib/scope/resolveScope";
import type { Pace, WordMemory } from "@/lib/db/types";

export interface DailyPlanItemDraft {
  word_id: string;
  sense_id: string | null;
  mode: string;
  priority_score: number;
  lemma: string;
  meaning_zh: string | null;
  unit_code: string;
  confidence: number;
}

/**
 * 记忆状态 + 判定时刻。**刻意绑成一个字段**，而不是两个平级可选参数 ——
 * 只给状态不给时刻，"到期"就没有参照物（函数只能去看真实时钟，那会破坏幂等和可测性）。
 * 绑在一起，类型上就不可能只给一半。
 */
export interface PlanClock {
  memory: ReadonlyMap<string, WordMemory>;
  now: Date;
}

export interface BuildPlanInput {
  /** 已排好序的词（来自 resolveScope） */
  words: WordRef[];
  /** 错词本里的词 id（从 review_logs 派生后传入 —— 保持本函数无 IO） */
  weak_word_ids?: string[];
  daily_cap: number;
  pace: Pace;
  /** 不传 = 旧路径（阶段 0 的简化排法） */
  clock?: PlanClock;
}

export interface BuildPlanOutput {
  items: DailyPlanItemDraft[];
  estimated_minutes: number;
  /** 一句今日提示。阶段 0 用模板，不调 AI（AI 只留给兴趣域例句那一条通路） */
  brief: string;
  breakdown: {
    /** 旧路径：错词几个、新词几个 */
    weak: number;
    fresh: number;
    /** 新路径独有：到期的几个、只是补位的几个。**旧路径不填这两项**（而不是填 0）——
     *  0 的意思是"一个都没有"，没走这条路线的意思不一样，混起来会让排查的人误判 */
    due?: number;
    not_due?: number;
  };
}

/** 到期该复习。最高权重 —— 它的意思是"这个账今天必须还" */
export const WEIGHT_DUE = 2.0;
/** 错过、但还没到 FSRS 说的时间。次高 —— 记忆确实更脆弱，值得早一点再看 */
export const WEIGHT_WEAK = 1.5;
export const WEIGHT_FRESH = 1.0;
/** 没到期、只是用来补位（今天额度还有空） */
export const WEIGHT_NOT_DUE = 0.5;

export function chooseMode(pace: Pace): string {
  return pace.spelling_required ? "recall_spell" : "recognize";
}

export function buildDailyPlan(input: BuildPlanInput): BuildPlanOutput {
  const { words, daily_cap, pace } = input;
  const weakSet = new Set(input.weak_word_ids ?? []);
  const mode = chooseMode(pace);

  const toItem = (w: WordRef, score: number): DailyPlanItemDraft => ({
    word_id: w.word_id,
    sense_id: w.sense_id,
    mode,
    priority_score: score,
    lemma: w.lemma,
    meaning_zh: w.meaning_zh,
    unit_code: w.unit_code,
    confidence: w.confidence,
  });

  const finish = (picked: DailyPlanItemDraft[], breakdown: BuildPlanOutput["breakdown"]) => {
    const totalSeconds = picked.reduce((sum, i) => sum + secondsForMode(i.mode), 0);
    const estimated_minutes = Math.max(1, Math.round(totalSeconds / 60));
    return {
      items: picked,
      estimated_minutes,
      brief: `今天 ${picked.length} 个词，约 ${estimated_minutes} 分钟。`,
      breakdown,
    };
  };

  // ---------------------------------------------------------------- 旧路径
  //
  // 稳定分层：错词保持原序在前，其余保持原序在后 —— 不做随机、不用时间，保证幂等
  if (!input.clock) {
    const weakItems = words.filter((w) => weakSet.has(w.word_id)).map((w) => toItem(w, WEIGHT_WEAK));
    const freshItems = words.filter((w) => !weakSet.has(w.word_id)).map((w) => toItem(w, WEIGHT_FRESH));

    // 新词 : 复习的比例只决定"今天取多少"，绝不决定"何时再练"（后者是 FSRS 的领地）
    const ratio = Math.min(Math.max(pace.new_ratio, 0), 1);
    const freshQuota = Math.round(daily_cap * ratio);
    const weakQuota = daily_cap - freshQuota;

    const picked = [
      ...weakItems.slice(0, Math.max(weakQuota, 0)),
      ...freshItems.slice(0, Math.max(freshQuota, 0)),
    ];

    // 万一某一类不够，用另一类补足（避免"今天只有 3 个词"）
    if (picked.length < daily_cap) {
      const pickedIds = new Set(picked.map((i) => i.word_id));
      for (const item of [...weakItems, ...freshItems]) {
        if (picked.length >= daily_cap) break;
        if (!pickedIds.has(item.word_id)) {
          picked.push(item);
          pickedIds.add(item.word_id);
        }
      }
    }

    return finish(picked, {
      weak: picked.filter((i) => i.priority_score === WEIGHT_WEAK).length,
      fresh: picked.filter((i) => i.priority_score === WEIGHT_FRESH).length,
    });
  }

  // ---------------------------------------------------------------- 新路径
  const { memory, now } = input.clock;

  const due: WordRef[] = [];
  const fresh: WordRef[] = [];
  const notDue: WordRef[] = [];

  for (const w of words) {
    const m = memory.get(w.word_id);
    if (!m) {
      // 没有任何作答记录 = 新词。**不拿 "state === new" 当判据**：
      // 表里存在的行才有状态，而"表里没有这一行"才是真正的从没学过
      fresh.push(w);
      continue;
    }
    if (isDue(m, now)) due.push(w);
    else notDue.push(w);
  }

  // 到期：逾期越久越先。tie-break 用 due（早到期的先）+ word_id，保证确定性
  const dueOf = (w: WordRef) => memory.get(w.word_id)?.due ?? "";
  due.sort((a, b) => {
    const byOverdue = overdueDays(memory.get(b.word_id)!, now) - overdueDays(memory.get(a.word_id)!, now);
    if (byOverdue !== 0) return byOverdue;
    const byDue = dueOf(a).localeCompare(dueOf(b));
    if (byDue !== 0) return byDue;
    return a.word_id.localeCompare(b.word_id);
  });

  // 未到期：**错过的排前面**（记忆确实更脆弱），其余按最早到期先
  notDue.sort((a, b) => {
    const byWeak = Number(weakSet.has(b.word_id)) - Number(weakSet.has(a.word_id));
    if (byWeak !== 0) return byWeak;
    const byDue = dueOf(a).localeCompare(dueOf(b));
    if (byDue !== 0) return byDue;
    return a.word_id.localeCompare(b.word_id);
  });

  // 新词保持 resolveScope 给的顺序（它已经是确定性排序）

  const ratio = Math.min(Math.max(pace.new_ratio, 0), 1);
  const newQuota = Math.round(daily_cap * ratio);

  const picked: DailyPlanItemDraft[] = [];
  const pickedIds = new Set<string>();
  const take = (w: WordRef, score: number): boolean => {
    if (picked.length >= daily_cap) return false;
    if (pickedIds.has(w.word_id)) return true; // 已取过，跳过但不算额度
    picked.push(toItem(w, score));
    pickedIds.add(w.word_id);
    return true;
  };

  // ① 到期词优先 —— 欠账先还。到期数 ≥ cap 时，今天一个新词都不给。
  for (const w of due) {
    if (!take(w, WEIGHT_DUE)) break;
  }

  // ② 新词，受 new_ratio 上限约束（防复习雪崩，见文件头）
  let newTaken = 0;
  for (const w of fresh) {
    if (newTaken >= newQuota || picked.length >= daily_cap) break;
    if (!take(w, WEIGHT_FRESH)) break;
    newTaken += 1;
  }

  // ③ 还没到期，但今天额度还有空 —— 按最早到期先补位。
  //    为什么不把空位全给新词：多学一个新词 = 明天多一份复习债务，
  //    而提前复习一个旧词只是让它的间隔略微缩短。前者的代价大得多。
  for (const w of notDue) {
    if (picked.length >= daily_cap) break;
    take(w, weakSet.has(w.word_id) ? WEIGHT_WEAK : WEIGHT_NOT_DUE);
  }

  // ④ 例外：**还没攒够"一天的量"**（学过的词数 < 今日额度）。这时给满新词。
  //
  //    为什么需要它：不改的话，表现是这样的 ——
  //    第 1 天用户只答了 1 个词就退出，第 2 天重排时"已有 1 条记忆状态"，
  //    new_ratio 立刻生效，他拿到 15 个词，而首页写着"每天 24 个词"。
  //    他没法知道那 9 个词是被一条他看不见的防雪崩规则砍掉的，只会觉得软件坏了。
  //
  //    为什么条件写成"学过的不够一天"而不是"一条都没有"：
  //    「一条都没有」只覆盖真正的第一次，第二个词起就失效（就是上面那个症状）。
  //
  //    为什么这不会放开雪崩：
  //    ✓ 学过的词 < 额度时，明天最多也就"额度"个词到期，正好是一天的量；
  //    ✓ 一旦学过的词 ≥ 额度，new_ratio 立刻接管，之后每天新词永远不超过那个比例。
  //    也就是说，超过额度这件事**最多发生一次，且超出量小于一天**。
  //
  //    为什么条件不写成"今天没有到期词"：那样只要某天碰巧没有到期词就会灌满新词，
  //    new_ratio 会变成"偶尔生效"，等于没有。
  if (memory.size < daily_cap) {
    for (const w of fresh) {
      if (picked.length >= daily_cap) break;
      take(w, WEIGHT_FRESH);
    }
  }

  return finish(picked, {
    weak: picked.filter((i) => i.priority_score === WEIGHT_WEAK).length,
    fresh: picked.filter((i) => i.priority_score === WEIGHT_FRESH).length,
    due: picked.filter((i) => i.priority_score === WEIGHT_DUE).length,
    not_due: picked.filter((i) => i.priority_score === WEIGHT_NOT_DUE).length,
  });
}
