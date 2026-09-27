/**
 * 首次登录：**把本机挂着的旧数据，认到这个人名下**（实施方案 §7.2）
 *
 * ── 不做这件事会发生什么 ──────────────────────────────────────
 * 阶段 0 所有用户层的行都挂着 `user_id = "local"`（一个临时占位）。
 * 朋友在阶段 0 试用时已经攒了一些记录；现在他登录了 ——
 * 那些记录跟他的账号对不上，同步器会当它们是**别人的**数据，弃之不理。
 * 他打开首页看到的是"从没学过"的空白。**进度全丢**。
 *
 * ── 顺序不能反（§7.2 特别标注）────────────────────────────────
 * 必须**先认领、再推送**。反过来的话，`"local"` 那些行推上去会被 RLS 拒绝
 * （策略写的是 `auth.uid() = user_id`，而 `auth.uid()` 永远不可能是字符串 `'local'`），
 * 报的还是一个看不懂的权限错误。
 *
 * ── 它是幂等的 ────────────────────────────────────────────────
 * 认领完库里就没有 `"local"` 的行了，再跑一次什么都不做。
 * 所以可以放心地每次登录都跑一遍 —— 不需要记"这台机器认领过没有"这种状态
 * （多一个要持久化的状态就多一处会不同步的地方）。
 *
 * ── 只碰这四张表 ──────────────────────────────────────────────
 * `ai_usage` **不认领**：它不参与同步（见实施方案 §8.2，本地那份只给自己看），
 * 挂谁的 id 都不影响它被读出来。改它反而会让"本地账"和"云端账"的关系更难讲清。
 */
import type { Table } from "dexie";

import { LOCAL_PROFILE_ID } from "@/lib/db/identity";
import { exampleIdFor, planIdFor } from "@/lib/db/ids";
import { db } from "@/lib/db/local";
import type { Profile } from "@/lib/db/types";

import { pickPlan } from "./mergePlan";
import { pickProfile } from "./mergeProfile";

export interface ClaimResult {
  profiles: number;
  daily_plans: number;
  review_logs: number;
  user_examples: number;
  total: number;
}

/**
 * 把本地 `user_id = "local"` 的行改成真实 uuid。
 *
 * @param userId 登录用户 id。传空串或 `"local"` 时**什么都不做**（避免把数据认给一个假 id）。
 */
export async function claimLocalData(userId: string): Promise<ClaimResult> {
  const result: ClaimResult = {
    profiles: 0,
    daily_plans: 0,
    review_logs: 0,
    user_examples: 0,
    total: 0,
  };

  if (!userId || userId === LOCAL_PROFILE_ID) return result;

  // 四张表一起改：中途失败就整体回滚，不会留下"画像认了、记录没认"的半截状态。
  await db.transaction(
    "rw",
    db.profiles,
    db.daily_plans,
    db.review_logs,
    db.user_examples,
    async () => {
      result.profiles = await claimProfile(userId);
      result.daily_plans = await claimByUserId(
        db.daily_plans,
        userId,
        (row) => planIdFor(row.plan_date, userId),
        // 同一天撞号 = 同一天的两份任务单 → 与同步时用同一条规则（进度靠前的赢）
        (legacy, existing) => pickPlan(legacy, existing) ?? legacy,
      );
      // 作答流水是个例外：它的编号不带主人（"时间戳 + 序号 + 随机尾巴"，本来就唯一），
      // 所以认领只改 `user_id` 字段，编号原样留着。
      result.review_logs = await claimByUserId(
        db.review_logs,
        userId,
        (row) => row.id,
        (_legacy, existing) => existing,
      );
      result.user_examples = await claimByUserId(
        db.user_examples,
        userId,
        (row) => exampleIdFor(row.word_id, row.interest_tag, userId),
        // 例句是"内容"：同一个键的含义就是同一个意思，库里那一份够用，不必改写
        (_legacy, existing) => existing,
      );
      result.total =
        result.profiles + result.daily_plans + result.review_logs + result.user_examples;
    },
  );

  return result;
}

