/**
 * Supabase 环境变量 —— **全项目只此一处**读它。
 *
 * 为什么要单独一个文件：这两个值会在**浏览器和服务器两边**都被读到，
 * 散在各处写 `process.env.XXX` 的话，改名字时漏一个就是"配了也不生效"，
 * 而且不报错 —— 这类毛病最难查。
 *
 * ── ⚠️ 两条不能违反的写法 ─────────────────────────────────────
 *
 * ① **`process.env.NEXT_PUBLIC_SUPABASE_URL` 这种必须字面写全，不能拼。**
 *    Next.js 是在打包时做**字符串替换**的：见到这串字面量就换成真值。
 *    写成 `process.env[name]`、或先收进数组再取，替换不会发生 →
 *    浏览器里恒为 undefined。症状是"本地能跑、线上说没配置"，而且不报错。
 *
 * ② **URL 与 publishable key 本来就是公开的**，加 `NEXT_PUBLIC_` 是对的。
 *    它俩的权限靠数据库的 RLS 兜住（见规格书 §6.3：门卫可以松，保险柜不能松）。
 *    真正不能见光的那把叫 **secret key**，它**不在这个文件里**（B3 才用得上）。
 *
 * ── 关于 key 的新旧名字（2026-09-26 现查，Supabase 官方文档）─────
 * Supabase 正在把 `anon` / `service_role` 换名成
 * `publishable`（`sb_publishable_…`）/ `secret`（`sb_secret_…`），
 * 并且**2025-11 起新建的项目只发新名字的 key**，旧名字的 key 2026 年底删除。
 * 官方给的新旧对应关系是一对一的（publishable ↔ anon，secret ↔ service_role）。
 *
 * 所以这里**新旧名字都认**：新名字优先，旧名字兜底。
 * 对你（阿墨/Andy）来说只需要知道一件事：**从后台复制带 `sb_publishable_` 的那串**。
 * 万一哪天换回旧 key，代码不用动。
 */

/** 项目地址，形如 `https://abcdefgh.supabase.co`。没配就是空串 */
export function supabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
}

/** 可公开的那把 key（`sb_publishable_…`，旧名 `anon`）。没配就是空串 */
export function supabasePublishableKey(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    ""
  ).trim();
}

/**
 * 账号系统到底接没接上。
 *
 * **这个判断是全站"要不要拦人"的总闸**：
 *   · 配好了 → 走账号那套（未登录去 /login）
 *   · 没配   → **一律放行**，应用照旧以"纯本地模式"跑（阶段 0 的样子）
 *
 * 为什么没配也要能用：这样"账号系统挂了/还没接"永远不会把用户挡在门外
 * —— 数据本来就在本地，没有理由因为登录服务不通就不让人背单词。
 */
export function isSupabaseConfigured(): boolean {
  return supabaseUrl().length > 0 && supabasePublishableKey().length > 0;
}
