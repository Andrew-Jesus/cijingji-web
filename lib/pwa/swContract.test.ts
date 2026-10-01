import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CACHE_PREFIX } from "@/lib/pwa/cache";

/**
 * 门房（Service Worker）的**契约测试**
 *
 * ── 为什么门房需要单测 ───────────────────────────────────────
 * `public/sw.js` 不跑在 Node 里，进不了 typecheck、也进不了 ESLint ——
 * 也就是说，**它是全项目唯一一段"没有任何机器看着"的代码**。
 * 而它偏偏是装上去之后用户自己清不掉的那一个。所以这里用"读源码 + 断言硬约束"
 * 的方式补上一道闸门：不验证它跑得对不对（那要靠真实浏览器实测），
 * 只保证那几条**一旦被删掉会静默出事**的规矩还在。
 *
 * 比如"放行 `/api/`"这条：删掉它不会报错、不会崩、测试也照样绿 ——
 * 只会开始缓存 AI 的应答，而用户看到的是别的东西。这种错只能靠契约测试拦。
 *
 * ⚠️ 这些断言是**源码文本匹配**，不是行为验证。改动 `public/sw.js` 时如果只是
 * 换了写法（比如把 `BYPASS_PREFIXES` 拆成两个常量），闸门会红 —— 那是可接受的：
 * 红了就把它改对，别把断言改成"怎么写都能过"（那就等于没有闸门）。
 */

const read = (...parts: string[]): string =>
  readFileSync(path.join(process.cwd(), ...parts), "utf8");

const SW = read("public", "sw.js");
const OFFLINE = read("public", "offline.html");
const CSS = read("app", "globals.css");
const REGISTRAR = read("components", "pwa", "ServiceWorkerRegistrar.tsx");
const PANEL = read("components", "console", "ConsolePanel.tsx");

/**
 * 把 globals.css 里某个令牌的值取出来，并归一成小写十六进制。
 * `rgb(164 170 176)` 与 `#a4aab0` 是同一个颜色，不归一就没法逐值比对。
 */
