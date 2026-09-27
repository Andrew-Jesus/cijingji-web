/**
 * 画像（`profiles`）在两台设备各有一份时，留哪一份？
 *
 * ── 规则比任务单简单得多：**最后改的那个算**（实施方案 §7.3）──────
 * 一个人只有一份画像，不存在"取并集"这回事：兴趣标签在两台设备上各勾了几个，
 * 没法把它们合起来（引擎并不知道用户是想加上还是想删掉）。所以只能选一份。
 *
 * ── 为什么判据必须是 `updated_at`，不能用 `created_at` ────────
 * `created_at` 是"什么时候建的这个号"，一个人只建一次，**永远不会变**。
 * 用它比较就等于永远选先建号的那一台 —— 后改的那次改动会被丢掉，**而且不报错**。
 * 这正是"改了两台设备的画像，只有一台生效"这类投诉的来源。
 *
 * 阶段 0 存下来的老画像没有 `updated_at`（那时还没有这个字段），
 * 由 Dexie 的 v2 升级一次性补齐（见 lib/db/local.ts）；这里仍留一道回落，
 * 因为**云端的行可能被手工改过**，不该因为一个字段缺失就判出个乱七八糟的结果。
 */

export interface ProfileLike {
  created_at: string;
  updated_at?: string;
}

/** 取"这份改动发生在什么时候"，缺 `updated_at` 时回落到 `created_at`。 */
export function profileStamp(profile: ProfileLike): string {
  return profile.updated_at ?? profile.created_at;
}

/**
 * 在"本地那份"和"云端那份"之间选一份。
 *
 * @returns 选中的那一份（**返回入参的引用**）；两边都没有时返回 `null`。
 */
export function pickProfile<T extends ProfileLike>(local: T | null, remote: T | null): T | null {
  if (!local) return remote;
  if (!remote) return local;

  // 平手（时间戳一模一样）时**保留本地**：用户此刻正看着这台设备上的样子，
  // 让他屏幕上的东西保持不变，比让他眼看画像自己变一下更不容易困惑。
  // 注意这里用 `>` 而不是 `>=`：相等就是因为这一条选了本地。
  return profileStamp(remote) > profileStamp(local) ? remote : local;
}
