/**
 * 判分与错因 —— 纯函数，可单测
 *
 * ── 为什么要"判分"这件事单独成文件 ───────────────────────────────
 * 硬约束 19：`review_logs` **必须记全耗时 / 犹豫 / 错因**，"只记对错就是浪费这张表"。
 * 错因不是让模型猜的，是**从题型 + 作答推导出来的确定性结论**。
 * 推导规则只有这一处，改规则时不会漏掉某个页面。
 *
 * ── 三种错因的边界（别合并它们）──────────────────────────────
 *   · `meaning`   看英选中选错了 → 释义记混了 → 补救方式是"对照辨析"
 *   · `spelling`  中译英拼错了   → 记住了词但写不对 → 补救方式是"练拼写"
 *   · `confusion` 中译英**拼成了词库里另一个真实的词** → 两个词混了 → 补救方式是"拉词对做对比"
 * `confusion` 之所以要单独拎出来：它的严重程度和补救方式跟"少写一个字母"完全不同。
 * 如果都记成 `spelling`，将来做错因归因时会把"混词"误判成"手滑"。
 */
import type { ErrorType, GradeResult, StudyAnswer, StudyCard } from "./types";

/**
 * 归一化用户手输的内容。**只做"明显不该算错"的那部分**，不做模糊匹配。
 *
 * 具体做四件事：
 *   ① NFKC + 全角空格/不换行空格 → 普通空格（手机上输入法很容易带出全角空格）
 *   ② 大小写统一（`Apple` 与 `apple` 都是对的，不该为难人）
 *   ③ 去掉首尾的标点与引号（用户可能习惯性打个句号）
 *   ④ 去掉连字符（与 `lemma_normalized` 的口径一致，词表建库时就是这么归一的）
 *
 * **刻意不做**的事：编辑距离容错、词干还原、同义词接受。
 * "离正确答案差一个字母就算对"看起来友好，实际上是把"会不会拼"这件事测没了，
 * 而中考是要写出来的 —— 那就等于骗用户。
 */
export function normalizeTyped(input: string): string {
  // 首尾要剥掉的字符：空白 + 中英标点 + 中英引号与书名号。
  // 「」《》这些是中文输入法里最常见的，用户手一滑就带出来，不该因此判错。
  return input
    .normalize("NFKC")
    .replace(/[\u00a0\u3000]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’「」『』《》〈〉.,!?;:()[\]{}<>·、，。！？；：]+/, "")
    .replace(/[\s"'“”‘’「」『』《》〈〉.,!?;:()[\]{}<>·、，。！？；：]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/-/g, "");
}

/** 看英选中：选项下标对不对。没有"部分对"这回事，所以不错因必定是 `meaning` */
export function gradeRecognize(selectedIndex: number, answerIndex: number): GradeResult {
  const is_correct = selectedIndex === answerIndex;
  return { is_correct, error_type: is_correct ? null : "meaning" };
}

export interface RecallSpellInput {
  typed: string;
  card: StudyCard;
  /** 词库里全部词的归一形。命中它 = 拼成了另一个真实的词（confusion） */
  knownLemmas: ReadonlySet<string>;
}

export function gradeRecallSpell({ typed, card, knownLemmas }: RecallSpellInput): GradeResult {
  const normalized = normalizeTyped(typed);
  const accepted = (card.answers ?? [card.lemma]).map(normalizeTyped);

  if (accepted.includes(normalized)) return { is_correct: true, error_type: null };

  // 空输入不该走到这里（界面会拦住），但真发生了就如实算"拼错"，
  // 而不是抛异常把整页搞挂 —— 一条脏数据不该拖垮学习流程。
  if (normalized === "") return { is_correct: false, error_type: "spelling" };

  // 拼成了词库里另一个真实的词 → 混词。这里用**全库**集合而不是"本单元"：
  // 把 basketball 写成 football 时，football 是不是同单元的并不影响"你是混了两个词"这个判断。
  if (knownLemmas.has(normalized)) return { is_correct: false, error_type: "confusion" };

  return { is_correct: false, error_type: "spelling" };
}

/** 统一入口 —— 调用方不必自己按 kind 分派，避免两处各写一遍 if */
export function gradeAnswer(
  card: StudyCard,
  answer: StudyAnswer,
  knownLemmas: ReadonlySet<string>,
): GradeResult {
  if (answer.kind === "index") {
    return gradeRecognize(answer.value, card.answer_index ?? -1);
  }
  return gradeRecallSpell({ typed: answer.value, card, knownLemmas });
}

/** 错因的中文说法。界面、反馈导出、日志共用一处，避免"三个地方三种叫法" */
export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  meaning: "释义记混了",
  spelling: "拼写错了",
  confusion: "和另一个词混了",
};

export function errorTypeLabel(t: ErrorType | null): string {
  return t ? ERROR_TYPE_LABEL[t] : "没有错";
}
