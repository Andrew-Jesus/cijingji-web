"use client";

/**
 * 请门房上岗 —— 注册 Service Worker（`public/sw.js`）
 *
 * 只做一件事、不画任何东西（返回 `null`）：在合适的时候把 `/sw.js` 注册上去。
 * 单独一个组件是为了让它和"小词"互不牵扯 —— 门房是应用级的基础设施，
 * 不该挂在一个界面组件的生命周期上。
 *
 * ── 三条不能改的规矩 ─────────────────────────────────────────
 *
 * ① **只在正式构建里注册**（`NODE_ENV === "production"`）。
 *    开发时也注册的话，`next dev` 下改一行代码、浏览器却给你旧页面，
 *    而且它**会跨多次 `npm run dev` 活下来** —— 排查半天最后发现是被自己的缓存骗了。
 *    这是门房这个技术最经典的自伤方式，所以直接不给它这个机会。
 *
 * ② **注册地址必须带 `?v=<构建号>`。** 门房用这个值给缓存命名（见 `public/sw.js`）。
 *    同一个地址、同样的脚本内容，浏览器**不会**认为门房更新了；
 *    带上版本号，每次发版都是一个"新的地址"，于是必然安装新门房、
 *    旧缓存在它的 `activate` 里被删掉。
 *    ⚠️ 版本号来自 `lib/release/version.ts` —— **不准在这里另拼一个**。
 *
 * ③ **等 `load` 之后再注册**，别和首屏抢带宽。
 *    门房对"这一次打开"没有任何帮助（它要下一次才起作用），所以不急。
 *
 * ── 关于 `useEffect` ─────────────────────────────────────────
 * 项目里有一条"读外部状态用 `useSyncExternalStore`、别用 `useState + useEffect`"
 * 的规矩（见 `lib/console/prefs.ts`）。那条规矩管的是**订阅可变的浏览器状态**；
 * 这里是纯粹的**一次性副作用**（注册完就没有"后续值"可言），
 * 没有 state、也不需要订阅 —— 用 `useEffect` 是正当的，不算破例。
 */
import { useEffect } from "react";
import { BUILD_ID } from "@/lib/release/version";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      /* 注册失败什么都不做：没有门房，网页照常是网页 —— 只是断网体验差一点。
         绝不给用户弹错（"装不上离线缓存"对他没有任何可操作的意义）。 */
      navigator.serviceWorker.register(`/sw.js?v=${BUILD_ID}`, { scope: "/" }).catch(() => {});
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
