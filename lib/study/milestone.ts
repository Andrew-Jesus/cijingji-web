/**
 * 记忆台阶 —— 游戏化的第一块地基（规格书 §20.3.1）
 *
 * 一条铁律先立住（规格书原文）：
 * > 每一个数字，都要能回答"它代表什么记忆事实"。答不上来，就砍掉。
 *
 * 四级判据（规格书原文，逐字实现）：
 *
 * | 级            | 判据                                       |
 * |---------------|--------------------------------------------|
 * | 生词 new      | 没答对过                                   |
 * | 认得 known    | 答对过，但还没有相邻两次正确隔 ≥3 天        |
 * | 熬过一次遗忘 endured   | 存在相邻两次正确间隔 ≥ 3 天                 |
 * | 稳了 solid    | 累计 ≥3 次正确，且其中至少一次间隔 ≥ 7 天   |
 *
 * ── 两个口径决定，改之前先读理由 ─────────────────────────────
 *
 * ① **判级只看"相邻两次正确"的间隔，不看 FSRS 的 stability。**
 *    规格书判据写的就是作答流水上的时间事实 —— stability 是算法的估计值，
 *    会随算法版本变（FSRS-5 → FSRS-6），拿它当判据，数字就不是"记忆事实"
 *    而是"算法意见"。流水才是真相源（与 word_states 不上云同一个理由）。
 *
 * ② **答错过的词（0 次正确）落在「生词」级。** 规格书四级没有它的位置，
 *    但它显然不在"认得"以上。它的战场在难词区（对手），不在台阶上 ——
 *    台阶只描述"爬到哪了"，不描述"摔过几跤"（摔跤次数是 lapses 的事）。
 *
 * 判级取**能达到的最高级**：比如一个词既有 ≥3 天的间隔又有 ≥7 天的，
 * 直接判「稳了」，不逐级回报。
 */

/** 四个台阶，从低到高。界面要按级排序或画图例时用这个顺序，别自己再排一遍 */
export const MILESTONE_ORDER = ["new", "known", "endured", "solid"] as const;

export type Milestone = (typeof MILESTONE_ORDER)[number];

/** 台阶的人话名字。全站只有这一份 —— 两处各写一遍迟早说成两个词 */
export const MILESTONE_LABEL: Record<Milestone, string> = {
  new: "生词",
  known: "认得",
  endured: "熬过一次遗忘",
  solid: "稳了",
};

/** 判台阶需要的最小字段。传整条 ReviewLog 也行 —— 结构上兼容 */
export interface MilestoneLog {
  is_correct: boolean;
  created_at: string;
}

/** 一天的毫秒数。判据里的"3 天""7 天"都是它乘出来的 */
const DAY_MS = 86_400_000;

/**
 * 单个词的台阶。输入是这个词的**全部**作答记录（顺序不限 —— 函数内部会排）。
 *
 * 注意"全部"三个字：只传最近几条的话，≥3 天的间隔会被截掉，
 * 判出来的级**偏低且不报错**。调用方一律传这个词的完整流水。
 */
export function milestoneFromLogs(logs: readonly MilestoneLog[]): Milestone {
  // 只留答对的、只留时间能解析的。错答不参与判级（判据全是"正确间隔"）。
  const correctTimes = logs
    .filter((l) => l.is_correct)
    .map((l) => Date.parse(l.created_at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  if (correctTimes.length === 0) return "new";

  // 「熬过一次遗忘」看**相邻**两次正确 —— 规格书原文这里明确带着"相邻"二字
  let gap3 = false;
  for (let i = 1; i < correctTimes.length; i++) {
    if ((correctTimes[i] - correctTimes[i - 1]) / DAY_MS >= 3) {
      gap3 = true;
      break;
    }
  }

  // 「稳了」的规格书原文**没有**"相邻"二字：「累计 ≥3 次正确，且其中至少一次
  // 间隔 ≥ 7 天」。按字面取任意两次正确的最大间隔 —— 排序后就是首末差。
  // 为什么不跟上面统一用相邻：0→3→7 天三次全对，相邻间隔只有 3 和 4，
  // 但复习节奏在拉开、总跨度撑满了一周 —— 判「稳了」是记忆事实，
  // 判「熬过」反而低估了用户。两个判据措辞不同是规格书原文如此，不是笔误。
  const span7 =
    (correctTimes[correctTimes.length - 1] - correctTimes[0]) / DAY_MS >= 7;

  // 从高到低判：先看够不够「稳了」，再看「熬过」，最后才轮到「认得」。
  if (correctTimes.length >= 3 && span7) return "solid";
  if (gap3) return "endured";
  return "known";
}

/**
 * 「已征服」的口径：爬上「熬过一次遗忘」及以上。
 *
 * 为什么是它：规格书给游戏化定的核心情绪是 **"它以前打败过你，现在你赢了"** ——
 * 「熬过一次遗忘」（隔了 ≥3 天还记得）就是这件事的准确描述。
 * 「认得」只是刚交手（今天背今天对，隔一天就未必）；「稳了」是征服之后的事，
 * 不拿它当征服门槛，698 的终点才够得着。
 */
export function isConquered(m: Milestone): boolean {
  return m === "endured" || m === "solid";
}

/**
 * 全量流水一次算完：word_id → 台阶。
 *
 * 为什么返回 Map 而不是对象：词头 id 形如 `w:suppose`，当对象键时要提防
 * `__proto__` 这类字面量（词库里真有过形似的）。Map 只有一种取法，没有意外。
 *
 * 一次 O(n log n)（n = 全部流水）：先按词分组，组内各判一次。
 * 几千条流水在手机上也是毫秒级 —— 首页已经在全量重放 FSRS 了，这不是新的性能点。
 */
export function milestonesByWord(logs: readonly (MilestoneLog & { word_id: string })[]): Map<string, Milestone> {
  const byWord = new Map<string, MilestoneLog[]>();
  for (const log of logs) {
    const bucket = byWord.get(log.word_id);
    if (bucket) bucket.push(log);
    else byWord.set(log.word_id, [log]);
  }

  const result = new Map<string, Milestone>();
  for (const [wordId, wordLogs] of byWord) {
    result.set(wordId, milestoneFromLogs(wordLogs));
  }
  return result;
}
