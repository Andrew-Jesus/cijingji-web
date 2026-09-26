import { describe, expect, it } from "vitest";

import { decideGuard, decideLoginEntry } from "./guard";

/**
 * 门卫规则的两条命门都在这份测试里。
 * 尤其最后一条「读不出来要放行」—— 改它之前请先读 guard.ts 顶部那段"失败方向"。
 */
describe("decideGuard —— 受保护页面放不放行", () => {
  it("账号系统没接上：一律放行（纯本地模式，谁都不拦）", () => {
    expect(decideGuard(false, "none")).toBe("allow");
    expect(decideGuard(false, "unknown")).toBe("allow");
    expect(decideGuard(false, "session")).toBe("allow");
  });

  it("本地有凭据：放行", () => {
    expect(decideGuard(true, "session")).toBe("allow");
  });

  it("明确没有凭据：去登录页", () => {
    expect(decideGuard(true, "none")).toBe("to-login");
  });

  it("★ 读不出来（断网/超时）：必须放行", () => {
    // 这是整套设计的命门。写成 to-login 的后果是：
    // 网络抖一下，正在背单词的人被踢到登录页 —— 而他的进度全在本地、
    // 本来根本不需要网。等于白白牺牲可用性，一点安全都没换来。
    // 数据安全靠数据库的 RLS，不靠这道门。
    expect(decideGuard(true, "unknown")).toBe("allow");
  });
});

describe("decideLoginEntry —— 登录页该显示表单还是弹回首页", () => {
  it("已登录就别再看登录页了，回首页", () => {
    expect(decideLoginEntry(true, "session")).toBe("to-home");
  });

  it("没登录：显示表单", () => {
    expect(decideLoginEntry(true, "none")).toBe("form");
  });

  it("读不出来：显示表单，不要弹回去", () => {
    // 弹回去会让用户以为"我的账号还在"，然后马上又被门卫拦回来 —— 来回打转。
    // 让他重新登一次，代价比转圈小。
    expect(decideLoginEntry(true, "unknown")).toBe("form");
  });

  it("没接账号系统：显示表单（页面上换成一说明块，不是表单控件）", () => {
    expect(decideLoginEntry(false, "none")).toBe("form");
    expect(decideLoginEntry(false, "session")).toBe("form");
  });
});
