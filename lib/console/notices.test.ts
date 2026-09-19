import { describe, expect, it } from "vitest";

import {
  MAX_NOTICES,
  formatClock,
  hasAlert,
  insertNotice,
  makeNotice,
  noticesToText,
  topAlertLevel,
  type Notice,
} from "@/lib/console/notices";

/** 造一条提示，只写关心的字段 —— 测试里不重复啰嗦 */
function n(over: Partial<Notice> = {}): Notice {
  return {
    id: over.id ?? "x",
    level: over.level ?? "info",
    title: over.title ?? "标题",
    detail: over.detail,
    at: over.at ?? "2026-09-19T06:32:00.000Z",
    key: over.key,
  };
}

describe("makeNotice", () => {
  it("把 id 与时刻补进调用方给的入参里", () => {
    const got = makeNotice({ level: "info", title: "测一下" }, "id-1", "2026-09-19T00:00:00.000Z");
    expect(got).toEqual({
      id: "id-1",
      level: "info",
      title: "测一下",
      at: "2026-09-19T00:00:00.000Z",
    });
  });

  it("不丢 detail 与 key", () => {
    const got = makeNotice({ level: "success", title: "t", detail: "d", key: "k" }, "i", "a");
    expect(got.detail).toBe("d");
    expect(got.key).toBe("k");
  });
});

describe("insertNotice", () => {
  it("新条目排在最前（列表是倒序展示的）", () => {
    const list = [n({ id: "old" })];
    const got = insertNotice(list, n({ id: "new" }));
    expect(got.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("不改原数组 —— 纯函数，调用方手里的旧引用必须保持不变", () => {
    const list = [n({ id: "old" })];
    insertNotice(list, n({ id: "new" }));
    expect(list.map((x) => x.id)).toEqual(["old"]);
  });

  it("同 key 的旧条目被顶掉，而不是排成两条", () => {
    const list = [n({ id: "a", key: "boot", title: "第一次" }), n({ id: "b" })];
    const got = insertNotice(list, n({ id: "c", key: "boot", title: "第二次" }));
    expect(got.map((x) => x.id)).toEqual(["c", "b"]);
    expect(got.filter((x) => x.key === "boot")).toHaveLength(1);
  });

  it("没有 key 的条目永远只是追加，不会误伤别人", () => {
    const list = [n({ id: "a", key: "k1" })];
    const got = insertNotice(list, n({ id: "b" }));
    expect(got.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("超上限时从尾部（最老的一头）截断", () => {
    let list: Notice[] = [];
    for (let i = 0; i < MAX_NOTICES + 5; i++) list = insertNotice(list, n({ id: `i${i}` }));
    expect(list).toHaveLength(MAX_NOTICES);
    expect(list[0].id).toBe(`i${MAX_NOTICES + 4}`);
    expect(list.some((x) => x.id === "i0")).toBe(false);
  });

  it("空列表也能插", () => {
    expect(insertNotice([], n({ id: "only" }))).toHaveLength(1);
  });
});

describe("hasAlert / topAlertLevel", () => {
  it("空列表不算告警（悬浮球保持安静）", () => {
    expect(hasAlert([])).toBe(false);
    expect(topAlertLevel([])).toBeNull();
  });

  it("只有 info / success 时不算告警", () => {
    const list = [n({ level: "info" }), n({ level: "success" })];
    expect(hasAlert(list)).toBe(false);
    expect(topAlertLevel(list)).toBeNull();
  });

  it("warning 算告警", () => {
    expect(hasAlert([n({ level: "warning" })])).toBe(true);
    expect(topAlertLevel([n({ level: "info" }), n({ level: "warning" })])).toBe("warning");
  });

  it("danger 压过 warning（状态灯取最重的那档）", () => {
    const list = [n({ level: "warning" }), n({ level: "danger" }), n({ level: "info" })];
    expect(topAlertLevel(list)).toBe("danger");
  });
});

describe("formatClock", () => {
  it("补零到 HH:MM", () => {
    // 用本地时间构造，与 formatClock 的本地化取值口径一致，不受时区影响
    expect(formatClock(new Date(2026, 8, 19, 9, 5).toISOString())).toBe("09:05");
    expect(formatClock(new Date(2026, 8, 19, 14, 32).toISOString())).toBe("14:32");
    expect(formatClock(new Date(2026, 8, 19, 0, 0).toISOString())).toBe("00:00");
  });

  it("非法时刻返回 --:--，不抛错", () => {
    expect(formatClock("")).toBe("--:--");
    expect(formatClock("not-a-date")).toBe("--:--");
  });
});

describe("noticesToText", () => {
  it("空列表给一句人话，而不是空字符串", () => {
    expect(noticesToText([])).toBe("（暂无动态）");
  });

  it("带 detail 的缩进一行", () => {
    const text = noticesToText([n({ at: new Date(2026, 8, 19, 14, 32).toISOString(), title: "标题", detail: "补充" })]);
    expect(text).toBe("[14:32] 标题\n    补充");
  });

  it("不带 detail 的只有一行", () => {
    const text = noticesToText([n({ at: new Date(2026, 8, 19, 8, 3).toISOString(), title: "标题" })]);
    expect(text).toBe("[08:03] 标题");
  });

  it("多条按数组顺序（即时间倒序）拼接", () => {
    const text = noticesToText([
      n({ id: "1", at: new Date(2026, 8, 19, 8, 0).toISOString(), title: "新" }),
      n({ id: "2", at: new Date(2026, 8, 19, 7, 0).toISOString(), title: "旧" }),
    ]);
    expect(text.split("\n")).toEqual(["[08:00] 新", "[07:00] 旧"]);
  });
});
