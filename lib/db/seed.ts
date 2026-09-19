/**
 * 种子数据装载（幂等）
 *
 * 阶段 0 的数据来源是样张文件转化的 lib/db/seed-data.json。
 * 只做一件事：本地库为空时灌一次种子；已有数据时什么都不做。
 */
import type { CijingjiDB } from "./local";
import bundleJson from "./seed-data.json";
import type {
  Curriculum,
  GoalProfile,
  Sense,
  Unit,
  Volume,
  Word,
  WordPlacement,
} from "./types";

export interface SeedBundle {
  meta: { honest_note: string; confidence: number; is_verified: boolean };
  report: { counts: Record<string, number>; warnings: unknown[] };
  curricula: Curriculum[];
  volumes: Volume[];
  units: Unit[];
  words: Word[];
  senses: Sense[];
  word_placements: WordPlacement[];
  goal_profiles: GoalProfile[];
}

/** JSON 是构建产物、无类型信息，在这里做唯一一次收口断言 */
export const seedBundle = bundleJson as unknown as SeedBundle;

/** 界面上的诚实提示文案：唯一来源是种子文件里的这句，避免两处不一致 */
export const DATA_HONEST_NOTE = seedBundle.meta.honest_note;

export async function ensureSeeded(db: CijingjiDB): Promise<boolean> {
  const existing = await db.words.count();
  if (existing > 0) return false; // 已灌过，幂等退出

  await db.transaction(
    "rw",
    [
      db.curricula,
      db.volumes,
      db.units,
      db.words,
      db.senses,
      db.word_placements,
      db.goal_profiles,
    ],
    async () => {
      await db.curricula.bulkPut(seedBundle.curricula);
      await db.volumes.bulkPut(seedBundle.volumes);
      await db.units.bulkPut(seedBundle.units);
      await db.words.bulkPut(seedBundle.words);
      await db.senses.bulkPut(seedBundle.senses);
      await db.word_placements.bulkPut(seedBundle.word_placements);
      await db.goal_profiles.bulkPut(seedBundle.goal_profiles);
    },
  );

  return true;
}
