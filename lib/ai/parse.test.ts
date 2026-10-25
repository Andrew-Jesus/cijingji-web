import { describe, expect, it } from "vitest";

import { extractJsonObject, parseClozePayload, parseExamplePayload, stripCodeFence } from "./parse";

describe("extractJsonObject / 括号配平扫描", () => {
  it("普通 JSON 对象", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("前面有解释文字 → 从第一个 { 开始", () => {
    expect(extractJsonObject('好的，这是你要的：{"a":1}')).toBe('{"a":1}');
  });

  it("后面还有废话 → 在配平处就停下（不能用最后一个 }）", () => {
    expect(extractJsonObject('{"a":1} 希望有帮助！')).toBe('{"a":1}');
  });

  it("字符串里带花括号不会算错层级", () => {
    expect(extractJsonObject('{"s":"use {a} here"}')).toBe('{"s":"use {a} here"}');
  });

  it("字符串里的转义引号不会把扫描带偏", () => {
    const raw = '{"s":"he said \\"hi\\""}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("嵌套对象", () => {
    expect(extractJsonObject('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });

  it("括号没配平（被截断）→ null", () => {
    expect(extractJsonObject('{"sentence":"A","gloss"')).toBeNull();
  });

  it("根本没有花括号 → null", () => {
    expect(extractJsonObject("抱歉，我写不出来。")).toBeNull();
  });
});

describe("stripCodeFence / 剥 markdown 外壳", () => {
  it("```json 包裹 → 只留内容", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("无语言标记的 ``` 也一样", () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("没包外壳时原样返回（不能无脑 replace，会误伤内容里的反引号）", () => {
    expect(stripCodeFence('{"a":"1"}')).toBe('{"a":"1"}');
  });

  it("内容里本身有反引号时不被截断", () => {
    const raw = '```json\n{"s":"he said `hi`"}\n```';
    expect(stripCodeFence(raw)).toBe('{"s":"he said `hi`"}');
  });
});

describe("parseExamplePayload", () => {
  it("干净 JSON → 通过", () => {
    const r = parseExamplePayload('{"sentence":"I saw an ancient tree.","gloss":"我看见一棵古树。"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sentence).toBe("I saw an ancient tree.");
      expect(r.payload.gloss).toBe("我看见一棵古树。");
    }
  });

  it("代码块包裹 → 通过（格式噪声不该浪费一次重试，一次调用也是钱）", () => {
    const r = parseExamplePayload('```json\n{"sentence":"A tree.","gloss":"一棵树。"}\n```');
    expect(r.ok).toBe(true);
  });

  it("前面有客套话 → 通过", () => {
    const r = parseExamplePayload('好的！{"sentence":"A tree.","gloss":"一棵树。"}');
    expect(r.ok).toBe(true);
  });

  it("缺 gloss → schema_mismatch（让上层重试，**不自己编一句中文顶上**）", () => {
    const r = parseExamplePayload('{"sentence":"A tree."}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("字段名写歪了 → schema_mismatch", () => {
    const r = parseExamplePayload('{"sentences":"A tree.","translation":"一棵树。"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("句子过长（超出 schema 上限）→ schema_mismatch，不做静默截断", () => {
    const long = "a".repeat(300);
    const r = parseExamplePayload(`{"sentence":"${long}","gloss":"太长"}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("纯文字没有 JSON → no_json", () => {
    const r = parseExamplePayload("我不会写这个句子。");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_json");
  });

  it("JSON 语法坏了 → no_json", () => {
    const r = parseExamplePayload('{"sentence": "A tree.", "gloss": }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_json");
  });
});

/* ══════════════════════ 完形填空的解析 ══════════════════════ */

/**
 * 这一组的重点是**一个具体的失败模式**：`passage` 里带 `{{1}}` 这种双花括号。
 *
 * `extractJsonObject` 是按"括号配平"找 JSON 的。如果它在字符串内部也去数括号，
 * `{{1}}` 会先加两格再减两格 —— 看起来正好抵消，好像没事；
 * 但只要模型写出 `{{1}}` 少一个花括号（`{1}}`），配平就整体错位，
 * 于是一份**完全合法的 JSON** 被判成"没有 JSON"。
 * 更糟的是这种错**只在特定输入上出现**，平时测不出来。
 * 所以这里直接钉住：字符串里的花括号一个都不许影响深度。
 */
function clozeJson(over: Record<string, unknown> = {}): string {
  const blanks = Array.from({ length: 10 }, (_, i) => ({
    no: i + 1,
    options: ["join", "joined", "joining", "joins"],
    answer: 0,
    word: "join",
  }));
  return JSON.stringify({
    title: "一次班级活动",
    passage: "We all {{1}} the club last week and {{2}} to meet again.",
    blanks,
    ...over,
  });
}

describe("parseClozePayload", () => {
  it("正常的题解析成功", () => {
    const r = parseClozePayload(clozeJson());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.blanks).toHaveLength(10);
    expect(r.payload.title).toBe("一次班级活动");
  });

  it("短文里的双花括号不会打乱 JSON 括号配平", () => {
    const r = parseClozePayload(clozeJson());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 占位符要原样留在 passage 里 —— 后面拆题靠它
    expect(r.payload.passage).toContain("{{1}}");
  });

  it("花括号写残缺时也能把 JSON 抠出来（配平扫描不受字符串内容影响）", () => {
    // 模型偶尔会把 {{2}} 写成 {2}} —— 这不该让整份 JSON 变得"找不到"
    const raw = clozeJson({
      passage: "We all {{1}} the club last week and {{2} to meet again after the holiday.",
    });
    const r = parseClozePayload(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 残缺的占位符原样留着，交给后面的结构审核去判 —— 解析器不做修补
    expect(r.payload.passage).toContain("{{2}");
  });

  it("包在 markdown 代码块里也能解析", () => {
    const r = parseClozePayload("```json\n" + clozeJson() + "\n```");
    expect(r.ok).toBe(true);
  });

  it("JSON 后面多一句解释也能解析", () => {
    const r = parseClozePayload(clozeJson() + "\n希望这套题对你有帮助。");
    expect(r.ok).toBe(true);
  });

  it("空数不是 10 → schema_mismatch（业务审核之前就挡住，省一次调用）", () => {
    const raw = JSON.stringify({
      title: "x",
      passage: "a",
      blanks: [{ no: 1, options: ["a", "b", "c", "d"], answer: 0, word: "a" }],
    });
    expect(parseClozePayload(raw)).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  it("答案下标越界 → schema_mismatch", () => {
    const blanks = Array.from({ length: 10 }, (_, i) => ({
      no: i + 1,
      options: ["a", "b", "c", "d"],
      answer: 7,
      word: "a",
    }));
    expect(parseClozePayload(clozeJson({ blanks }))).toEqual({
      ok: false,
      reason: "schema_mismatch",
    });
  });

  it("选项不是 4 个 → schema_mismatch", () => {
    const blanks = Array.from({ length: 10 }, (_, i) => ({
      no: i + 1,
      options: ["a", "b", "c"],
      answer: 0,
      word: "a",
    }));
    expect(parseClozePayload(clozeJson({ blanks }))).toEqual({
      ok: false,
      reason: "schema_mismatch",
    });
  });

  it("多余的字段被剥掉，不会让整道题作废", () => {
    const blanks = Array.from({ length: 10 }, (_, i) => ({
      no: i + 1,
      options: ["a", "b", "c", "d"],
      answer: 0,
      word: "a",
      // 模型很爱自己加一个解释字段
      explanation: "因为上文提到了……",
    }));
    const r = parseClozePayload(clozeJson({ blanks, difficulty: "medium" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.blanks[0]).not.toHaveProperty("explanation");
    expect(r.payload).not.toHaveProperty("difficulty");
  });

  it("完全没有 JSON → no_json", () => {
    expect(parseClozePayload("抱歉，我无法完成这个任务。")).toEqual({
      ok: false,
      reason: "no_json",
    });
  });

  it("JSON 被截断（括号没配平）→ no_json", () => {
    const raw = clozeJson().slice(0, 120);
    expect(parseClozePayload(raw)).toEqual({ ok: false, reason: "no_json" });
  });
});
