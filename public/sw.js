/*
 * 小词的门房 —— 词径记的 Service Worker（2026-09-30 · B4）
 *
 * ── 它是什么 ─────────────────────────────────────────────────
 * 浏览器与网络之间的一道门。把"壳"（页面骨架、样式、脚本、图标）在本地留一份，
 * 断网时由它把自己那份递出去 —— 页面还能打开、还能接着答题。
 *
 * ── 为什么手写、不引 workbox / serwist 之类 ───────────────────
 * 阶段 1 方案里定的：**少一个会出错的变量**。这个文件拢共一百多行，但它是
 * **唯一一个装上去之后用户自己清不掉**的东西 ——
 * 引一个包进来，等于把"用户能不能看到新版本"交给一套我们没读过的构建流程。
 *
 * ── 绝不碰的三样（硬约束）──────────────────────────────────────
 *   ① **`/api/*`** —— 一律放行、绝不缓存。缓存了 AI 应答等于让用户看到别的东西。
 *   ② **跨域请求**（Supabase 等）—— 一律放行。那边有自己的鉴权与新鲜度要求。
 *   ③ **IndexedDB** —— 一个字都不动。学习数据是产品的命根子，门房只管"文件"、
 *      绝不介入"数据"（那条链是 lib/db/local.ts + lib/sync/*）。
 *
 * ── 最大的风险：用户看到旧页面 ─────────────────────────────────
 * 这是画在本批方案里的"风险最高"一条。四道闸门拦住它：
 *   ① **缓存名带版本号**（`?v=<构建号>`，单源在 lib/release/version.ts）
 *      —— 发一版换一个名字，物理上不可能读到上一版的壳；
 *   ② **`activate` 里删掉所有旧版本缓存** —— 不留着占地方，也不留着捣乱；
 *   ③ **页面（HTML）永远"先联网拿"** —— 只要联网，用户拿到的就是最新那一版；
 *   ④ **`/sw.js` 自己不缓存** —— 否则门房会把自己卡在旧版本上，那是最难救的一种。
 *
 * ⚠️ 应急开关（万一线上这个文件本身出问题）：见 README 的「B4」一节，
 *    里面写了怎么用三行让它自杀 —— 这种事不能等出事再想。
 *
 * ── 一个必须说清的边界 ─────────────────────────────────────────
 * 它**不是**"断网还能打开任何页面"。没访问过的页面，断网只有那张离线兜底页。
 * 这与阶段 1 方案 §9.4 的 C7 修正案一致：验收要的是
 * "**已经打开着的页面**断网后仍可用"，不是"断网还能刷新出来"。
 *
 * ⚠️ 本文件是**装给浏览器的脚本**，不跑在 Node 里，也不进 TypeScript 与 ESLint
 *    （见 eslint.config.mjs 的 globalIgnores）。改它的时候别指望 typecheck 帮你。
 */

/* 所有缓存名都以它开头 —— activate 里靠这个前缀认出"哪些是本门房的"，
   从而只清自己的、不误伤同域下别的东西（比如浏览器扩展留下的缓存）。 */
const PREFIX = "cijingji-";

/* 版本号从注册时的查询串里取（`/sw.js?v=<构建号>`）。
   取不到就是 "dev"（本地开发；next dev 不走 next build，没有注入值）。 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = PREFIX + VERSION;

const OFFLINE_URL = "/offline.html";

/* install 时先抓这几样。**不包括 HTML 引用到的那些脚本/样式** ——
   它们是动态哈希，写不进这个清单，靠下面的 warmShell() 在运行时补。 */
const PRECACHE = [OFFLINE_URL, "/icon.png", "/apple-icon.png", "/manifest.webmanifest"];

/* 只缓存"接口之外、且确定不可变"的路径。 */
const BYPASS_PREFIXES = ["/api/"];
const IMMUTABLE_PREFIXES = ["/_next/static/", "/_next/image"];

/**
 * 只缓存**确定拿到了完整内容**的响应。
 * `opaque`（跨域不透明响应）状态码读出来是 0，缓存它等于存了个黑洞；
 * 非 200（404 / 500 / 206 等）缓存了会让"错的"一直粘着不走。
 */
function isCacheable(response) {
  return !!response && response.status === 200 && response.type !== "opaque";
}

/**
 * 要抢先存下来的**页面**有哪些：首页，加上"用户此刻正开着的那些窗口"。
 *
 * ⚠️ 为什么必须连当前这一页一起存（2026-09-30 真机实测补上的一条）────
 * 一开始这里只存首页。实测结果是：用户打开 `/login`（或 `/study/<日期>`）
 * 之后断网刷新 → 门房手里没有这一页 → 只能递兜底页。
 * 而这一批定下的验收线恰恰是「**访问过的页面**断网后照常打开」（README 的 C7）。
 *
 * 根因是**时序**，不是策略错：门房在页面 `load` 之后才注册，
 * 所以**第一次访问的那一页**是在门房管事**之前**加载的 —— 它压根没经过我们的
 * fetch 处理器，也就没机会进缓存。等门房装好，那一页已经过去了。
 * 唯一能补回来的时机就是 install 这一刻，而"谁需要补"的答案就在 `self.clients` 里：
 * 正开着的那几个窗口，就是用户**已经看过**的页面。
 *
 * 只取 pathname（丢掉查询串）：缓存查找本来就是 ignoreSearch 的，
 * 存干净一点，也免得把 `?utm=…` 这种一次性参数当成不同的页面各存一份。
 */
