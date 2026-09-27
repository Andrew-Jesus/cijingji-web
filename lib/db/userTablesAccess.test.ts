/**
 * 门禁：**用户层五张表只准由 `lib/db` 与 `lib/sync` 里的代码直接碰**。
 *
 * ── 为什么值得为它单独写一条测试（不是形式主义）──────────────
 * 这条规矩原本只写在 `studyRepo.ts` 的文件头注释里（"页面与纯函数只认这个接口"）。
 * 而 `app/(app)/page.tsx` 里有一行 `db.review_logs.toArray()` 就那样躺了很久 ——
 * **没有任何东西会报错**：typecheck 过、lint 过、测试全绿。
 * 直到做 B2 给读取侧加"只看属于自己的行"时才暴露：漏改的那一处，正是首页。
 *
 * 结论：靠注释维持的规矩 ≈ 没有规矩。**这类"静默失效"只能靠机器盯。**
 *
 * ── 为什么允许 lib/db 与 lib/sync ──────────────────────────────
 * 它们就是"唯一碰数据库的那一层"：`lib/db` 是仓库层本身，
 * `lib/sync` 是同步器（它按设计要整表读，再自己按主人筛，见 `ownedBy`）。
 * 页面与组件绕过它们，就等于绕过了"筛主人"这一步 —— 那正是串号的发生方式。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** 项目根（本文件在 lib/db/ 下，往上两层） */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 允许直接访问用户层表的两处（相对项目根，统一用正斜杠） */
const EXEMPT = ["lib/db", "lib/sync"];

/**
 * 用户层表名。**内容层不算** —— 那些是所有人共用的只读词库，
 * 谁读、读多少都不涉及"这是谁的数据"。
 */
const USER_TABLES = ["profiles", "daily_plans", "review_logs", "user_examples", "ai_usage"];

const PATTERN = new RegExp(`db\\.(${USER_TABLES.join("|")})\\b`);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    // 只管源码；测试文件自己要造数据，不受这条规矩约束
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("用户层表的访问边界", () => {
  it("除 lib/db 与 lib/sync 外，没有代码直接读用户层表", () => {
    const offenders: string[] = [];

    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replaceAll("\\", "/");
        if (EXEMPT.some((prefix) => rel.startsWith(`${prefix}/`))) continue;

        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .forEach((line, index) => {
            // 注释里提到表名是正常的（比如本文件）。只挑真正的代码行。
            const trimmed = line.trim();
            if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
              return;
            }
            if (PATTERN.test(line)) {
              offenders.push(`${rel}:${index + 1}  ${trimmed.slice(0, 90)}`);
            }
          });
      }
    }

    expect(
      offenders,
      "这些地方绕过了仓库层。请改用 lib/db/studyRepo.ts 里自带「只看自己」过滤的读取口",
    ).toEqual([]);
  });
});
