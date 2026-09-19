import { describe, expect, it } from "vitest";

import { hashSeed, mulberry32, shuffle } from "./random";

describe("mulberry32 / 可复现的伪随机", () => {
  it("同一个种子 → 同一串数（这是「同种子必得同卷」的地基）", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("不同种子 → 不同序列", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("落在 [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("种子 0 也能正常出数（`>>> 0` 那步别漏）", () => {
    const rng = mulberry32(0);
    const v = rng();
    expect(Number.isFinite(v)).toBe(true);
    expect(v).not.toBe(0);
  });
});

describe("hashSeed / 字符串 → 种子", () => {
  it("同一个字符串永远同一个种子（同一个词每次的卡片长得一样）", () => {
    expect(hashSeed("w:ancient")).toBe(hashSeed("w:ancient"));
  });

  it("不同字符串给出不同种子", () => {
    expect(hashSeed("w:ancient")).not.toBe(hashSeed("w:basket"));
  });

  it("是无符号 32 位整数（负数种子会让某些实现行为不一致）", () => {
    for (const s of ["", "a", "w:ancient", "很长很长的中文字符串"]) {
      const h = hashSeed(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("shuffle / 洗牌", () => {
  it("不丢也不重复（元素集合不变）", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    expect([...shuffle(input, mulberry32(3))].sort((a, b) => a - b)).toEqual(input);
  });

  it("不修改入参", () => {
    const input = [1, 2, 3];
    shuffle(input, mulberry32(1));
    expect(input).toEqual([1, 2, 3]);
  });

  it("同种子同结果", () => {
    const input = ["a", "b", "c", "d", "e"];
    expect(shuffle(input, mulberry32(9))).toEqual(shuffle(input, mulberry32(9)));
  });

  it("空数组与单元素不炸", () => {
    expect(shuffle([], mulberry32(1))).toEqual([]);
    expect(shuffle(["x"], mulberry32(1))).toEqual(["x"]);
  });
});
