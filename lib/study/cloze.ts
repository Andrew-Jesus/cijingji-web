/**
 * 完形填空 —— 三道审核 + 拆题 + 判分。**全部是纯函数，无 IO，可单测。**
 *
 * ── 为什么审核要单独一个文件，而不是塞进 AI 那条链里 ──────────────
 * 因为同一份审核要跑两遍，两遍的时机和目的完全不同：
 *   ① **生成完立刻跑一次**（服务端）：不合格就让模型重写，别把废题发给用户；
 *   ② **从缓存读出来再跑一次**（前端）：缓存是几天前写的、或者是从别的设备同步来的，
 *      而词库和审核规则可能已经变了。
 * 如果审核逻辑写在服务端链路里，第 ② 遍就只能靠"相信缓存"——那是把废题放行的口子。
 * 写成纯函数放这里，两边 import 同一份，规则永远只有一处。
 *
 * ── 三道审核对应三个真实风险（缺一道就会漏一种废题）──────────────
 *   ① **结构**：空数不对、选项不是 4 个、正确答案下标越界、占位符没配平。
 *      这类题会让界面直接崩（`options[answer]` 是 undefined）或判分算错。
 *   ② **词汇**：挖空词不在本单元词表里。它不会让页面报错，但会让
 *      「这个词今天该复习了」记到**用户根本没在学的词**上 —— 静默污染复习安排。
 *   ③ **敏感**：出现「真题 / 押题 / 某地某年考过」字样。这是**合规底线**
 *      （本节规格书原文："绝不允许出现…字样，校验器直接拦"）。
 *
 * ── 一条贯穿全文件的原则：**宁可判不合格，也不要修补**─────────────
 * 比如"只有 9 个空"时，顺手补一个空或砍掉最后一个空都能让它"看起来能用"，
 * 但那道题是残缺的，而且用户会以为它本来就是这样的。
 * 判不合格 → 上层重试一次 → 还不行就如实降级。这条路慢，但每道题都是真完整的。
 */

/** 标准题型的空数。规格书写的是 10 空 —— 中考完形填空也基本是 10 空 */
export const CLOZE_BLANK_COUNT = 10;

/** 每空 4 选 1 */
export const CLOZE_OPTION_COUNT = 4;

/**
 * 短文词数的**可接受区间**。
 *
 * 目标区间是 150~200（规格书），这里放宽到 120~280：
 * 下界 120 是"低于这个数撑不起 10 个空"，上界 280 是"再多就做不完了"。
 * 为什么不卡死在 150~200：模型对词数的自我估计本来就不准，
 * 卡太严会让一大批其实合格的文章被判废，然后反复重试、用户干等。
 */
export const CLOZE_WORD_MIN = 120;
export const CLOZE_WORD_MAX = 280;

/** 一空 */
export interface ClozeBlank {
  /** 1 起步的题号。与短文里的 `{{n}}` 一一对应 */
  no: number;
  /** **恰好 4 个**、互不相同、非空 */
  options: string[];
  /** 正确选项在 `options` 里的下标（0~3）。**作答前界面不得读取它** */
  answer: number;
  /**
   * 这个空考的是词库里哪个词（**原形**，如 `join`，不是 `joined`）。
   *
   * 为什么需要它：判分之后要把"这个空答错了"记到**某个具体的词**上，
   * 否则复习安排不知道该把谁往前提。模型写形变（joined）时由提示词要求它另给原形。
   * 审核会检查它是否真的在本单元词表里 —— 这是防"模型随口编一个词"的唯一办法。
   */
  word: string;
}

/** 一道完整的完形填空 */
export interface ClozeDraft {
  /** 中文标题，如「一次班级旅行」。界面顶部显示，也用来在列表里认题 */
  title: string;
  /** 短文原文，空位写成 `{{1}}` … `{{10}}` */
  passage: string;
  blanks: ClozeBlank[];
}

/* ══════════════════════════ ① 结构校验 ══════════════════════════ */

