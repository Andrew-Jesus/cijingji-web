/**
 * 编号规则的单测 + 一道门禁（2026-09-28 · 洞五）
 *
 * 这里只盯一件事：**两个账号在同一台设备上会不会撞号**。
 * 撞号的后果不是"多一条"，是"少一条" —— 主键相同，后写的把先写的顶掉，
 * 而且不报错。所以它必须能被穷举验证，不能靠"看着对"。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { exampleIdFor, planIdFor } from "./ids";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const A = "69ca3301-2648-4945-bd25-069cdf2e7d23";
const B = "8f1b7c22-1111-2222-3333-444455556666";

describe("planIdFor：任务单编号", () => {
  it("同一天、同一个人 → 永远同一个 id（重复进入同一天拿到的是同一份）", () => {
    expect(planIdFor("2026-09-28", A)).toBe(planIdFor("2026-09-28", A));
  });

  it("★ 同一天、两个人 → 必须是两个 id（否则后写的顶掉先写的）", () => {
    expect(planIdFor("2026-09-28", A)).not.toBe(planIdFor("2026-09-28", B));
  });

  it("★ 未登录的 local 与已登录的账号也不能撞", () => {
    expect(planIdFor("2026-09-28", "local")).not.toBe(planIdFor("2026-09-28", A));
  });

  it("编号里带得出日期与主人 —— 出问题时一眼看得出是谁哪天的", () => {
    expect(planIdFor("2026-09-28", A)).toBe(`plan:${A}:2026-09-28`);
  });

  it("不同日期仍是不同 id（原有的「一天一份」没有被改坏）", () => {
    expect(planIdFor("2026-09-28", A)).not.toBe(planIdFor("2026-09-29", A));
  });
});

describe("exampleIdFor：例句编号", () => {
  it("同一个人、同一个词、同一种兴趣 → 同一个 id（不会存出两条）", () => {
    expect(exampleIdFor("w:apple", "篮球", A)).toBe(exampleIdFor("w:apple", "篮球", A));
  });

  it("★ 同词同兴趣、两个人 → 必须是两个 id（否则一个人看到另一个人兴趣的句子）", () => {
    expect(exampleIdFor("w:apple", "篮球", A)).not.toBe(exampleIdFor("w:apple", "篮球", B));
  });

  it("同一个人换个兴趣 → 换 id（可以同时留着两种兴趣的例句）", () => {
    expect(exampleIdFor("w:apple", "篮球", A)).not.toBe(exampleIdFor("w:apple", "游戏", A));
  });

  it("编号里带得出词与主人", () => {
    expect(exampleIdFor("w:apple", "篮球", A)).toBe(`ex:${A}:w:apple:篮球`);
  });
});

describe("★ 回归闸门一：编号里必须一直带着主人", () => {
  const users = ["local", A, B];
  const dates = ["2026-09-27", "2026-09-28"];
  const words = ["w:apple", "w:banana"];
  const tags = ["篮球", "游戏"];

  it("所有「主人 × 日期」组合两两不同 —— 漏掉主人就一定有重复", () => {
    const ids = users.flatMap((u) => dates.map((d) => planIdFor(d, u)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("所有「主人 × 词 × 兴趣」组合两两不同", () => {
    const ids = users.flatMap((u) => words.flatMap((w) => tags.map((t) => exampleIdFor(w, t, u))));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("不写主人时才会撞 —— 这条用例就是那份「为什么不能省」的证据", () => {
    // 反证：如果编号只由「日期」决定，两个人的 id 完全一样。
    const withoutOwner = (d: string) => `plan:${d}`;
    expect(withoutOwner("2026-09-28")).toBe(withoutOwner("2026-09-28"));
    expect(planIdFor("2026-09-28", A)).not.toBe(withoutOwner("2026-09-28"));
  });
});

/**
 * 门禁：**编号拼接只准出现在 `lib/db/ids.ts` 一处**。
 *
 * 起因很具体：这次改编号，除了"生成"这一侧，还有"迁移存量数据"那一侧
 * （`local.ts` 的 v3 升级事务）。两处各拼一遍字符串的话，
 * 以后改了生成规则忘了改迁移，存量数据的编号就永远留在旧格式上 ——
 * 而表现是"升级完看着好好的，一同步就撞主键"，极难查。
 */
describe("★ 回归闸门二：编号拼接不许出现第二处", () => {
  const ONLY_HOME = "lib/db/ids.ts";
  const PATTERN = /`(plan|ex):\$\{/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, out);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("除了 lib/db/ids.ts，没有别处自己拼编号", () => {
    const offenders: string[] = [];

    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replaceAll("\\", "/");
        if (rel === ONLY_HOME) continue;

        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .forEach((line, index) => {
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
      "请改用 lib/db/ids.ts 里的 planIdFor / exampleIdFor —— 迁移代码也要用同一份规则",
    ).toEqual([]);
  });
});
