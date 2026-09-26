import { afterEach, describe, expect, it } from "vitest";

import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from "./env";

/**
 * 这个文件守住的是"配置怎么算配好"。
 *
 * 为什么值得测：它是**全站要不要拦人**的总闸。判错的两种后果都很糟 ——
 *   · 明明没配却判成"配好了" → 所有人被拦在登录页，而登录页根本登不进去；
 *    · 明明配好了却判成"没配" → 门卫形同虚设，账号系统白接。
 * 而且这两种都不会报错，只会静默地把人挡在外面或放进来。
 */

const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

/** 进测试前先把现场存下来，跑完原样还回去（别污染同一进程里的别的测试） */
const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));

function clearAll() {
  for (const k of KEYS) delete process.env[k];
}

afterEach(() => {
  for (const k of KEYS) {
    const value = saved.get(k);
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
});

describe("isSupabaseConfigured —— 账号系统接上了没有", () => {
  it("两个都没填：没接上（应用走纯本地模式）", () => {
    clearAll();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("★ 只填了一半：仍然算没接上", () => {
    // 半配置是最容易发生的一种（复制了地址忘了 key）。
    // 判成"配好了"的话，用户会被拦去一个注定登不进去的登录页。
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
    expect(isSupabaseConfigured()).toBe(false);

    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_demo";
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("两个都填了：接上了", () => {
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_demo";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("只给了旧名字（anon key）也算数 —— 兼容期不能因为官方改名就罢工", () => {
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiJ9.legacy";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("新名字优先于旧名字（两把都在时用新的）", () => {
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJlegacy";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_new";
    expect(supabasePublishableKey()).toBe("sb_publishable_new");
  });

  it("只有空格不算数 —— 从聊天框复制粘贴很容易带上来", () => {
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "   ";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_demo";
    expect(isSupabaseConfigured()).toBe(false);
    expect(supabaseUrl()).toBe("");
  });

  it("值首尾的空格要削掉，不能带进请求里", () => {
    clearAll();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "  https://demo.supabase.co  ";
    expect(supabaseUrl()).toBe("https://demo.supabase.co");
  });
});