/** 占位符。**必须是固定形状**，见下方 `findPlaceholders` 的注释 */
const PLACEHOLDER_RE = /\{\{\s*(\d{1,2})\s*\}\}/g;

/**
 * 抠出短文里所有占位符。
 *
 * 为什么限定 `{{n}}` 这个形状（而不是更宽松的 `[n]` / `___n___`）：
 * 方括号在下划线在正常英文里都可能自然出现（`[sic]`、填空线本身），
 * 宽松匹配会把正常文本误当成空位，而且**判失败时不报错、只表现为"空位对不上"**。
 * 双花括号是正常英文短文里绝不会出现的东西，误判概率最低。
 *
 * 同时做一件容易被忽略的事：**把匹配到的原文位置也返回**。
 * 界面要靠它把短文切成「文字 / 空 / 文字 / 空 …」去渲染。
 */
export function findPlaceholders(passage: string): { no: number; from: number; to: number }[] {
  const out: { no: number; from: number; to: number }[] = [];
  // ⚠️ 带 `g` 的正则是**有状态**的（`lastIndex`），所以每次用之前重置 ——
  // 否则同一个正则第二次调用会从上次结束的位置开始，静默漏掉前面的空位。
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(passage)) !== null) {
    out.push({ no: Number(m[1]), from: m.index, to: m.index + m[0].length });
  }
  PLACEHOLDER_RE.lastIndex = 0;
  return out;
}

/** 把短文拆成「文字段 / 空位」交替的片段，给界面渲染用 */
export type PassageChunk =
  | { kind: "text"; text: string }
  | { kind: "blank"; no: number };

/**
 * 拆题。
 *
 * 它与 `findPlaceholders` 共用同一份正则 —— 两处各写一个匹配规则，
 * 早晚会出现"审核认为有 10 个空、渲染只认出 9 个"这种**两边都不报错**的分歧。
 *
 * 占位符没配平时怎么办：**原样当文本吐出去**，不抛异常。
 * 理由是这个函数在界面上被调用，而界面上"显示得难看"远好过"整页打不开"；
 * 真正的拦截交给 `checkClozeStructure`（它在渲染之前跑）。
 */
export function splitPassage(passage: string): PassageChunk[] {
  const hits = findPlaceholders(passage);
  if (hits.length === 0) return passage ? [{ kind: "text", text: passage }] : [];

  const chunks: PassageChunk[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.from > cursor) chunks.push({ kind: "text", text: passage.slice(cursor, hit.from) });
    chunks.push({ kind: "blank", no: hit.no });
    cursor = hit.to;
  }
  if (cursor < passage.length) chunks.push({ kind: "text", text: passage.slice(cursor) });
  return chunks;
}

/** 数词数。空白分隔 + 把占位符去掉 —— 占位符不该被算成一个词 */
export function countWords(passage: string): number {
  const stripped = passage.replace(PLACEHOLDER_RE, " ");
  PLACEHOLDER_RE.lastIndex = 0;
  return stripped.split(/\s+/).filter((t) => t.length > 0).length;
}

/** 审核问题的机器码。**界面不直接显示它**，只用来分支与日志 */
export type ClozeIssue =
  | "empty_passage"
  | "empty_title"
  | "blank_count"
  | "placeholder_mismatch"
  | "option_count"
  | "option_duplicate"
  | "option_empty"
  | "answer_out_of_range"
  | "blank_no_duplicate"
  | "passage_too_short"
  | "passage_too_long"
  | "word_not_in_unit"
  | "forbidden_claim"
  | "url_or_email"
  | "emoji";

export interface ClozeCheck {
  ok: boolean;
  issues: ClozeIssue[];
  /** 人话记录 —— 给日志与开发者模式看。**issue 码是给机器分流的，这个是给人看的** */
  notes: string[];
}

/**
 * ① 结构校验。
 *
 * 检查顺序是有讲究的：**先"有没有"再"对不对"**。
 * 一篇空短文直接报 `empty_passage` 就够了，不需要再陪它报
 * "空数不对""选项不对""占位符不对" —— 那会让日志里全是噪音，
 * 真正的原因被淹在后面。
 */
