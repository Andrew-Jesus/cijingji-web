/**
 * 门禁：**`service_role`（secret key）那条链绝不能被客户端摸到**
 *
 * ── 为什么不用官方的 `import "server-only"` ─────────────────────
 * 那个写法能在构建期拦住误引用，是官方推荐。这里不用的唯一理由是
 * **本项目单测跑在 vitest 里**，而 vitest 的 Node 环境解析不到 `server-only`
 * 这个包（Next 只在它自己的打包器里把它 alias 成内置空模块）。
 * 为它装一个包、或再配一条 alias，代价大于收益。
 *
 * ── 这条测试在防什么（防的是"间接引用"）──────────────────────
 * 只检查"有没有文件直接 import admin.ts"是不够的：
 * 真实的事故长这样 —— 甲文件 import 了 admin，乙文件是个 `"use client"` 组件，
 * 它 import 了甲。**甲完全无辜，泄漏却是从乙发生的**。
 * 所以这里顺着 import 关系**反向搜一遍**：从 `admin.ts` 出发往回走，
 * 凡是能走到它的文件，只要是客户端模块就当场失败。
 *
 * ── 还有一道更硬的闸门在后面 ─────────────────────────────────
 * 这条是**静态**检查（快、改完立刻知道）。真正的判据是构建之后拿产物核对：
 * ```
 * npm run build
 * grep -rl "<secret key 的前 20 个字符>" .next/static   # 必须没有任何输出
 * ```
 * 那条验的是"产物里到底有没有"，静态检查再全也只是它的前置。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** 项目根（本文件在 lib/supabase/ 下，往上两层） */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 唯一的秘密入口。反向搜索就是从这里出发的 */
const SECRET_ENTRY = "lib/supabase/admin.ts";

/** 秘密环境变量的读取点：**必须只有 admin.ts 一处** */
const SECRET_ENV = "SUPABASE_SECRET_KEY";
const SECRET_ENV_OWNER = "lib/supabase/admin.ts";

const SOURCE_DIRS = ["app", "components", "lib"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    // 只管源码；测试文件自己不参与打包，不受这条规矩约束
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).replaceAll("\\", "/");

/** 文件里所有"指向本地模块"的 import 说明符（`./x`、`../x`、`@/x`） */
function localImports(source: string): string[] {
  const specs: string[] = [];
  // `from "…"` 覆盖 import / export … from；再单独收裸 import "…"
  const patterns = [/from\s+["']([^"']+)["']/g, /import\s+["']([^"']+)["']/g];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (spec.startsWith(".") || spec.startsWith("@/")) specs.push(spec);
    }
  }
  return specs;
}

/**
 * 说明符 → 项目相对路径。
 * 返回多个候选是因为引用可以省扩展名、也可以指向目录（`@/lib/db` → `lib/db/index.ts`）。
 */
function resolveSpec(spec: string, fromFile: string): string[] {
  const base = spec.startsWith("@/")
    ? join(ROOT, spec.slice(2))
    : resolve(dirname(fromFile), spec);

  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ].map(rel);
}

function isClientModule(source: string): boolean {
  // `"use client"` 必须是文件最前面的指令之一，扫前几行就够
  return source
    .split(/\r?\n/)
    .slice(0, 5)
    .some((line) => /^["']use client["'];?\s*$/.test(line.trim()));
}

interface Graph {
  files: Map<string, string>;
  /** 被引用者 → 引用它的人（反向边） */
  importers: Map<string, Set<string>>;
}

function buildGraph(): Graph {
  const files = new Map<string, string>();
  const importers = new Map<string, Set<string>>();

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const key = rel(file);
      files.set(key, readFileSync(file, "utf8"));
    }
  }

  for (const [key, source] of files) {
    for (const spec of localImports(source)) {
      for (const target of resolveSpec(spec, join(ROOT, key))) {
        if (!files.has(target)) continue;
        const set = importers.get(target) ?? new Set<string>();
        set.add(key);
        importers.set(target, set);
      }
    }
  }

  return { files, importers };
}

describe("secret key 的边界", () => {
  it("没有任何 `use client` 模块能（直接或间接）引用到 secret key 那条链", () => {
    const { files, importers } = buildGraph();

    // 从 admin.ts 反向 BFS：谁引用了它、谁又引用了那个谁……
    const seen = new Set<string>([SECRET_ENTRY]);
    const queue = [SECRET_ENTRY];
    const offenders: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const importer of importers.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (isClientModule(files.get(importer) ?? "")) offenders.push(importer);
        queue.push(importer);
      }
    }

    expect(
      offenders,
      "这些客户端模块能顺藤摸到 lib/supabase/admin.ts —— secret key 会跟着被打进浏览器产物。" +
        "请把用到它的那部分代码挪进服务端（Route Handler / Server Action），或改成通过接口调用",
    ).toEqual([]);
  });

  it("`SUPABASE_SECRET_KEY` 只有 admin.ts 一处读得到", () => {
    const { files } = buildGraph();
    const readers = [...files.entries()]
      .filter(([key, source]) => key !== SECRET_ENV_OWNER && source.includes(SECRET_ENV))
      .map(([key]) => key);

    expect(
      readers,
      "环境变量名散在多处时，将来改名会漏掉某一处 —— 症状是「配了但不生效」，而且不报错",
    ).toEqual([]);
  });

  it("反向搜索本身是有效的（拿一条已知存在的引用验一下）", () => {
    // 没有这条，上面两条即使"因为没扫到任何 import"而通过也看不出来。
    // 两层都验：direct（谁 import 了 admin）与 indirect（谁 import 了那个谁）
    const { importers } = buildGraph();
    expect(importers.get(SECRET_ENTRY)?.has("lib/ai/usageCloud.ts")).toBe(true);
    expect(importers.get("lib/ai/usageCloud.ts")?.has("app/api/ai/route.ts")).toBe(true);
  });
});
