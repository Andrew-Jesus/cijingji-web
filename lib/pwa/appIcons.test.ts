import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * App 图标（`app/` 下那三张）的**契约测试**
 *
 * ── 为什么这件事值得单测 ─────────────────────────────────────
 * `app/apple-icon.png` 是「添加到 iPhone 主屏」用的那张。
 * **iOS 不允许图标里有透明像素** —— 它会先画一块圆角方形的底，
 * 把图标合成上去，再把所有透明的地方一律填成**纯黑**。
 *
 * 而我们在 2026-10-01 之前给 iPhone 的，正是**内切圆、四角透明**那张
 * （因为安卓允许透明，那张在安卓上一切正常）。后果是深墨圆片外面裹了
 * 一层纯黑方底、圆与方之间一道看得见的弧线 —— 按 iOS 规则模拟，
 * 圆角方之内 **17.9%** 的面积会被填黑。
 *
 * ⚠️ **这个错在桌面浏览器里完全看不出来**：浏览器只把 apple-touch-icon
 * 当普通图片显示，透明处就是透明的。只有真加到 iPhone 主屏才现形，
 * 而 iOS 还会缓存主屏图标（装完才发现的话，得先删掉再重装一次）。
 *
 * 所以这条断言买的不是"图标好不好看"，而是**拦住"有人把它改回内切圆"** ——
 * 生成脚本里那句 alpha 自检只在 `maskable=True` 这条路上生效，
 * 谁把调用改回 `render(180)`，自检就绕过去了，而且一路绿灯。
 *
 * ⚠️ 与 `swContract.test.ts` / `manifestIcons.test.ts` 同一路数：
 * **读文件 + 断言事实**，不是行为验证。
 */

const ROOT = process.cwd();

/* ── 最小 PNG 解码器 ────────────────────────────────────────────
 * 测试要为"有没有透明像素"下结论，就必须真的看到 alpha 通道的每个值。
 * 但为读一个数字把 sharp / pngjs 拖进依赖并不划算，所以这里自己解：
 * PNG 的像素是「逐行滤波 + zlib 压缩」，Node 自带 zlib，反演滤波器也就几十行。
 *
 * 只认我们产物实际会有的形态（8 位、非隔行、RGBA/RGB）；
 * **遇到别的形态直接抛错，不静默跳过** —— 静默跳过等于这条测试失效，
 * 而"失效的测试"比"没有测试"更危险。
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  w: number;
  h: number;
  rgba: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 把一行**已压缩态**的字节还原成实际像素值（原地改写 line）。 */
function unfilter(type: number, line: Buffer, prev: Buffer, bpp: number): void {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0: // None
        break;
      case 1: // Sub
        line[i] = (line[i] + left) & 0xff;
        break;
      case 2: // Up
        line[i] = (line[i] + up) & 0xff;
        break;
      case 3: // Average
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
        break;
      case 4: // Paeth
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`未知的 PNG 行滤波类型 ${type}`);
    }
  }
}

function decodePng(file: string): Png {
  const buf = readFileSync(file);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error(`${file} 不是 PNG`);

  let at = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len; // 长度(4) + 类型(4) + 数据 + CRC(4)
  }

  if (depth !== 8) throw new Error(`${file} 位深 ${depth}，本解码器只认 8 位`);
  if (interlace !== 0) throw new Error(`${file} 用了隔行扫描，本解码器不支持`);
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`${file} 色型 ${colorType}，本解码器只认 6(RGBA) / 2(RGB)`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < h; y += 1) {
    const rowAt = y * (stride + 1);
    const filter = raw[rowAt];
    const line = Buffer.from(raw.subarray(rowAt + 1, rowAt + 1 + stride));
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < w; x += 1) {
      const s = x * channels;
      const t = (y * w + x) * 4;
      rgba[t] = line[s];
      rgba[t + 1] = line[s + 1];
      rgba[t + 2] = line[s + 2];
      rgba[t + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { w, h, rgba };
}

/** alpha 通道的取值范围。全不透明 ⇒ { min: 255, max: 255 }。 */
function alphaRange(file: string): { min: number; max: number } {
  const { rgba } = decodePng(file);
  let min = 255;
  let max = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < min) min = rgba[i];
    if (rgba[i] > max) max = rgba[i];
  }
  return { min, max };
}

const at = (...p: string[]) => path.join(ROOT, ...p);

/* ── 先自证解码器可信，再拿它下结论 ─────────────────────────────
 * 自己写的解码器最怕"写反了"：比如始终返回 255，那上面那条断言就永远绿。
 * 所以拿两张**已知答案**的图各判一次 —— 一张必然有透明（普通版是内切圆），
 * 一张必然没有（满幅版）。两条都过，才说明这个解码器真的在读数。
 */
describe("先验解码器本身：它读得出「有透明」也读得出「没透明」", () => {
  it("普通版 app/icon.png 是内切圆 ⇒ 四角必然透明", () => {
    const r = alphaRange(at("app", "icon.png"));
    expect(r.min, "读不到任何透明像素 ⇒ 解码器可能写成了「恒为 255」").toBe(0);
  });

  it("满幅版 public/icon-maskable-512.png 铺满 ⇒ 一个透明像素都没有", () => {
    const r = alphaRange(at("public", "icon-maskable-512.png"));
    expect(r, "读到了透明像素 ⇒ 解码器可能写成了「恒有透明」").toEqual({
      min: 255,
      max: 255,
    });
  });
});

describe("iPhone 主屏图标 · 不许有透明像素", () => {
  it("app/apple-icon.png 是 180×180", () => {
    const png = decodePng(at("app", "apple-icon.png"));
    expect({ w: png.w, h: png.h }).toEqual({ w: 180, h: 180 });
  });

  it("alpha 全 255 —— 否则 iOS 会把四个角填成纯黑", () => {
    const r = alphaRange(at("app", "apple-icon.png"));
    expect(
      r,
      "apple-icon.png 出现了透明像素。iOS 不认透明：它会先画一块圆角方形的底、" +
        "把图标合成上去，再把透明处一律填成纯黑 —— 圆片外面裹一层黑方底，" +
        "圆与方之间会出现一道看得见的弧线。" +
        "★ 这个错在桌面浏览器里**完全看不出来**，只有真加到 iPhone 主屏才现形。" +
        "修法：scripts/gen-app-icon.py 里那张必须走 render(APPLE_PX, maskable=True)，" +
        "改成 render(APPLE_PX) 就会退化成内切圆。",
    ).toEqual({ min: 255, max: 255 });
  });
});
