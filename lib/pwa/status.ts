import type { OfflineSnapshot } from "@/lib/console/probe";

/**
 * 门房（离线缓存）状态 → 一行人话。给小词的开发者模式用。
 *
 * ── 为什么一个 5 行的函数也要单独放、还要有单测 ────────────────
 * 因为**这条线出问题时，界面上没有任何地方会红**。
 * 用户只会说"打不开"，而我们在本机又复现不出来（本机从来没有那个缓存）。
 * 于是这行字就是唯一的线索 —— 它的每一档措辞都必须准确。
 *
 * 尤其第三档「已登记 · 再打开一次即可接管」：它**看着像坏了，其实只是还没生效**
 * （门房装好的那一刻还不接管当前页面，要下一次打开才接手）。
 * 措辞里不写清这一句，排查的人会往错的方向找半天。
 *
 * ⚠️ 纯函数、不读环境。所以 `过程` 里的 `navigator` / `caches` 一概不碰 ——
 * 那些读数在 `lib/console/probe.ts` 的 `probeOffline()` 里做。
 */
export function offlineLabel(snapshot: OfflineSnapshot | null | undefined): string {
  if (!snapshot) return "检测中…";

  /* 老浏览器，或者不是安全上下文（http 而没走 localhost）—— 门房天然装不上。 */
  if (!snapshot.supported) return "浏览器不支持";

  if (!snapshot.registered) return "未启用";

  if (!snapshot.controlled) return "已登记 · 再打开一次即可接管";

  return `已接管 · ${snapshot.cacheVersion ?? "暂无缓存"}`;
}
