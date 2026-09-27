/**
 * 同一天的任务单，两台设备各排过一份 —— 该留哪一份？
 *
 * ── 为什么只有这一处需要"判谁赢"（实施方案 §7.3）──────────────
 * 四张同步表里，另外三张天生不会冲突：
 *   · `review_logs` —— 流水账，只增不改，两台设备的记录**并起来就是全集**
 *   · `profiles` —— 一个人只有一份画像，比 `updated_at`，最后改的那个算
 *   · `user_examples` —— 主键是 `(词, 兴趣)`，同一个键的内容就是同一个意思，覆盖无副作用
 * 只有 `daily_plans` 会在两台设备上各长出一份"同一天"的单子。
 *
 * ── 规则：取"进度更靠前"的那份 ────────────────────────────────
 *   done(3) > in_progress(2) > pending(1) > skipped(0)
 * 同级时比 `items.length`（排的词更多的），仍相同则**保留本地**（用户正在用的这台优先）。
 *
 * ── 为什么不是"取 `generated_at` 更新的"★ ─────────────────────
 * 因为**更新的那份不等于用户实际在做的那份**。
 * 真实场景：手机上已经做了 8 个词（`in_progress`），电脑上刚打开首页顺手续排了一份
 * （`pending`、时间更新）。按时间取就会把手机上的进度**打回原点** ——
 * 用户看到的是"我刚做的题没了"。这正是验收 V1（进度不丢）要死守的那条线。
 *
 * ── 纯函数，不碰数据库、不改入参 ──────────────────────────────
 * 合并是"最容易出静默错"的地方：判错了不会报错，只会让某个人的进度消失。
 * 所以它必须能被单测穷举，**绝不能夹带读写**。
 */

/** 状态 → 进度名次。数字越大 = 越靠前 = 越应该被保留。 */
const STATUS_RANK: Record<string, number> = {
  done: 3,
  in_progress: 2,
  pending: 1,
  skipped: 0,
};

/**
 * 没见过的状态值按最低名次算。
 *
 * ⚠️ 这意味着**将来如果新增一个"进度更靠前"的状态（比如 reviewing），必须回来改这张表**，
 * 否则它在合并时会输给一切老状态。这条注释就是那个提醒本身。
 */
const UNKNOWN_STATUS_RANK = 0;

export interface PlanLike {
  status: string;
  items: readonly unknown[];
}

function rankOf(status: string): number {
  return STATUS_RANK[status] ?? UNKNOWN_STATUS_RANK;
}

/**
 * 在"本地那份"和"云端那份"之间选一份。
 *
 * @returns 选中的那一份（**返回的是入参的引用，不是拷贝** —— 调用方需要知道自己拿到的是哪边）；
 *          两边都没有时返回 `null`。
 */
export function pickPlan<T extends PlanLike>(local: T | null, remote: T | null): T | null {
  // 只有一边有 → 没什么可争的。这也覆盖了"新设备第一次登录"和"上传新计划"两种常态。
  if (!local) return remote;
  if (!remote) return local;

  const localRank = rankOf(local.status);
  const remoteRank = rankOf(remote.status);
  if (localRank !== remoteRank) {
    return localRank > remoteRank ? local : remote;
  }

  // 进度名次一样：谁排的词多听谁的（多出来的那些词是实打实想背的）
  if (local.items.length !== remote.items.length) {
    return local.items.length > remote.items.length ? local : remote;
  }

  // 完全打平：保留本地。用户此刻正用着这台设备，
  // 让他看到"自己屏幕上那份"永远比让他看到"别处的另一份"更不容易困惑。
  return local;
}
