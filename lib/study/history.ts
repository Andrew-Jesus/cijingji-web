/**
 * 从 `review_logs` 派生判断 —— 纯函数，可单测
 *
 * 这一个文件回答两个看起来相反、其实是同一件事的问题：
 *   · **哪些词已经稳住了**（`settledWordIds`）→ 今天不用再出现
 *   · **哪些词还没稳住**（`weakWordIds`）→ 排计划时优先练
 *
 * 两者都是"看这个词**最后一次**答得怎么样"，所以放在一起、共用同一段取数逻辑。
 * 分开写两份的话，迟早出现"首页说这个词稳住了、排计划却把它当错词"这种自相矛盾。
 *
 * ── 为什么以"最后一次"为准，而不是"答对过一次就算会" ─────────────
 * 一个词可能是蒙对的，也可能是当时记得、第二天就忘了。
 * 只有"最后一次是对的"才说明它此刻稳着。这条规则简单、可解释、可单测，
 * 而且**方向是安全的**：它会让人多练一遍，不会让人漏练。
 *
 * ── 为什么不用"正确率"或"连对次数" ───────────────────────────
 * 那需要阈值（连对 2 次算会？正确率 80%？），而任何阈值在阶段 0 都是**拍的数**。
 * 阶段 0 的调度是简化确定性版本，界面与文档都写明了"暂未接入科学复习调度"；
 * 在这里发明一个阈值，等于伪装成了科学。真正的间隔调度归阶段 2 的 FSRS。
 */
import { localDayKey } from "@/lib/plan/todayProgress";

export interface OutcomeLog {
  word_id: string;
  is_correct: boolean;
  created_at: string;
}

export interface Outcome {
  at: number;
  is_correct: boolean;
}

/**
 * 每个词的最后一次作答结果。**全项目唯一一处"最后一条记录"的取法。**
 *
 * 一个刻意的规则：两次记录时间戳**完全相同**时，取"错"的那条。
 * 理由：宁可让用户多练一遍，也不要因为毫秒级并列而漏掉一个没稳住的词。
 */
export function latestOutcomeByWord(logs: readonly OutcomeLog[]): Map<string, Outcome> {
  const latest = new Map<string, Outcome>();

  for (const log of logs) {
    const at = new Date(log.created_at).getTime();
    // 时间戳坏掉的记录直接跳过：一条脏数据不该让整个词的历史归零
    if (Number.isNaN(at)) continue;

    const prev = latest.get(log.word_id);
    if (!prev || at > prev.at || (at === prev.at && !log.is_correct)) {
      latest.set(log.word_id, { at, is_correct: log.is_correct });
    }
  }

  return latest;
}

/**
 * 今天已经"结清"的词 —— 今天的最后一次作答是对的。
 * 只看今天：昨天做对过不代表今天还记得（真正的跨天判断归阶段 2 的 FSRS）。
 */
export function settledWordIds(logs: readonly OutcomeLog[], dayKey: string): Set<string> {
  const settled = new Set<string>();
  for (const [wordId, outcome] of latestOutcomeByWord(logs)) {
    if (!outcome.is_correct) continue;
    if (localDayKey(new Date(outcome.at)) !== dayKey) continue;
    settled.add(wordId);
  }
  return settled;
}

/**
 * 还没稳住的词，**最近错的排最前** —— 直接喂给 `buildDailyPlan` 的 `weak_word_ids`。
 *
 * 为什么要按时间倒序：昨天错的比上个月错的更值得今天练。
 * 这个顺序会实打实地影响"今天先练哪几个"，所以它必须确定（不能靠 Map 的插入顺序碰运气）。
 */
export function weakWordIds(logs: readonly OutcomeLog[], limit: number): string[] {
  return [...latestOutcomeByWord(logs).entries()]
    .filter(([, outcome]) => !outcome.is_correct)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.max(limit, 0))
    .map(([wordId]) => wordId);
}

/** 「老熟人」——结算页那一行的全部事实。 lemma 由调用方解（本函数只认流水，不查词库） */
export interface ReturningFriend {
  word_id: string;
  /** 今天之前，这个词一共错过几次 */
  wrongs_before: number;
  /** 距上次见到它，隔了几个自然日（按本地日界数） */
  gap_days: number;
}

/** 老熟人的见面门槛。与记忆台阶「熬过一次遗忘」的 ≥3 天同一个数 —— 全站只许有一套间隔词汇 */
export const RETURNING_MIN_GAP_DAYS = 3;

/**
 * 「老熟人回来」——今天答对、但它以前打败过你、而且你们有日子没见的词。
 *
 * ── 判据（全部是流水上数得出来的事实）────────────────────────
 *   · **今天最后一次作答是对的**（沿用 `latestOutcomeByWord` 的口径：
 *     "最后一次是对的"才算今天赢了 —— 今天先对后错的说"今天对了"是假话）；
 *   · 今天之前错过 ≥1 次 —— "它以前打败过你"；
 *     今天的错不折抵进来：今天先错后对是翻盘，不是旧账；
 *   · 距上次见到它 ≥ `minGapDays` 个自然日。昨天错的今天对，才隔一天，谈不上"回来"。
 *
 * 排序 = 故事强度：隔得最久的在前，并列比错次，再并列按 word_id 兜底
 * —— 同一份输入两次调用得到同一个顺序（与 `weakWordIds` 同一纪律）。
 * 坏时间戳的记录整条跳过（与 `latestOutcomeByWord` 同一规则）。
 */
export function returningFriends(
  logs: readonly OutcomeLog[],
  now: Date,
  minGapDays: number = RETURNING_MIN_GAP_DAYS,
): ReturningFriend[] {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const minGap = Math.max(minGapDays, 1);

  interface Trail {
    /** 今天之前的累计错次 */
    wrongsBefore: number;
    /** 今天之前最后一次作答的时刻；没见过 = -Infinity */
    lastSeenBefore: number;
    /** 今天最后一次作答的结果；今天还没见过 = null */
    lastTodayCorrect: boolean | null;
  }

  const trails = new Map<string, Trail>();
  for (const log of logs) {
    const at = new Date(log.created_at).getTime();
    if (Number.isNaN(at)) continue;

    let trail = trails.get(log.word_id);
    if (!trail) {
      trail = { wrongsBefore: 0, lastSeenBefore: Number.NEGATIVE_INFINITY, lastTodayCorrect: null };
      trails.set(log.word_id, trail);
    }

    if (at >= todayStart.getTime()) {
      trail.lastTodayCorrect = log.is_correct;
      continue;
    }
    if (!log.is_correct) trail.wrongsBefore += 1;
    if (at > trail.lastSeenBefore) trail.lastSeenBefore = at;
  }

  const DAY_MS = 86400000;
  const friends: ReturningFriend[] = [];
  for (const [wordId, trail] of trails) {
    if (trail.lastTodayCorrect !== true) continue;
    if (trail.wrongsBefore < 1) continue;
    if (!Number.isFinite(trail.lastSeenBefore)) continue;

    const seenStart = new Date(trail.lastSeenBefore);
    seenStart.setHours(0, 0, 0, 0);
    const gapDays = Math.round((todayStart.getTime() - seenStart.getTime()) / DAY_MS);
    if (gapDays < minGap) continue;

    friends.push({ word_id: wordId, wrongs_before: trail.wrongsBefore, gap_days: gapDays });
  }

  return friends.sort(
    (a, b) =>
      b.gap_days - a.gap_days ||
      b.wrongs_before - a.wrongs_before ||
      a.word_id.localeCompare(b.word_id),
  );
}
