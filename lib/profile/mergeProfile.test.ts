import { describe, expect, it } from "vitest";

import type { GoalProfile } from "@/lib/db/types";
import { findIllegalPhaseFields, mergeProfile } from "@/lib/profile/mergeProfile";

const baseProfile: Pick<
  GoalProfile,
  "channel_weights" | "sense_policy" | "context_sources" | "networks" | "pace"
> = {
  channel_weights: { recognize: 0.4, recall_spell: 0.3, collocate: 0.15 },
  sense_policy: "single",
  context_sources: ["textbook_unit", "generated_topic"],
  networks: { topic_cluster: 0.5 },
  pace: {
    new_ratio: 0.6,
    session_size: 20,
    spelling_required: true,
    speed_drill: false,
    review_priority: "weak_first",
  },
};

describe("mergeProfile 的三层优先级", () => {
  it("没有覆盖层时，就是目标默认值", () => {
    const merged = mergeProfile({ profile: baseProfile });
    expect(merged.pace.session_size).toBe(20);
    expect(merged.pace.spelling_required).toBe(true);
    expect(merged.applied_layers).toEqual([]);
  });

  it("phase 覆盖目标默认", () => {
    const merged = mergeProfile({
      profile: baseProfile,
      phase: "sprint",
      phases: { sprint: { pace: { session_size: 60, new_ratio: 0 } } },
    });
    expect(merged.pace.session_size).toBe(60);
    expect(merged.pace.new_ratio).toBe(0);
    expect(merged.applied_layers).toContain("phase");
  });

  it("overrides 覆盖 phase（用户手动优先级最高）", () => {
    const merged = mergeProfile({
      profile: baseProfile,
      phase: "sprint",
      phases: { sprint: { pace: { session_size: 60 } } },
      overrides: { pace: { session_size: 30, spelling_required: false } },
    });
    expect(merged.pace.session_size).toBe(30);
    expect(merged.pace.spelling_required).toBe(false);
    expect(merged.applied_layers).toContain("overrides");
  });

  it("phase 里没写的字段仍走目标默认（覆盖层只改它声明的）", () => {
    const merged = mergeProfile({
      profile: baseProfile,
      phase: "sprint",
      phases: { sprint: { pace: { session_size: 60 } } },
    });
    expect(merged.pace.spelling_required).toBe(true);
    expect(merged.sense_policy).toBe("single");
  });

  it("字段缺失时回落默认值，不抛错崩页面", () => {
    const merged = mergeProfile({
      profile: {
        channel_weights: {},
        sense_policy: "single",
        context_sources: [],
        networks: {},
        pace: undefined as never,
      },
    });
    expect(merged.pace.session_size).toBe(20);
    expect(merged.pace.new_ratio).toBeGreaterThan(0);
  });

  it("指定的 phase 不存在时，退回目标默认（不崩）", () => {
    const merged = mergeProfile({
      profile: baseProfile,
      phase: "not_exist",
      phases: {},
    });
    expect(merged.pace.session_size).toBe(20);
  });
});

describe("findIllegalPhaseFields（配置越界要在开发期就发现）", () => {
  it("白名单内的字段不报错", () => {
    expect(findIllegalPhaseFields({ sprint: { pace: {}, sense_policy: "multi" } })).toEqual([]);
  });

  it("越界字段会被点名", () => {
    const illegal = findIllegalPhaseFields({
      sprint: { pace: {}, review_interval_days: 3 },
    });
    expect(illegal).toEqual(["sprint.review_interval_days"]);
  });
});
