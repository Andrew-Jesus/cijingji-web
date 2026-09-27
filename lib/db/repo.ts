/**
 * profiles 读写封装
 *
 * 为什么单独一层：阶段 1 换成 Supabase 时**只换这个文件的实现**，
 * 页面与纯函数一行不动 —— 与 lib/db/local.ts 的"同构"思路一致。
 *
 * 阶段 0 没有账号体系，本机只有一个 profile。
 */
import { getActiveUserId, LOCAL_PROFILE_ID } from "./identity";
import { db } from "./local";
import type { Profile } from "./types";

/**
 * 阶段 0 本机只有一个用户，所有用户层的行都挂这个 id。
 * 阶段 1 的"**现在是谁**"由 `lib/db/identity.ts` 持有（那里解释了为什么必须单开一层）。
 * 这里重新导出一次，是给 `import { LOCAL_PROFILE_ID } from "./repo"` 的老代码留个兼容口。
 */
export { LOCAL_PROFILE_ID };

export const DEFAULT_GOAL = "zhongkao";
export const DEFAULT_DAILY_MINUTES = 15;

/**
 * 取当前用户的画像。
 *
 * ── 那个回落分支为什么必须留着 ────────────────────────────────
 * 正常顺序是"先认领、再读"（`AuthGate` 在放行之前调 `claimLocalData`），
 * 所以走到这里时老数据已经挂在真实 uuid 名下了。
 *
 * 但认领是**可能失败**的（Dexie 出一次错、浏览器存储被清了一半都算）。
 * 如果失败后这里直接返回 `null`，用户登录后看到的是"没有档案"
 * → 被送去引导页从头再做一遍 20 题自测 —— **而他的进度其实好端端躺在库里**。
 * 这正是验收 V1（"进度不丢"）最不能接受的结果。
 *
 * 所以宁可读到一份"还没认领的"旧档案，也不能报"没有"。方向是
 * **宁可暂时认错主人，不可声称数据不存在** —— 前者下一轮同步会修好，后者会让人重做一遍。
 */
export async function getProfile(): Promise<Profile | null> {
  const id = getActiveUserId();
  const own = await db.profiles.get(id);
  if (own) return own;

  if (id !== LOCAL_PROFILE_ID) {
    const notClaimedYet = await db.profiles.get(LOCAL_PROFILE_ID);
    if (notClaimedYet) return notClaimedYet;
  }
  return null;
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
  const id = getActiveUserId();

  const next: Profile = {
    id,
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
    updated_at: now,
    onboarding_completed_at: existing?.onboarding_completed_at ?? null,
  };

  await db.profiles.put(next);

  // 认领还没跑成的那一路：库里那份还挂着 "local"，而这一份写到了真实 uuid 名下
  // → 同一个人就有了两条画像，"谁是权威"会变成运气问题。
  // 内容已经并进 next 了，把旧那条删掉（这是唯一一处允许删画像的地方）。
  if (existing && existing.id !== id) {
    await db.profiles.delete(existing.id);
  }

  return next;
}

/** 引导最后一步：记下自测等级并打上完成标记。两件事必须在**同一次写入**里完成。 */
export async function completeOnboarding(level: number): Promise<Profile> {
  const saved = await saveProfile({ level_self_report: level });
  const now = new Date().toISOString();
  // `updated_at` 跟着一起推 —— 否则这一步改了画像却没留下"改过"的痕迹，
  // 同步时的"谁后写"会误判成上一层那一次
  const next: Profile = { ...saved, onboarding_completed_at: now, updated_at: now };
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
