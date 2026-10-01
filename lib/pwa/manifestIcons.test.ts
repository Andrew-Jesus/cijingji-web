import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";

/**
 * 主屏图标清单的**契约测试**
 *
 * ── 为什么这件事值得单测 ─────────────────────────────────────
 * "清单里写了一个不存在的图标文件"属于**没人会立刻发现**的那类错：
 * 构建照绿、页面照开、桌面浏览器照常显示标签页图标 ——
 * 只有用户真去"添加到主屏"时才缺一块图，而**那时候没有人盯着控制台**。
 *
 * 同理"清单说 192、文件其实是 512"也不会报错，只会让浏览器挑错档。
 *
 * 所以这里做的不是"验证图标好不好看"（那要在真机上看），
 * 而是把那几条**一旦对不上就静默出事**的对应关系钉住：
 *   ① 清单点名的每个文件都真的在；
 *   ② 声明的尺寸与文件里的真实尺寸一致；
 *   ③ maskable 与 any **分开声明**（不许写 "any maskable"）；
 *   ④ manifest 里的 PNG 都在门房的预缓存名单里（否则断网时装主屏会缺图）。
 *
 * ⚠️ 与 `swContract.test.ts` 同一路数：**读文件 + 断言事实**，不是行为验证。
 */

const ROOT = process.cwd();

/** manifest 的 src（`/icon.png`）对应的实体只会在这两处之一 */
const ASSET_DIRS = ["public", "app"];

function resolveAsset(src: string): string | null {
  const rel = src.replace(/^\//, "");
  for (const dir of ASSET_DIRS) {
    const full = path.join(ROOT, dir, rel);
    try {
      readFileSync(full);
      return full;
    } catch {
      /* 换个目录继续找 */
    }
  }
  return null;
}

/**
 * 从 PNG 头里读真实宽高。
 * PNG 的 IHDR 固定落在这一串偏移上（16 起是宽、20 起是高，大端 32 位），
 * 所以不需要任何图片解码库 —— 这正是我们想要的：测试不该为了读两个数字拖进依赖。
 */
function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error(`${file} 不是 PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 从 ICO 头里读出内嵌的每一档边长（宽高都是单字节，0 表示 256）。 */
function icoSizes(file: string): number[] {
  const buf = readFileSync(file);
  const count = buf.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    sizes.push(buf[at] === 0 ? 256 : buf[at]);
  }
  return sizes;
}

const ICONS = manifest().icons ?? [];
const SW = readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");

describe("图标清单 · 点名的文件必须真的在、尺寸必须对得上", () => {
  it("清单不为空，且每一项都有 src", () => {
    expect(ICONS.length).toBeGreaterThan(0);
    for (const icon of ICONS) expect(icon.src).toBeTruthy();
  });

  it.each(ICONS.map((i) => [i.src, i.sizes, i.type] as const))(
    "%s 文件存在，且 %s 与真实尺寸一致",
    (src, sizes) => {
      const file = resolveAsset(src);
      expect(file, `${src} 找不到实体文件（查过 public/ 与 app/）`).not.toBeNull();

      const declared = sizes ?? "";
      if (src.endsWith(".png")) {
        const { w, h } = pngSize(file as string);
        expect(declared, `${src} 声明的尺寸与文件不符`).toBe(`${w}x${h}`);
      } else if (src.endsWith(".ico")) {
        /* ico 是多档合一的，声明的那一档**必须真在里面** */
        const side = Number(declared.split("x")[0]);
        expect(icoSizes(file as string), `${src} 里没有 ${side}px 这一档`).toContain(side);
      }
    },
  );
});

describe("图标清单 · 两类用途必须分开声明", () => {
  it("既有 any（普通版）也有 maskable（满幅版）", () => {
    const purposes = ICONS.map((i) => i.purpose ?? "any");
    expect(purposes, "缺少普通版图标").toContain("any");
    expect(purposes, "缺少满幅（maskable）图标").toContain("maskable");
  });

  it('不许出现 "any maskable" —— 两种场合里必有一种不对', () => {
    for (const icon of ICONS) {
      /* 只给 maskable 的图当普通图用：不认 maskable 的地方会看到一整块方料、字偏小；
         反过来只给普通图：安卓会把它塞进自画的底色里，圆片外露出一圈白边。
         所以规范要求分开，这里把它钉住。 */
      expect(String(icon.purpose ?? ""), `${icon.src} 混用了两种用途`).not.toMatch(
        /any[ ,]+maskable|maskable[ ,]+any/,
      );
    }
  });
});

describe("图标清单 · 与门房的预缓存名单对得上", () => {
  it("清单里的每张 PNG 都在 sw.js 的 PRECACHE 里", () => {
    /* 图标**不被 HTML 引用**，只在"装到主屏"时由系统按 manifest 去取。
       门房不主动存的话，断网状态下装出来的图标就是空的 —— 而这不会报任何错。 */
    const notCached = ICONS.filter((i) => i.src.endsWith(".png"))
      .map((i) => i.src as string)
      .filter((src) => !SW.includes(`"${src}"`));
    expect(notCached, "这些图标没进门房的预缓存名单").toEqual([]);
  });
});