function token(name: string): string | undefined {
  /* 调用方写全名（`--color-page`）。这里再兜一层：只写后半段也能取到。 */
  const key = name.startsWith("--") ? name : `--${name}`;
  const found = CSS.match(new RegExp(`${key}:\\s*([^;]+);`));
  if (!found) return undefined;
  const raw = found[1].trim();

  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw.toLowerCase();

  const rgb = raw.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)$/i);
  if (rgb) {
    return (
      "#" +
      [rgb[1], rgb[2], rgb[3]]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  return raw.toLowerCase();
}

describe("门房契约 · 绝不碰的东西", () => {
  it("先确认读到的是真文件（否则下面全都是空过）", () => {
    expect(SW).toMatch(/addEventListener\("fetch"/);
    expect(SW.length).toBeGreaterThan(2000);
  });

  it("接口一律放行 —— 缓存了 /api/ 等于让用户看到别的东西", () => {
    expect(SW).toMatch(/BYPASS_PREFIXES\s*=\s*\[[^\]]*"\/api\/"/);
    expect(SW).toMatch(/BYPASS_PREFIXES\.some/);
  });

  it("跨域请求一律放行 —— Supabase 那边有自己的鉴权与新鲜度要求", () => {
    expect(SW).toMatch(/url\.origin\s*!==\s*self\.location\.origin/);
  });

  it("绝不碰 IndexedDB —— 门房只管文件，学习数据不是它的事", () => {
    /* ⚠️ 断言的是"不许**用**这个 API"，不是"不许出现这个词" ——
       门房的文件头注释里正大光明地写着"绝不碰 IndexedDB"，
       早先写成 `not.toMatch(/indexedDB/i)` 时，闸门反被这句话绊倒。
       跑不过的闸门会被人顺手删掉，那比没有更糟。 */
    expect(SW).not.toMatch(/indexedDB\s*[.[]/);
  });

  it("只缓存确定拿到完整内容的响应（不透明响应 = 状态码读不出来）", () => {
    expect(SW).toMatch(/status\s*===\s*200/);
    expect(SW).toMatch(/type\s*!==\s*"opaque"/);
  });
});

describe("门房契约 · 不让用户看到旧页面", () => {
  it("缓存名带版本号（`?v=`）—— 发一版换一个名字", () => {
    expect(SW).toMatch(/searchParams\.get\("v"\)/);
    expect(SW).toMatch(/PREFIX\s*\+\s*VERSION/);
  });

  it("activate 里删掉旧版本缓存，且只删自己前缀的", () => {
    expect(SW).toMatch(/caches\.delete\(/);
    expect(SW).toMatch(/startsWith\(PREFIX\)\s*&&\s*key\s*!==\s*CACHE/);
  });

  it("页面（HTML）走「先联网拿」 —— 只要联网就是最新那一版", () => {
    expect(SW).toMatch(/req\.mode\s*===\s*"navigate"/);
    expect(SW).toMatch(/async function navigateFirst/);
  });

  it("门房自己的脚本不走缓存 —— 否则它会把自己卡在旧版本（最难救的一种）", () => {
    expect(SW).toMatch(/url\.pathname\s*===\s*"\/sw\.js"/);
  });

  it("缓存名有独立前缀，activate 只清自己的、不误伤同域下别的东西", () => {
    expect(SW).toMatch(new RegExp(`const PREFIX\\s*=\\s*"${CACHE_PREFIX}"`));
  });
});

describe("门房契约 · 断网后「访问过的页面」要刷得出来", () => {
  /**
   * ⚠️ 这一组是 2026-09-30 **真机实测补上的**，因为当时的实现在这一条上**是错的**：
   *
   * 门房在页面 `load` 之后才注册（见 ServiceWorkerRegistrar 的规矩③），
   * 所以**第一次访问的那一页**是在门房管事**之前**加载的 —— 它没经过 fetch 处理器，
   * 压根没进缓存。而 `install` 当时只补存了首页。
   *
   * 实测症状：打开 `/login` → 断网 → 刷新 → 拿到的是离线兜底页，
   * 而这一批定下的验收线恰恰是「**访问过的页面**断网后照常打开」（README 的 C7）。
   *
   * 修法就是 `shellPages()`：首页 + `self.clients` 里此刻开着的那些窗口。
   * 下面两条盯着它别被"优化"掉 —— 删了不会报错，只会在真机上悄悄退回旧行为。
   */
  it("要抢先存下来的页面 = 首页 + 此刻开着的那些窗口", () => {
    expect(SW).toMatch(/self\.clients\.matchAll\(/);
    expect(SW).toMatch(/includeUncontrolled:\s*true/);
    expect(SW).toMatch(/new Set\(\["\/"\]\)/);
  });

  it("抓下来的页面只存 200 —— 错误页一旦被粘住，那个地址以后就永远是它", () => {
    /* 断言的是 warmShell 里的**提前返回**（navigateFirst 写的是 `if (isCacheable(res)) await`，
       文本不同，所以这一条只命中预热那条路）。 */
    expect(SW).toMatch(/if \(!isCacheable\(res\)\) return;/);
  });

  it("预热仍然只主动抓 `/_next/static/**`（不可能顺手缓存到 /api/ 之类）", () => {
    expect(SW).toMatch(/\\\/_next\\\/static\\\//);
  });
});

describe("门房契约 · 注册（ServiceWorkerRegistrar）", () => {
  it("注册地址带 ?v=<构建号> —— 不带的话浏览器认为门房没变，更新永远不生效", () => {
    expect(REGISTRAR).toMatch(/\/sw\.js\?v=\$\{BUILD_ID\}/);
  });

  it("版本号来自 lib/release/version.ts，不在这里另拼一个", () => {
    expect(REGISTRAR).toMatch(/from "@\/lib\/release\/version"/);
    expect(REGISTRAR).toMatch(/import \{ BUILD_ID \}/);
  });

  it("只在正式构建里注册 —— 开发时注册会被自己的缓存骗", () => {
    expect(REGISTRAR).toMatch(/NODE_ENV\s*!==\s*"production"/);
  });
});

describe("版本号单源（防「各处各写一份」）", () => {
  it("小词面板不再自己定义 BUILD_LABEL，改为从 lib/release/version 取", () => {
    expect(PANEL).not.toMatch(/const BUILD_LABEL\s*=/);
    expect(PANEL).toMatch(/from "@\/lib\/release\/version"/);
  });
});

describe("离线兜底页（public/offline.html）", () => {
  it("完全自包含：不引外部样式表、不引脚本、不发任何请求", () => {
    expect(OFFLINE).not.toMatch(/<link\b/i);
    expect(OFFLINE).not.toMatch(/<script\b/i);
    expect(OFFLINE).not.toMatch(/@import/i);
    expect(OFFLINE).not.toMatch(/\bsrc\s*=/i);
  });

  it("先给不透明的字色，再在 @supports 里才换透明（老内核下不会隐形）", () => {
    expect(OFFLINE).toMatch(/color:\s*#f5f7f9/);
    expect(OFFLINE).toMatch(/@supports/);
    expect(OFFLINE).toMatch(/color:\s*transparent/);
  });

  it("兜底页是「最后的最后」：连它都拿不到时还有一段人话", () => {
    expect(SW).toMatch(/现在没有网络/);
  });
});

describe("离线兜底页的颜色 ↔ 设计令牌（全项目唯一一处硬编码，必须同源）", () => {
  /**
   * ⚠️ 这一组是"闸门自己也要有闸门"：
   * 下面所有断言都靠 `token()` 从 globals.css 取值。如果哪天令牌改了名、
   * 或者 globals.css 换了写法让正则失配，`token()` 会返回 `undefined`，
   * 而 `expect(OFFLINE).toContain(undefined)` 这种写法**会静默通过** ——
   * 于是整组断言一起变成摆设。所以先单独验一次 `token()` 本身是活的。
   */
  it("核对项有效性：token() 取得到已知值，且取不到不存在的名字", () => {
    expect(token("--color-page")).toBe("#f7f5f2");
    expect(token("--no-such-token")).toBeUndefined();
  });

  it.each([
    ["#f7f5f2", "--color-page"],
    ["#3a3733", "--color-primary"],
    ["#7a736b", "--color-secondary"],
    ["#2b2a27", "--color-ink"],
    ["#39372f", "--island-ink-lit"],
    ["#1b1a18", "--island-ink-deep"],
    ["#f5f7f9", "--island-silver-1"],
    ["#d7dce2", "--island-silver-2"],
    ["#bcc2c9", "--island-silver-3"],
    ["#a4aab0", "--island-silver-4"],
  ])("兜底页的 %s 就是 globals.css 的 %s", (hex, name) => {
    expect(OFFLINE.toLowerCase()).toContain(hex);
    expect(token(name)).toBe(hex);
  });
});
