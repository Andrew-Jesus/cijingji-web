import { describe, expect, it } from "vitest";

import type { GoalProfile, Sense, Word, WordPlacement } from "@/lib/db/types";
import type { WordSnapshot } from "@/lib/scope/resolveScope";
import { LIMITS } from "@/lib/scope/schema";
import { secondsForMode } from "./estimate";
import { DEFAULT_SCOPE_LABEL, assembleTodayPlan, scopeLabelOf } from "./todayPlan";

const U1 = "renjiao_2024:8A:U1";

function goalProfile(spellingRequired: boolean): GoalProfile {
  return {
    id: "zhongkao@v1",
    goal_code: "zhongkao",
    version: 1,
    channel_weights: { recognize: 0.4, recall_spell: 0.3 },
    sense_policy: "single",
    context_sources: ["textbook_unit"],
    networks: { topic_cluster: 0.5 },
    pace: {
      // 0.6 与真实的中考配置一致。**不要图省事写成 1** ——
      // new_ratio = 1 意味着"今天全是新词"，复习配额会被算成 0，
      // 错词永远进不了任务单（见本文件末尾那条把这个语义钉住的测试）。
      new_ratio: 0.6,
      session_size: 20,
      spelling_required: spellingRequired,
      speed_drill: false,
      review_priority: "weak_first",
    },
    phases: {},
    user_facing_summary: "按你的课本单元来。",
  };
}

/** 生成一个只有 U1 的快照，词数可控 */
function snapshot(wordCount: number): WordSnapshot {
  const words: Word[] = [];
  const senses: Sense[] = [];
  const placements: WordPlacement[] = [];

  for (let i = 0; i < wordCount; i++) {
    const id = `w:${String(i).padStart(3, "0")}`;
    const lemma = `word${i}`;
    words.push({
      id,
      lemma,
      lemma_normalized: lemma,
      phonetic_uk: null,
      phonetic_us: null,
      freq_rank: null,
    });
    senses.push({ id: `s:${id}`, word_id: id, pos: "n.", cn_meaning: `释义${i}`, is_primary: true });
    placements.push({
      id: `p:${id}`,
      word_id: id,
      unit_id: U1,
      sense_id: null,
      role: "new" as const,
      is_core: null,
      occurrence_no: 1,
      first_volume_id: null,
      source: "extracted",
      confidence: 0.75,
      is_verified: false,
    });
  }

  return {
    units: [
      {
        id: U1,
        volume_id: "renjiao_2024:8A",
        unit_no: 1,
        unit_code: "Unit 1",
        title_en: "Happy Holiday",
        title_zh: null,
        theme_tags: [],
        sort_order: 1,
        is_verified: false,
      },
    ],
    words,
    senses,
    placements,
  };
}

describe("assembleTodayPlan / 每日词量", () => {
  it("每日词量 = 分钟 ÷ 每种题型的用时，并受 LIMITS.daily_cap 封顶", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(45),
      goalProfile: goalProfile(true), // 要拼写 → recall_spell → 25 秒一个
      dailyMinutes: 15,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const expected = Math.min(
      Math.floor((15 * 60) / secondsForMode("recall_spell")),
      LIMITS.daily_cap,
    );
    expect(r.dailyCap).toBe(expected);
    expect(r.plan.items.length).toBe(expected); // 45 个词足够排满
  });

  it("分钟数改变，任务量跟着变（用户答的分钟数真的参与了排计划）", () => {
    const short = assembleTodayPlan({
      snapshot: snapshot(45),
      goalProfile: goalProfile(true),
      dailyMinutes: 10,
    });
    const long = assembleTodayPlan({
      snapshot: snapshot(45),
      goalProfile: goalProfile(true),
      dailyMinutes: 20,
    });
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    expect(long.plan.items.length).toBeGreaterThan(short.plan.items.length);
  });

  it("范围里的词不够时如实给多少算多少（不重复凑数）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 30,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.items.length).toBe(5);
    expect(new Set(r.plan.items.map((i) => i.word_id)).size).toBe(5);
  });

  it("卡片模板跟着 pace.spelling_required 走", () => {
    const spell = assembleTodayPlan({
      snapshot: snapshot(10),
      goalProfile: goalProfile(true),
      dailyMinutes: 10,
    });
    const recognize = assembleTodayPlan({
      snapshot: snapshot(10),
      goalProfile: goalProfile(false),
      dailyMinutes: 10,
    });
    expect(spell.ok && spell.mode === "recall_spell").toBe(true);
    expect(recognize.ok && recognize.mode === "recognize").toBe(true);
  });
});

