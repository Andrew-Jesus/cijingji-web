import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MOTION_ATTR, MOTION_BOOTSTRAP_SCRIPT, MOTION_REDUCED } from "@/lib/ua/wechat";

/**
 * 「首帧降级脚本」与「根布局水合标记」的**契约测试**
 *
 * ── 为什么这两件事必须绑在一起测 ──────────────────────────────
 * `app/layout.tsx` 的 `<html>` 上挂着 `suppressHydrationWarning`，它不是一个可以
 * 随手删掉的装饰 —— 它存在的**唯一理由**，就是下面那条首帧脚本会抢在 React 之前
 * 给根元素打 `data-motion`。
 *
 *   服务端渲染时不知道两件事：① 是不是微信内置浏览器（看 UA）
 *   ② 用户有没有开系统「减弱动态效果」（浏览器端偏好，不会随请求发上来）
 *   ⇒ 服务端吐的 HTML 上一定没有 `data-motion`，而客户端脚本会补上
 *   ⇒ React 水合一比对就判「不一致」，**丢掉整棵服务端 HTML 改成纯客户端重渲**
 *     （报错原文："This won't be patched up."）→ 首屏白一下，SSR 白做
 *
 * 这两半是**互为前提**的：删掉 suppress，水合报错回来；删掉脚本，降级失效。
 * 单独看哪一半都"没坏"，所以只能靠契约测试把这个因果钉住。
 *
 * ⚠️ 这些断言是**源码文本匹配**、不是行为验证（真机行为由开发模式实测覆盖：
 * 撤掉修复 → 报错 1 条；加回 → 0 条，且 `data-motion=reduced` 两种情况都在）。
 * 改动 `app/layout.tsx` 时如果换了写法导致闸门变红，那是可接受的 —— 红了就改对，
 * 别把断言放宽成"怎么写都能过"（那就等于没有闸门）。
 */

const LAYOUT = readFileSync(
  path.join(process.cwd(), "app", "layout.tsx"),
  "utf8",
);

describe("首帧动效降级 · 水合契约", () => {
  it("首帧脚本确实会给根元素打上 data-motion（降级的核心动作）", () => {
    /*
     * 不写成 `expect(SCRIPT).toContain(MOTION_ATTR)` 这种松散的包含判断 ——
     * 那即使脚本被改成只打印一行日志也照样通过。要钉就钉**完整那一次调用**。
     */
    const call = `document.documentElement.setAttribute("${MOTION_ATTR}","${MOTION_REDUCED}")`;
    expect(MOTION_BOOTSTRAP_SCRIPT).toContain(call);
  });

  it("既然脚本会改根元素属性，<html> 就必须声明 suppressHydrationWarning", () => {
    /*
     * 标签名后**必须跟空白**：这个文件里连注释都出现过 `<html>` 这个字样
     * （紧跟 `>`），不区分的话会把它一起算进来，数出"两个 html 标签"。
     */
    const htmlTags = LAYOUT.match(/<html\s[^>]*>/g) ?? [];
    expect(htmlTags).toHaveLength(1);
    expect(htmlTags[0]).toContain("suppressHydrationWarning");
  });

  it("首帧脚本仍然挂在布局里（别只顾修水合、把降级弄丢了）", () => {
    /* 认「用在哪里」而不是「引进来没有」：光有 import 语句、没挂到 JSX 上等于没接。 */
    expect(LAYOUT).toContain("__html: MOTION_BOOTSTRAP_SCRIPT");
    expect(LAYOUT).toContain("dangerouslySetInnerHTML");
  });

  it("脚本排在 <body> 里、{children} 之前 —— 首帧之前执行的前提", () => {
    const bodyAt = LAYOUT.indexOf("<body");
    const scriptAt = LAYOUT.indexOf("__html: MOTION_BOOTSTRAP_SCRIPT");
    const childrenAt = LAYOUT.indexOf("{children}");

    expect(bodyAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(bodyAt);
    expect(childrenAt).toBeGreaterThan(scriptAt);
  });
});
