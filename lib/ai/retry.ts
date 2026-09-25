/**
 * 重试与冷却的判据 —— **纯逻辑，可单测**
 *
 * ── 这个文件解决的那个 bug ──────────────────────────────────
 * 线上实测：兜底档 GLM **每次都失败**（先是超时 12 秒，紧跟一个 429）。
 * 查下来不是网络的锅，也不是智谱的锅 —— 是**我们的重试太急**：
 *
 *   免费档并发只有 1。而我们"超时"只是**客户端不等了**，
 *   对方服务器上那一次还在跑。于是**立刻重发**第二次，
 *   一出门就撞上还在占着窗口的第一次 → 429 被拒。
 *
 * 所以这里做的三件事，都是为了"别自己撞自己"：
 *   ① **重试前先等**（退避），让上一次跑完；
 *   ② 撞上限流（429）**优先换下一档**，别把唯一的窗口耗在同一次上；
 *   ③ 余额不足 / Key 错这类**明确的死症**，给这一档打**冷却**，
 *      几分钟内直接跳过 —— 否则每次请求都要白等一轮（实测正是如此）。
 *
 * 把判据单独成文件的原因：它是**分支最多、最容易写错、又最难在真机上复现**的地方。
 * 抽成纯函数后，每种错误各写一条用例，比在生产上试出来便宜得多。
 */
import { isFatalProviderConfig, isRateLimited, isRetryable } from "./provider";

/** 一次失败之后的下一步动作 */
export type FailureAction =
  /** 同一档再试一次（会先等一段退避时间） */
  | "retry_same"
  /** 这一档放弃，换链上的下一档 */
  | "next_provider";

export interface FailureContext {
  /** 这一档已经试到第几次（0 起） */
  attemptIndex: number;
  /** 每一档最多试几次（含首次） */
  attemptsPerModel: number;
  /** 这条链上还有没有下一档可换 */
  hasNextProvider: boolean;
}

export interface FailureDecision {
  action: FailureAction;
  /** 要不要给这一档打冷却标记（"这段时间别再用它了"） */
  coolDown: boolean;
}

/**
 * 失败之后怎么走。四个分支，每个都有明确理由：
 *
 * | 失败类型 | 怎么办 | 为什么 |
 * |---|---|---|
 * | 余额不足 / Key 不对（401/402/403） | 换下一档 **+ 冷却** | 几分钟内试一百次也一样，白等 |
 * | 撞限流（429） | 有下一档就换；没有则退避后再试一次 | 免费档并发 1，硬碰只会继续 429 |
 * | 超时 / 断网 / 5xx / 输出不合格 | 还有次数就退避重试 | 多半是临时的 |
 * | 没次数了 | 换下一档 | —— |
 */
export function decideAfterFailure(err: unknown, ctx: FailureContext): FailureDecision {
  const attemptsLeft = ctx.attemptIndex + 1 < ctx.attemptsPerModel;

  // 死症：这一档的账号本身有问题，重试没有任何意义
  if (isFatalProviderConfig(err)) {
    return { action: "next_provider", coolDown: true };
  }

  // 限流：免费档并发 1，撞上说明"窗口正忙"。
  if (isRateLimited(err)) {
    // 还有别的档可换 → 痛快让位，别把唯一的窗口耗在同一次上
    if (ctx.hasNextProvider) return { action: "next_provider", coolDown: false };
    // 它已经是最后一档了 → 只能退避后再试一次（否则这一句就彻底丢了）
    return { action: attemptsLeft ? "retry_same" : "next_provider", coolDown: false };
  }

  if (isRetryable(err) && attemptsLeft) {
    return { action: "retry_same", coolDown: false };
  }
  return { action: "next_provider", coolDown: false };
}

/* ══════════════════════════ 冷却表 ══════════════════════════ */

export interface CooldownStore {
  /** 这一档现在是不是在冷却中 */
  isCooling(provider: string, nowMs: number): boolean;
  /** 把这一档冷冻一段时间 */
  cool(provider: string, durationMs: number, nowMs: number): void;
  /** 解冻（测试用） */
  clear(provider: string): void;
  /** 全部清空（测试用） */
  reset(): void;
  /** 解冻时刻；没在冷却则为 null（排查用） */
  until(provider: string): number | null;
}

/**
 * 进程内的冷却表。
 *
 * ⚠️ **尽力而为，不是正确性依赖**：进程重启就清空，在 Vercel 上每个实例各记各的。
 * 所以它失效的后果仅仅是"多试一次"，不会让结果出错 —— 这一点很重要，
 * 否则就得为了它引入共享存储（Redis），那对一个还没用户的产品是纯负担。
 */
export function createCooldownStore(): CooldownStore {
  const map = new Map<string, number>();
  return {
    isCooling(provider, nowMs) {
      const until = map.get(provider);
      if (until === undefined) return false;
      if (until <= nowMs) {
        map.delete(provider); // 过期的顺手清掉，免得这张表只涨不消
        return false;
      }
      return true;
    },
    cool(provider, durationMs, nowMs) {
      map.set(provider, nowMs + Math.max(0, durationMs));
    },
    clear(provider) {
      map.delete(provider);
    },
    reset() {
      map.clear();
    },
    until(provider) {
      return map.get(provider) ?? null;
    },
  };
}

/** 全局共享的那一份 —— 服务端所有请求共用一个实例（这就是冷却能生效的前提） */
export const providerCooldown = createCooldownStore();

/** 默认的等待实现。抽出来是为了单测里能注入"立刻返回"，不必真的等 1.2 秒 */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
