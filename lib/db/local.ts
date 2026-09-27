/**
 * 词径记 · 本地数据库（Dexie / IndexedDB）
 *
 * 设计要点：**本地表结构与未来云端逐字同构**。
 * 阶段 1 接 Supabase 时，只把"谁在读写"这件事换掉（见 lib/db/identity.ts 与 lib/sync/），
 * resolveScope / buildDailyPlan 等业务代码一行不用改。
 */
import Dexie, { type Table, type Transaction } from "dexie";

import { exampleIdFor, planIdFor } from "./ids";
import type {
  AiUsage,
  Curriculum,
  DailyPlan,
  GoalProfile,
  Profile,
  ReviewLog,
  Sense,
  Unit,
  UserExample,
  Volume,
  Word,
  WordPlacement,
} from "./types";

/**
 * 索引定义。
 *
 * 单独抽成常量是因为 **Dexie 要求每个版本都写一份 schema**。
 * 若把同一份字面量抄两遍，将来改索引就会只改一处 —— 而另一处悄悄留在旧定义上，
 * 这类"两个版本对同一张表的说法不一致"的问题查起来非常费劲。
 */
const STORES = {
  // 内容层：唯一键照上游文档建（防止重复导入）
  curricula: "id, &code",
  volumes: "id, curriculum_id",
  units: "id, volume_id, unit_no, [volume_id+unit_no]",
  words: "id, &lemma_normalized",
  senses: "id, word_id, is_primary",
  word_placements: "id, word_id, unit_id, &[word_id+unit_id+role], [unit_id+role], sense_id",
  goal_profiles: "id, &[goal_code+version]",

  // 用户层：查询路径照规格书
  profiles: "id, goal",
  daily_plans: "id, &[user_id+plan_date], plan_date",
  review_logs: "id, [user_id+created_at], word_id, session_id",
  // 唯一索引**必须带上 `user_id`**（原来是 `&[word_id+interest_tag]`，比云端还紧一格）：
  // 不带主人的话，同一台设备上两个人对同一个词的同一个兴趣只能存一条 ——
  // 后写的被唯一索引挡掉，另一个人看到的是别人兴趣的句子。
  // 云端那条约束本来就是 `unique (user_id, word_id, interest_tag)`，两边口径要一致。
  user_examples: "id, &[user_id+word_id+interest_tag], word_id",
  ai_usage: "id, [user_id+created_at], created_at, task",
} as const;

export class CijingjiDB extends Dexie {
  // 内容层
  curricula!: Table<Curriculum, string>;
  volumes!: Table<Volume, string>;
  units!: Table<Unit, string>;
  words!: Table<Word, string>;
  senses!: Table<Sense, string>;
  word_placements!: Table<WordPlacement, string>;
  goal_profiles!: Table<GoalProfile, string>;

  // 用户层
  profiles!: Table<Profile, string>;
  daily_plans!: Table<DailyPlan, string>;
  review_logs!: Table<ReviewLog, string>;
  user_examples!: Table<UserExample, string>;
  ai_usage!: Table<AiUsage, string>;

  constructor() {
    super("cijingji");
    this.version(1).stores(STORES);

    /**
     * ── v2：只为补 `updated_at` 两个字段，索引一个没动 ────────────
     *
     * 为什么走版本升级，而不是"读的时候顺手补一个"：
     * 那样会变成"谁读谁补"—— 界面读的时候补了，那同步器直接读全表时补不补？
     * 一旦两处都补，就有两个口径，将来必然分叉。
     * 存量数据只有**一次性补齐**，"类型里写了 `updated_at: string`"才是真的。
     *
     * 升级事务是原子的：中途出错会整体回滚，不会留下改一半的表。
     */
    this.version(2)
      .stores(STORES)
      .upgrade(async (tx) => {
        await tx
          .table("profiles")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!row.updated_at) row.updated_at = row.created_at ?? new Date().toISOString();
          });

        await tx
          .table("daily_plans")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!row.updated_at) row.updated_at = row.generated_at ?? new Date().toISOString();
          });
      });

    /**
     * ── v3：把编号改成"带主人"，顺带修正例句的唯一索引 ──────────────
     *
     * 两件事必须一起做，所以合成一个版本：
     *
     * ① **索引变了**（例句的唯一索引加上了 `user_id`，见上面 STORES 的注释）。
     *    Dexie 只在**版本号提升**时才会重建索引 —— 不写这一版，
     *    已经升过级的库（也就是所有在用的浏览器）会一直留着旧索引，
     *    新索引只对"全新装的用户"生效。**这类差异最难发现：老用户坏、新用户好。**
     *
     * ② **存量行的 id 还是旧格式**（`plan:<日期>`、`ex:<词>:<兴趣>`），
     *    重写成带主人的新格式。不做的话，新代码按新格式去读，读到的是 `undefined`
     *    —— 用户看到"我的进度没了"，而且旧行还占着位置，同步时会撞云端主键。
     *
     * 编号规则**从 `./ids` 取**，不在这里重写一遍：迁移和生成必须是同一份规则，
     * 两处各写一遍早晚分叉（改了生成忘了改迁移，存量数据就永远留在旧格式上）。
     *
     * 升级事务是原子的：中途出错整体回滚，不会留下改一半的表。
     */
    this.version(3)
      .stores(STORES)
      .upgrade(async (tx) => {
        await rewriteOwnerInId(tx, "daily_plans", (row) =>
          planIdFor(String(row.plan_date), String(row.user_id)),
        );
        await rewriteOwnerInId(tx, "user_examples", (row) =>
          exampleIdFor(String(row.word_id), String(row.interest_tag), String(row.user_id)),
        );
      });
  }
}

/**
 * 把一批行的主键重写成"带主人"的新格式（给 v3 升级事务用）。
 *
 * 为什么不用 `toCollection().modify()`：那个改**字段**很顺手，改**主键**不行 ——
 * 主键是索引的锚，Dexie 不允许原地改（会报 `ModifyError` 或者干脆静默不生效）。
 * 老实"删旧行 + 写新行"。
 *
 * 只挑"按新规则算出来的 id 与自己现在的 id 不同"的行，所以它**可以重复跑**
 * （第二遍进来一条都不匹配）。幂等这件事值钱：将来把这段挪到别处复用时，
 * 不必担心"跑第二遍会不会把数据搞坏"。
 */
async function rewriteOwnerInId(
  tx: Transaction,
  table: string,
  makeId: (row: Record<string, unknown>) => string,
): Promise<void> {
  const coll = tx.table<Record<string, unknown>, string>(table);
  const rows = await coll.toArray();
  const stale = rows.filter((row) => row.id !== makeId(row));
  if (stale.length === 0) return;

  await coll.bulkDelete(stale.map((row) => String(row.id)));
  await coll.bulkPut(stale.map((row) => ({ ...row, id: makeId(row) })));
}

/** 单例。客户端组件里直接用这个。 */
export const db = new CijingjiDB();