export function checkClozeStructure(draft: ClozeDraft): ClozeCheck {
  const issues: ClozeIssue[] = [];
  const notes: string[] = [];

  if (draft.title.trim().length === 0) {
    issues.push("empty_title");
    notes.push("没有标题");
  }
  if (draft.passage.trim().length === 0) {
    issues.push("empty_passage");
    notes.push("短文是空的");
    return { ok: false, issues, notes };
  }

  // 空位数量：占位符的个数、blanks 的个数，必须**都**等于标准空数
  const hits = findPlaceholders(draft.passage);
  if (hits.length !== CLOZE_BLANK_COUNT) {
    issues.push("blank_count");
    notes.push(`短文里有 ${hits.length} 个空位，应该是 ${CLOZE_BLANK_COUNT} 个`);
  }
  if (draft.blanks.length !== CLOZE_BLANK_COUNT) {
    issues.push("blank_count");
    notes.push(`题目里有 ${draft.blanks.length} 个空，应该是 ${CLOZE_BLANK_COUNT} 个`);
  }

  // 占位符编号必须是 1..10 各出现一次 —— 重复编号会让两处显示同一个空
  const hitNos = hits.map((h) => h.no).sort((a, b) => a - b);
  const expected = Array.from({ length: CLOZE_BLANK_COUNT }, (_, i) => i + 1);
  if (hitNos.length !== expected.length || hitNos.some((n, i) => n !== expected[i])) {
    issues.push("placeholder_mismatch");
    notes.push(`短文里的空位编号是 [${hitNos.join(",")}]，应该正好是 1~${CLOZE_BLANK_COUNT}`);
  }

  const blankNos = draft.blanks.map((b) => b.no).sort((a, b) => a - b);
  if (
    blankNos.length !== expected.length ||
    blankNos.some((n, i) => n !== expected[i]) ||
    new Set(blankNos).size !== blankNos.length
  ) {
    issues.push("blank_no_duplicate");
    notes.push(`题目的空编号是 [${blankNos.join(",")}]，应该正好是 1~${CLOZE_BLANK_COUNT} 且不重复`);
  }

  // 逐空校验
  for (const blank of draft.blanks) {
    if (!Array.isArray(blank.options) || blank.options.length !== CLOZE_OPTION_COUNT) {
      issues.push("option_count");
      notes.push(`第 ${blank.no} 空有 ${blank.options?.length ?? 0} 个选项，应该是 ${CLOZE_OPTION_COUNT} 个`);
      continue;
    }

    const trimmed = blank.options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (trimmed.some((o) => o.length === 0)) {
      issues.push("option_empty");
      notes.push(`第 ${blank.no} 空有空白选项`);
    }

    // 大小写不同不算重复（`Join` 与 `join` 在句首确实可能都出现），
    // 但**归一后相同**就是真重复 —— 那样这道题会同时有两个"正确答案"
    const lower = trimmed.map((o) => o.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      issues.push("option_duplicate");
      notes.push(`第 ${blank.no} 空的选项里有重复项`);
    }

    if (!Number.isInteger(blank.answer) || blank.answer < 0 || blank.answer >= CLOZE_OPTION_COUNT) {
      issues.push("answer_out_of_range");
      notes.push(`第 ${blank.no} 空的答案下标 ${blank.answer} 不在 0~${CLOZE_OPTION_COUNT - 1} 之间`);
    }

    if (typeof blank.word !== "string" || blank.word.trim().length === 0) {
      issues.push("word_not_in_unit");
      notes.push(`第 ${blank.no} 空没有说明考的是哪个词`);
    }
  }

  // 词数最后查：前面的结构都不对时，词数其实没有参考价值
  const words = countWords(draft.passage);
  if (words < CLOZE_WORD_MIN) {
    issues.push("passage_too_short");
    notes.push(`短文只有 ${words} 词，少于 ${CLOZE_WORD_MIN} 词`);
  } else if (words > CLOZE_WORD_MAX) {
    issues.push("passage_too_long");
    notes.push(`短文有 ${words} 词，多于 ${CLOZE_WORD_MAX} 词`);
  }

  return { ok: issues.length === 0, issues, notes };
}

