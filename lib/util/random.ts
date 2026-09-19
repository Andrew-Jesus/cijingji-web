/**
 * 可复现的伪随机 —— 全项目唯一一份
 *
 * 为什么要单独抽出来：`mulberry32` 和 `shuffle` 原本写在 `lib/onboarding/quiz.ts` 里，
 * 学习页出题又需要同一套。**抄一份就是两处真值来源**（项目规矩第 7 条），
 * 早晚会一份改了另一份没改，然后"同一份数据两次抽出来的题不一样"。
 *
 * 为什么不用 `Math.random()`：抽题必须**可复现**。
 * 同种子必得同结果，单测才写得出来，线上出问题才排查得了。
 * 这个场景不需要密码学强度 —— 它只是"让选项别老按同一个顺序排"。
 */

/** mulberry32 —— 32 位小 PRNG，够用、够短、跨环境结果一致（不依赖引擎实现细节） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32 位哈希 → 种子。
 *
 * 用途：把一个稳定标识符（比如 `w:ancient`）变成种子，
 * 这样**同一个词每次生成的卡片长得一样**（选项顺序、干扰项都不变），
 * 而不是"今天打开是这个顺序、明天打开换个顺序"。
 */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fisher-Yates，用传入的 rng 保证可复现。不修改入参。 */
export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
