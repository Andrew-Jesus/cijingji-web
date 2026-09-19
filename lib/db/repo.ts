/**
 * profiles 读写封装
 *
 * 为什么单独一层：阶段 1 换成 Supabase 时**只换这个文件的实现**，
 * 页面与纯函数一行不动 —— 与 lib/db/local.ts 的"同构"思路一致。
 *
 * 阶段 0 没有账号体系，本机只有一个 profile。
 */
import { db } from "./local";
import type { Profile } from "./types";

/** 阶段 0 固定用这一个 id；阶段 1 换成真实 user_id */
export const LOCAL_PROFILE_ID = "local";

export const DEFAULT_GOAL = "zhongkao";
export const DEFAULT_DAILY_MINUTES = 15;

export async function getProfile(): Promise<Profile | null> {
  return (await db.profiles.get(LOCAL_PROFILE_ID)) ?? null;
}

/**
 * 引导过程中允许只写一部分字段。
 *
 * 两类字段允许传 `null`，语义是"这一项就是空的"，与"不传（保持原值）"区分开：
 *   - `goal_deadline`：选了未收录的目标时**故意不打期限**（留 null 比留个错日期诚实）
 *   - `goal`：调用方手上可能还是 null，此时回落默认值，不写坏数据
 */
export interface ProfileDraft {
  goal?: string | null;
  goal_deadline?: string | null;
  daily_minutes?: number | null;
  interests?: string[];
  level_self_report?: number | null;
}

/**
 * 合并写入：**只覆盖传进来的字段，其余保留**。
 * 这样引导中途刷新页面不会把已答的题丢掉。
 */
export async function saveProfile(draft: ProfileDraft): Promise<Profile> {
  const existing = await getProfile();
  const now = new Date().toISOString();

  const next: Profile = {
    id: LOCAL_PROFILE_ID,
    nickname: existing?.nickname ?? null,
    study_code: existing?.study_code ?? null,
    goal: draft.goal ?? existing?.goal ?? DEFAULT_GOAL,
    goal_deadline:
      draft.goal_deadline !== undefined ? draft.goal_deadline : (existing?.goal_deadline ?? null),
    daily_minutes: draft.daily_minutes ?? existing?.daily_minutes ?? DEFAULT_DAILY_MINUTES,
    interests: draft.interests ?? existing?.interests ?? [],
    level_self_report:
      draft.level_self_report !== undefined
        ? draft.level_self_report
        : (existing?.level_self_report ?? null),
    theme: existing?.theme ?? null,
    timezone: existing?.timezone ?? guessTimezone(),
    created_at: existing?.created_at ?? now,
    onboarding_completed_at: existing?.onboarding_completed_at ?? null,
  };

  await db.profiles.put(next);
  return next;
}

/** 引导最后一步：记下自测等级并打上完成标记。两件事必须在**同一次写入**里完成。 */
export async function completeOnboarding(level: number): Promise<Profile> {
  const saved = await saveProfile({ level_self_report: level });
  const next: Profile = { ...saved, onboarding_completed_at: new Date().toISOString() };
  await db.profiles.put(next);
  return next;
}

/** 引导是否已完成 —— 全项目只此一处判断口径 */
export function isOnboarded(profile: Profile | null): boolean {
  return profile?.onboarding_completed_at != null;
}

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}