/* ══════════════════════════ ② 词汇校验 ══════════════════════════ */

/** 词归一。与词库 `lemma_normalized` 的口径一致：小写 + 连字符去掉 + 去首尾空白 */
export function normalizeLemma(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "").replace(/\s+/g, " ");
}

/**
 * ② 词汇校验：**每个空考的词，必须真的在本单元词表里**。
 *
 * 为什么这条不能省（它是三道里最容易被当成"多余"的一道）：
 * 提示词会把本单元的词表给模型，但模型**仍会自己加词**——实测常见的是
 * 为了句子通顺塞一个更常见的近义词。它不会让页面报错，但答错之后
 * `review_logs` 会把错记到那个**用户根本没在学的词**上，
 * 于是"难词区"里出现一个他没学过的新词，而真正该复习的词一次都没被提前。
 *
 * `unitWords` 传的是**归一后**的词表（`lemma_normalized`）。
 * 调用方负责归一，这里再归一一次 —— 幂等，多跑一次不亏。
 */
export function checkClozeVocabulary(
  draft: ClozeDraft,
  unitWords: ReadonlySet<string>,
): ClozeCheck {
  const issues: ClozeIssue[] = [];
  const notes: string[] = [];
  const pool = new Set([...unitWords].map(normalizeLemma));

  for (const blank of draft.blanks) {
    const word = normalizeLemma(blank.word ?? "");
    if (!word) continue; // 结构校验已经报过"没说考哪个词"，这里不重复报
    if (!pool.has(word)) {
      issues.push("word_not_in_unit");
      notes.push(`第 ${blank.no} 空考的是「${blank.word}」，它不在本单元词表里`);
    }
  }

  return { ok: issues.length === 0, issues, notes };
}

/* ══════════════════════════ ③ 敏感内容校验 ══════════════════════════ */

/**
 * 禁止出现的说法。**这是合规底线，不是风格偏好。**
 *
 * 产品里所有"查出来的事实"都必须真（词表、音标、释义），所以一旦界面出现
 * "这道题选自 2023 年天津中考真题"，那就是一句**无法证实且大概率是编的**话 ——
 * 而它伤害的正是这个产品唯一的立足点：说实话。
 *
 * 所以这里不是"尽量不要"，而是**直接判废、让模型重写**。
 */
const FORBIDDEN_CLAIMS = [
  "真题",
  "押题",
  "原题",
  "考过",
  "必考",
  "命题组",
  "中考卷",
  "模拟卷",
  "考试大纲",
] as const;

/** 邮箱 / URL。初中短文里不该出现，出现了说明模型在"凑内容" */
const URL_OR_EMAIL_RE = /(https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,})/i;

/**
 * emoji 与各种"图形符号"。
 *
 * 用码点范围而不是列清单：emoji 有上千个且每年新增。
 * 这里只挡最主流的几段（表情、符号、交通、旗帜、装饰符号），
 * 它们是模型最容易顺手写出来的。生僻的漏掉也无所谓 ——
 * 这一道的主战场本来就不是 emoji。
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;

function collectText(draft: ClozeDraft): string {
  return [draft.title, draft.passage, ...draft.blanks.flatMap((b) => b.options ?? [])].join("\n");
}

/**
 * ③ 敏感内容校验。
 *
 * ⚠️ 它查的是**生成出来的文本**，不是"用户输入"——用户没有输入口，
 * 能干这件事的只有模型。所以这条审核的主要职责是"别把编的当真话写进界面"。
 */
