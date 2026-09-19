/**
 * 词径记 · 本地数据库（Dexie / IndexedDB）
 *
 * 设计要点：**本地表结构与未来云端逐字同构**。
 * 阶段 1 接 Supabase 时，只需把 lib/db/local.ts 换成一个同接口的 remote 实现，
 * resolveScope / buildDailyPlan 等业务代码一行不用改。
 */
import Dexie, { type Table } from "dexie";

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
    this.version(1).stores({
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
      user_examples: "id, &[word_id+interest_tag], word_id",
      ai_usage: "id, [user_id+created_at], created_at, task",
    });
  }
}

/** 单例。客户端组件里直接用这个。 */
export const db = new CijingjiDB();