describe("assembleTodayPlan / 幂等", () => {
  it("同样输入两次 → 结果完全一样（这是「结果页与首页说的数字一致」的技术保证）", () => {
    const input = {
      snapshot: snapshot(30),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      weakWordIds: ["w:003", "w:007"],
    };
    expect(assembleTodayPlan(input)).toEqual(assembleTodayPlan(input));
  });

  it("传进来的错词数组不会被改动（纯函数不改入参）", () => {
    const weak = ["w:003", "w:007"];
    assembleTodayPlan({
      snapshot: snapshot(30),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      weakWordIds: weak,
    });
    expect(weak).toEqual(["w:003", "w:007"]);
  });
});

describe("assembleTodayPlan / 错词参与排计划", () => {
  it("错词会被排进任务单，并在 breakdown 里数出来", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(40),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      weakWordIds: ["w:030", "w:031", "w:032"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ids = new Set(r.plan.items.map((i) => i.word_id));
    expect(ids.has("w:030")).toBe(true);
    expect(r.plan.breakdown.weak).toBe(3);
    expect(r.plan.breakdown.weak + r.plan.breakdown.fresh).toBe(r.plan.items.length);
  });

  it("不传错词 → breakdown.weak 是 0（第一次来的人没有错词）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(20),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
    });
    expect(r.ok && r.plan.breakdown.weak === 0).toBe(true);
  });

  /**
   * 这条是**语义记录**，不是"我很满意"。
   *
   * `new_ratio` 决定新词拿多少配额，剩下的才是复习配额（`weakQuota = cap - freshQuota`）。
   * 所以 new_ratio = 1 时复习配额是 0 —— **错词一个也进不来**，
   * 哪怕 `review_priority` 写的是 `weak_first`。
   *
   * 这个组合是自相矛盾的（说了"错词优先"却给错词 0 个位置），但阶段 0 的中考配置是 0.6，
   * 走不到这条路上。要不要让它变成"错词至少保底 N 个"，属于策略层决定，
   * 要改的是 `buildDailyPlan` + 这条测试，**不要在一个页面里悄悄特判**。
   */
  it("new_ratio = 1 时复习配额为 0 → 错词一个也排不进来（当前语义，改动必须让它变红）", () => {
    const noReviewQuota = goalProfile(true);
    noReviewQuota.pace = { ...noReviewQuota.pace, new_ratio: 1 };

    const r = assembleTodayPlan({
      snapshot: snapshot(40),
      goalProfile: noReviewQuota,
      dailyMinutes: 15,
      weakWordIds: ["w:030"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.breakdown.weak).toBe(0);
  });
});

describe("assembleTodayPlan / 标签与范围", () => {
  it("默认范围的标签是「八上 Unit 1」（三个页面显示同一个词）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(10),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
    });
    expect(r.ok && r.scopeLabel === "八上 Unit 1").toBe(true);
  });

  it("范围没有 label 时用统一的兜底叫法", () => {
    expect(scopeLabelOf({ v: 1, include: [{ type: "curriculum_unit", units: [U1] }] })).toBe(
      DEFAULT_SCOPE_LABEL,
    );
  });

  it("label 只有空白时也算没有（否则界面上会出现一个空标题）", () => {
    expect(scopeLabelOf({ v: 1, label: "   ", include: [{ type: "curriculum_unit", units: [U1] }] })).toBe(
      DEFAULT_SCOPE_LABEL,
    );
  });

  it("wordsInScope 是范围里的总词数（用来算「几天过一遍」），不是今天的量", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(45),
      goalProfile: goalProfile(true),
      dailyMinutes: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wordsInScope).toBe(45);
    expect(r.plan.items.length).toBeLessThan(45);
  });

  it("置信度取自范围内的归属记录（驱动界面的诚实标注）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopeConfidence).toBe(0.75);
  });
});

describe("assembleTodayPlan / 失败分支必须可区分", () => {
  it("范围不合法 → INVALID_SCOPE（不是静默给个空计划）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      scope: { v: 2, include: [] } as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_SCOPE");
  });

  it("core_only 筛选 → UNSUPPORTED_FILTER（is_core 未知，不假装能筛）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      scope: {
        v: 1,
        include: [{ type: "curriculum_unit", units: [U1], core_only: true }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNSUPPORTED_FILTER");
  });

  it("范围里指向不存在的单元 → SCOPE_TARGET_NOT_FOUND（「范围不存在」与「范围内没有词」必须能区分）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      scope: { v: 1, include: [{ type: "curriculum_unit", units: ["renjiao_2024:8A:U9"] }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SCOPE_TARGET_NOT_FOUND");
  });

  it("范围内一个词都没有 → EMPTY_RESULT", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(0),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMPTY_RESULT");
  });

  it("尚未实现的 include 类型 → UNSUPPORTED_SCOPE_TYPE（契约已定、实现待补，要说清楚）", () => {
    const r = assembleTodayPlan({
      snapshot: snapshot(5),
      goalProfile: goalProfile(true),
      dailyMinutes: 15,
      scope: { v: 1, include: [{ type: "theme", themes: ["travel"] }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNSUPPORTED_SCOPE_TYPE");
  });
});