export function checkClozeSafety(draft: ClozeDraft): ClozeCheck {
  const issues: ClozeIssue[] = [];
  const notes: string[] = [];
  const text = collectText(draft);

  const hitClaims = FORBIDDEN_CLAIMS.filter((phrase) => text.includes(phrase));
  if (hitClaims.length > 0) {
    issues.push("forbidden_claim");
    notes.push(`出现了不该出现的说法：${hitClaims.join("、")}`);
  }

  const url = text.match(URL_OR_EMAIL_RE);
  if (url) {
    issues.push("url_or_email");
    notes.push(`短文里出现了网址或邮箱：${url[0]}`);
  }

  const emoji = text.match(EMOJI_RE);
  if (emoji) {
    issues.push("emoji");
    notes.push(`短文里出现了表情符号：${emoji[0]}`);
  }

  return { ok: issues.length === 0, issues, notes };
}

/* ══════════════════════════ 三道合一 ══════════════════════════ */

/**
 * 跑完三道，把问题汇总。
 *
 * 为什么三道的 issues **全都要收集**而不是遇到第一个就返回：
 * 线上排查时最想知道的是"这个模型到底哪一类老出错"。
 * 一次只报一条，就得反复重试才看得全 —— 而每次重试都是真金白银。
 *
 * 顺序固定为 结构 → 词汇 → 敏感：结构不合格时后面两道查出来的东西
 * 参考价值很低（空位都对不上，谈何"这个词在不在词表里"）。
 * 但依然全跑完 —— 因为它们彼此独立，且都不贵（纯内存遍历）。
 */
export function checkCloze(draft: ClozeDraft, unitWords: ReadonlySet<string>): ClozeCheck {
  const structure = checkClozeStructure(draft);
  const vocabulary = checkClozeVocabulary(draft, unitWords);
  const safety = checkClozeSafety(draft);

  const issues = [...structure.issues, ...vocabulary.issues, ...safety.issues];
  const notes = [...structure.notes, ...vocabulary.notes, ...safety.notes];
  return { ok: issues.length === 0, issues, notes };
}

/* ══════════════════════════ 判分 ══════════════════════════ */

/** 一个空的判分结果 */
export interface ClozeBlankResult {
  no: number;
  /** 用户选的下标；`null` = 没选（提交前可以留空，进来这里就按错算） */
  chosen: number | null;
  /** 正确下标 */
  answer: number;
  correct: boolean;
  /** 这个空考的是哪个词（原形）。**回流到复习安排时用它** */
  word: string;
  /** 用户选错时，他选的那个词 —— 用于"和另一个词混了"的诊断话术 */
  chosen_text: string | null;
  answer_text: string;
}

export interface ClozeGrade {
  blanks: ClozeBlankResult[];
  correct_count: number;
  total: number;
}

/**
 * 判分。
 *
 * 三条刻意的做法：
 *   ① **没选 = 算错**。不抛异常、不跳过 —— 用户没选就提交了，
 *      事实就是"这个空他没认出"。
 *   ② **不偷看 `word` 去猜**。对错只看 `chosen === answer`，
 *      与"考的是哪个词"无关。这是判分与回流的分离：判分只回答"这道题对不对"，
 *      回流才关心"这算到哪个词头上"。
 *   ③ `answer` 越界时按错处理并给 `null` 文本，不崩。
 *      能进到这里的数据理论上已经过审核，但**审核过的题也可能来自旧缓存**，
 *      而一条脏数据不该让整个结算页打不开。
 */
export function gradeCloze(
  draft: Pick<ClozeDraft, "blanks">,
  choices: Readonly<Record<number, number | null | undefined>>,
): ClozeGrade {
  const blanks: ClozeBlankResult[] = draft.blanks
    .slice()
    .sort((a, b) => a.no - b.no)
    .map((blank) => {
      const raw = choices[blank.no];
      const chosen = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
      const answerText = blank.options?.[blank.answer] ?? "";
      const chosenText =
        chosen !== null && chosen >= 0 && chosen < (blank.options?.length ?? 0)
          ? blank.options[chosen]
          : null;

      return {
        no: blank.no,
        chosen,
        answer: blank.answer,
        correct: chosen !== null && chosen === blank.answer,
        word: blank.word,
        chosen_text: chosenText,
        answer_text: answerText,
      };
    });

  return {
    blanks,
    correct_count: blanks.filter((b) => b.correct).length,
    total: blanks.length,
  };
}
