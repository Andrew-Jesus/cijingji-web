/**
 * 「本地这份数据，现在归谁」
 *
 * ── 为什么非要有这么一层 ──────────────────────────────────────
 * 阶段 0 没有账号，本机只有一个人用，所以所有用户层的行都把 `user_id`
 * 写死成 `"local"`（`LOCAL_PROFILE_ID`）—— 那时候这是对的。
 *
 * 阶段 1 有了账号，**这一行字就成了一个会咬人的地方**：
 *
 *   ① 登录之后新产生的那条作答记录，如果还挂 `"local"`，
 *      同步器就认不出它是谁的 → 要么漏传，要么传到别人名下。
 *   ② 更糟的是**换人用同一台设备**：A 登录答题（挂 `local`）、退出、
 *      B 登录 —— B 那一步的"认领"会把 A 的记录一起抢过去。
 *      这是**串号**，比丢数据更严重，而且用户完全看不出来。
 *
 * 所以写入侧必须知道"现在是谁"，而不是一个常量。
 *
 * ── 为什么是一个模块级变量，而不是每次都去问 Supabase ────────
 * 因为写入是同步频繁的动作（每答一题一条），而"当前是谁"在一次会话里**不变**。
 * 每次写入都去读一遍 cookie 既慢又多余（`supabase.auth.getSession()` 返回 Promise）。
 * 由 `AuthGate` 在确认登录状态之后**一次性设定**，之后所有写入读它即可。
 *
 * ── 拿不准时的取值方向 ────────────────────────────────────────
 * 没设定过、或者设成 null / 空串时，一律回到 `LOCAL_PROFILE_ID`。
 * 这个方向的含义是"当成本机数据" —— 最坏的结果是"这次同步被跳过"，
 * 而不是"把数据写到别人名下"。**宁可漏传，不可串号。**
 */

/** 没登录时用的那个 id。阶段 0 积累下来的老数据全挂着它 */
export const LOCAL_PROFILE_ID = "local";

let currentUserId: string = LOCAL_PROFILE_ID;

/**
 * 设定"现在是谁在用这台设备"。由 `AuthGate` 在确认登录状态之后调用。
 * 传 `null` = 明确表示"现在是未登录状态"，本机数据继续挂 `"local"`。
 */
export function setActiveUserId(id: string | null): void {
  currentUserId = typeof id === "string" && id.length > 0 ? id : LOCAL_PROFILE_ID;
}

/** 当前写入该用的 `user_id`。未登录时等于 `LOCAL_PROFILE_ID`。 */
export function getActiveUserId(): string {
  return currentUserId;
}

/** 现在是不是"有主人"的状态（登录了）。 */
export function hasActiveUser(): boolean {
  return currentUserId !== LOCAL_PROFILE_ID;
}

/**
 * 仅仅是给测试用的复位口子。
 * 真实代码里**不该有第二个地方调它** —— 会话的切换只有 AuthGate 一条路径，
 * 多一条路径就多一种"两个组件对当前身份看法不一致"的可能。
 */
export function __resetActiveUserIdForTest(): void {
  currentUserId = LOCAL_PROFILE_ID;
}
