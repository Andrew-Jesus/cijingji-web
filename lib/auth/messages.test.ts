import { describe, expect, it } from "vitest";

import { describeAuthError } from "./messages";

/**
 * 这一层的价值全在"人看完知道下一步干嘛"。
 * 所以断言写的是**用户能不能从这句话里看到该做的事**，不是逐字比对文案。
 */
describe("describeAuthError —— 把错误码翻成人话", () => {
  it("密码打错：叫人再试一次（这是最常见的一种，不能吓人）", () => {
    expect(describeAuthError({ code: "invalid_credentials", status: 400 })).toContain("再试一次");
  });

  it("账号没激活：告诉他来找我，而不是让他自己去点什么", () => {
    const text = describeAuthError({ code: "email_not_confirmed" });
    expect(text).toContain("激活");
    expect(text).toContain("我");
  });

  it("试太频繁：要告诉用户等多久，光说失败没用", () => {
    expect(describeAuthError({ code: "over_request_rate_limit" })).toContain("等一分钟");
    // 有的版本不给 code，只给 429
    expect(describeAuthError({ status: 429 })).toContain("等一分钟");
  });

  it("邮箱格式不对 / 密码太短：直接说哪里不对", () => {
    expect(describeAuthError({ code: "email_address_invalid" })).toContain("邮箱");
    expect(describeAuthError({ code: "weak_password" })).toContain("6 位");
  });

  it("关掉了自助注册：说明账号是我统一开的（别让他以为网站坏了）", () => {
    expect(describeAuthError({ code: "signup_disabled" })).toContain("统一开通");
  });

  it("网络不通：明确指向网络，别让他反复改密码", () => {
    expect(describeAuthError({ message: "Failed to fetch" })).toContain("网络");
    expect(describeAuthError(new TypeError("Load failed"))).toContain("网络");
  });

  it("认不出来的错：把原文带出来（翻译不了也不能吞掉）", () => {
    const text = describeAuthError({ code: "something_new", message: "Unknown failure" });
    expect(text).toContain("something_new");
    expect(text).toContain("Unknown failure");
  });

  it("连对象都不是（比如被 throw 了一个字符串）也不许炸", () => {
    expect(describeAuthError("boom").length).toBeGreaterThan(0);
    expect(describeAuthError(null).length).toBeGreaterThan(0);
    expect(describeAuthError(undefined).length).toBeGreaterThan(0);
  });
});
