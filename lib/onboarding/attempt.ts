/**
 * 自测作答的跨页传递
 *
 * 为什么不把结果（等级/对题数）直接传过去：
 * 那等于把"怎么算出来的"丢掉，结果页就没法展示"你在 Unit 3 答对 2/3"这种细节，
 * 也没法在将来改分档线时重算旧记录。
 * 所以存**原始作答 + 种子**，结果页用同一个种子重建同一份卷子再判分。
 * 这也顺带把"抽题必须可复现"这条保证在真实流程里验了一遍。
 *
 * 用 sessionStorage（不是 localStorage）：关掉标签页就该忘掉，
 * 一份做了一半的卷子没有跨会话保留的价值。
 * 只在 useEffect / 事件回调里调用 —— 服务端没有 sessionStorage。
 */
import { QUIZ_SEED } from "./quiz";

export const ATTEMPT_KEY = "cijingji:onboarding-attempt-v1";

export interface QuizAttempt {
  /** 抽题种子。结果页据此重建同一份卷子 */
  seed: number;
  /** 每题选了第几项；null = 没作答 */
  answers: (number | null)[];
  /** 提交时间，仅用于排查，不参与判分 */
  submitted_at: string;
}

export function saveAttempt(attempt: QuizAttempt): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // 隐私模式下 sessionStorage 可能不可写。存不上不该让流程断掉 —— 结果页会走降级分支
  }
}

export function readAttempt(): QuizAttempt | null {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuizAttempt>;
    if (!Array.isArray(parsed.answers)) return null;
    return {
      seed: typeof parsed.seed === "number" ? parsed.seed : QUIZ_SEED,
      answers: parsed.answers.map((a) => (typeof a === "number" ? a : null)),
      submitted_at: typeof parsed.submitted_at === "string" ? parsed.submitted_at : "",
    };
  } catch {
    return null;
  }
}

export function clearAttempt(): void {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // 同上，忽略
  }
}
