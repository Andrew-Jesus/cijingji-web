import { describe, expect, it } from "vitest";

import { extractJsonObject, parseExamplePayload, stripCodeFence } from "./parse";

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