async function shellPages() {
  const pages = new Set(["/"]);

  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin) continue;
        if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) continue;
        pages.add(url.pathname);
      } catch {
        /* 单个窗口的地址读不出来就跳过，不影响其余的 */
      }
    }
  } catch {
    /* 内核太老、拿不到 clients —— 至少首页还在，回到只有首页的那个老行为 */
  }

  return [...pages];
}

/**
 * 把**当前这套壳**抓齐：上面那几个页面的 HTML，以及它们引用的所有 `/_next/static/**`。
 *
 * 为什么非做不可：第一次访问这个站时，页面上的样式与脚本是在**门房装好之前**
 * 加载的 —— 它们没经过我们的 fetch 处理器，也就没进缓存。只把 HTML 存下来的话，
 * 断网刷新会得到"HTML 有了、样式和脚本没有"的半张脸（比白屏好一点，但一样不能用）。
 * 所以 install 里主动补一次。补完的效果：**第一次访问之后断网就能用**。
 *
 * ⚠️ 静态资源只认 `/_next/static/` 开头的地址（Next 给它们的内容哈希，永久可缓存），
 *    所以这里**不可能**顺手缓存到 `/api/` 之类的东西 —— 那条闸门在正则里。
 */
async function warmShell(cache) {
  const pages = await shellPages();
  const refs = new Set();
  const re = /\/_next\/static\/[A-Za-z0-9._~\-/]+/g;

  await Promise.all(
    pages.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: "reload" }));
        /*
          只存 200。**这一条挡住的是"错误页面被长期粘住"**：
          Next 对不存在的地址回一个 404 页面，它长得也像个正常页面，
          一旦存下来，那个地址以后断网打开就永远是那张 404 —— 而它可能只是
          当时部署还没跟上。宁可断网时给兜底页，也不要给一张假的 404。
          （实测踩到过：拿一个不存在的路径预热，断网刷新果然拿到 404 页。）
        */
        if (!isCacheable(res)) return;

        const html = await res.clone().text();
        await cache.put(path, res);

        let found;
        while ((found = re.exec(html)) !== null) refs.add(found[0]);
      } catch {
        /* 单页抓不到不影响别的 —— 下次联网还有机会 */
      }
    }),
  );

  await Promise.all(
    [...refs].map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: "reload" }));
      } catch {
        /* 同上 */
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      /* **逐个**抓，不用 addAll：`addAll` 是原子的，任何一条 404
         都会让整个 install 失败 —— 结果是**一个缓存都没有**，
         而失败原因只是某个可选图标不在。 */
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* 同上 */
          }
        }),
      );

      await warmShell(cache);

      /* 不等所有旧页面关掉就接管。
         我们是"页面先联网拿"的策略，所以立刻接管不会让用户看到过期内容；
         反过来，不 skipWaiting 的话，一个长期开着的标签页会把新版本一直挡在外面。 */
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /* 闸门②：删掉所有旧版本的缓存。只认自己的前缀，不误伤别人。 */
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );

      /* 立刻接管那些"门房装好之前就已经打开的"页面 ——
         否则要等它们刷新一次才受控，中间那段时间断网就还是白屏。 */
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  /* 非 GET 一律放行（表单提交、`/api/ai` 的 POST……）。 */
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  /* 闸门：跨域放行（②）、接口放行（①）、门房自己的脚本放行（④）。 */
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return;
  if (url.pathname === "/sw.js") return;

  if (req.mode === "navigate") {
    event.respondWith(navigateFirst(req));
    return;
  }

  if (IMMUTABLE_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

/**
 * 页面（HTML）：**先联网拿**，拿不到才用缓存，缓存也没有就给离线兜底页。
 *
 * 这是"用户永远看到最新版"的那条闸门③ —— 只要联网，用户拿到的就是刚部署的那一版。
 */
async function navigateFirst(req) {
  const cache = await caches.open(CACHE);

  try {
    const res = await fetch(req);
    if (isCacheable(res)) await cache.put(req, res.clone());
    return res;
  } catch {
    /* ignoreSearch：用户带着 `?utm=…` 之类的参数进来时，也认得出缓存里的那一份。 */
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;

    /* 连兜底页都没抓到（装门房时就在离线）—— 至少给一句人话，别让浏览器报错页。 */
    return new Response(
      "<!doctype html><meta charset=utf-8><title>现在没有网络</title><p>现在没有网络。</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/**
 * 不可变资源（`/_next/static/**`）：**命中缓存就直接给，不联网**。
 *
 * 为什么可以这么激进：Next 给这些文件名里带了**内容哈希** ——
 * 内容一变文件名就变，所以"缓存里那份"永远是"这个名字对应得上的那一份"，
 * 不存在"拿到旧内容"的可能（这也是线上 `Cache-Control: immutable` 的理由）。
 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    if (isCacheable(res)) await cache.put(req, res.clone());
    return res;
  } catch {
    return new Response("", { status: 504, statusText: "Gateway Timeout" });
  }
}

/**
 * 其余同源静态资源（图标、manifest、public 下的文件）：**先用缓存、后台悄悄更新**。
 * 这类文件没有内容哈希，但也不能每次都等网络 —— 所以给它"先给旧的、顺手换新的"。
 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);

  const network = fetch(req)
    .then(async (res) => {
      if (isCacheable(res)) await cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  return hit || (await network) || new Response("", { status: 504 });
}
