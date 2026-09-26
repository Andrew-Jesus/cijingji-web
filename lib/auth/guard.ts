/**
 * 门卫的判断规则 —— 纯函数，能单测。
 *
 * 组件只负责"读结论、执行动作"，规则一律收在这里。
 * 理由与 lib/console/dock.ts 一样：判断散在组件里，改一处漏一处。
 *
 * ── 这个文件存在的真正原因：**失败方向** ─────────────────────
 * 判断"这人登录了没有"有三种结果，不是两种：
 *   · 有 session      → 放行
 *   · 明确没有        → 去登录页
 *   · **读不出来**    → ？   ← 关键就在这一格
 *
 * 第三种是超时/报错（断网、Supabase 抖动）。它**必须放行**，理由：
 *   ① 数据安全靠数据库的 RLS 强制，界面门卫只决定"给你看哪个页面"
 *      —— 放进来也拿不到别人的数据，所以放行不会出事；
 *   ② 反过来，一旦"读不出来 = 没登录"，网络抖一下就把正在背单词的人踢去登录页，
 *      而他的进度全在本地、本来根本不需要网 —— 这是**为了安全牺牲掉可用性，
 *      却一点安全都没换来**，纯亏。
 *
 * 一句话：**门卫可以松，保险柜不能松。**（规格书 §6.3）
 */

/**
 * 读"本机有没有登录凭据"的三种结果。
 *
 * 注意它读的是**本地 cookie**，不联网 —— 所以断网也读得到。
 * 用 `getSession()` 而不是 `getUser()`：后者每次都联网问服务器，
 * 断网必然失败，那就正好落进上面说的"为了安全牺牲可用性"。
 */
export type SessionRead = "session" | "none" | "unknown";

/** 页面该不该拦 */
export type GuardDecision = "allow" | "to-login";

/**
 * 受保护页面（`/`、`/study/…`）该放行还是送去登录页。
 *
 * @param configured 账号系统接上了没有（没接上就完全不管）
 * @param read       本地凭据的读取结果
 */
export function decideGuard(configured: boolean, read: SessionRead): GuardDecision {
  if (!configured) return "allow";
  if (read === "none") return "to-login";
  return "allow";
}

/** 登录页该显示表单，还是"你已经登录了，回首页去" */
export function decideLoginEntry(configured: boolean, read: SessionRead): "form" | "to-home" {
  // 只有**确定**已登录才弹回去；读不出来时显示表单更糟（用户会以为账号丢了），
  // 所以"读不出来"当"没登录"处理 —— 让他重新登一次，代价比误弹回去小。
  return configured && read === "session" ? "to-home" : "form";
}