/**
 * 把"挂在 `user_id` 上"的那几张表里的旧行改成新主人。
 *
 * ── 2026-09-28：不只改 `user_id`，**主键也要改** ──────────────
 * 编号里现在带着主人（`plan:<user_id>:<日期>`，见 `lib/db/ids.ts`）。
 * 只把 `user_id` 字段改成新主人，会留下一批"字段说是 A、编号里还写着 local"的行 ——
 * 新代码按 `planIdFor(日期, A)` 去读，读到 `undefined`，用户看到"进度没了"；
 * 那批错位的行同时还占着位置，同步时会被当成另一个实体的数据。
 * 所以改主人 = 改字段 + 改主键，一次做完。
 *
 * ── 撞号怎么办 ────────────────────────────────────────────────
 * 目标编号**可能已经被这个账号自己占着**（本机既有"未登录时期"那份，
 * 又有"这个账号"那份 —— 比如上次登录留下的）。这时不能盲覆盖：
 * 两条是**同一天的两份任务单**，走既有的 `pickPlan`（取进度更靠前的），
 * 与同步时的判定规则完全一致 —— 同一件事在两处用两套规则，迟早对不上。
 *
 * ── 为什么把**表对象本身**传进来、而不是表名字符串 ────────────
 * `db[table]` 那种写法在 TS 里会得到一个"几张表的联合类型"，
 * 而联合类型身上的 `bulkPut` 因为重载签名互不兼容会**调不动**（编译期直接报错）。
 * 传对象进来则泛型当场收敛成唯一一个类型，读写都有保护。
 *
 * ── 为什么不用 `where("user_id").equals(...)` ─────────────────
 * 这几张表都**没有单列的 `user_id` 索引**（daily_plans 用的是复合键
 * `[user_id+plan_date]`，另外两张用的是别的索引），Dexie 按不存在的索引查会直接抛错。
 * 全取再筛更直白，量级也就几百到几千行。
 *
 * @param remapId 新编号怎么算。**必须用传进来的 `userId`**，
 *                不能读 `row.user_id` —— 那还是旧主人。
 * @param pick    撞号时留哪份（两份都是这个人的，谁的更"靠前"听谁的）。
 */
async function claimByUserId<T extends { id: string; user_id: string }>(
  table: Table<T, string>,
  userId: string,
  remapId: (row: T) => string,
  pick: (legacy: T, existing: T) => T,
): Promise<number> {
  const rows = await table.toArray();
  const legacy = rows.filter((row) => row.user_id === LOCAL_PROFILE_ID);
  if (legacy.length === 0) return 0;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const deletes: string[] = [];
  const writes: T[] = [];

  for (const row of legacy) {
    const targetId = remapId(row);
    // 目标号上"另有其人"才算占号。查回自己不算 —— 有的表编号本来就不动，
    // 此时 targetId 就是 row.id，不排掉的话每次都当成"撞号"，逻辑会绕。
    const occupant = byId.get(targetId);
    const existing = occupant && occupant.id !== row.id ? occupant : undefined;
    const winner = existing ? pick(row, existing) : row;

    // 先删后写：删掉这条旧行；若目标号已存在，那条也要删（写入时会被覆盖，
    // 显式删掉是为了不依赖 `bulkPut` 的覆盖语义，也让"到底留了哪一份"写得更清楚）
    deletes.push(row.id);
    if (existing) deletes.push(existing.id);
    writes.push({ ...winner, id: targetId, user_id: userId });
  }

  await table.bulkDelete(deletes);
  await table.bulkPut(writes);
  return writes.length;
}

/**
 * 画像单独处理，因为它的主键**就叫 `id`**（`profiles.id` 就是 `auth.users.id`），
 * 不是 `user_id` —— 改主人等于换主键，不能靠 bulkPut 覆盖。
 *
 * 两种边界：
 *   · 库里没有 `"local"` 那份 → 什么都不做（已经认过了，或者本来就没建过画像）
 *   · 已经有了真实 uuid 那份 → 用 `pickProfile` 判谁更新，**不能盲选**
 *     （盲选本地会把云端更新过的画像打回去；盲选云端会把本地刚改的丢掉）
 *
 * 不论走哪条路，最后 `"local"` 那条都要删掉 —— 同一个人不能有两份画像，
 * 否则"谁是权威"就变成运气问题。
 */
async function claimProfile(userId: string): Promise<number> {
  const legacy = await db.profiles.get(LOCAL_PROFILE_ID);
  if (!legacy) return 0;

  const alreadyClaimed = await db.profiles.get(userId);
  const winner: Profile = alreadyClaimed ? (pickProfile(legacy, alreadyClaimed) ?? legacy) : legacy;

  await db.profiles.put({ ...winner, id: userId });
  await db.profiles.delete(LOCAL_PROFILE_ID);
  return 1;
}
