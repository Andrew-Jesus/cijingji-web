/**
 * 种子数据装载（幂等）
 *
 * 阶段 0 的数据来源是词表文件转化的 lib/db/seed-data.json。
 * 只做一件事：**内容变了就重灌一次内容层**；没变就什么都不做。
 *
 * ── 2026-10-02 改版：从「灌一次」改成「按内容指纹灌」────────────────
 *
 * 上一版是"本地库为空时灌一次"（`db.words.count() > 0` 就退出）。这在只有一本书
 * 的时候没问题，但八下 / 九上转录完之后它变成了一个**静默的坑**：
 * 老用户库里已经有 244 个词 → 判断"灌过了" → 从此**永远看不到新增的两册书**，
 * 界面上的选择面板只有八上。而全新装的浏览器一切正常 ——
 * 「新数据只在全新浏览器里可见」是最难被发现的一类故障。
 *
 * 所以改成看**内容指纹**：
 *   ① 库里已有的册次 / 单元结构与种子里的一致，且
 *   ② localStorage 里记的内容指纹与种子一致
 * 两个条件都满足才跳过。
 *
 * ── 为什么指纹放 localStorage，而不是新开一张 Dexie 表 ─────────────
 * 开新表要升 Dexie 版本号、改 local.ts 的 STORES，改动面比它解决的问题大。
 * localStorage 的代价是「用户只清了 IndexedDB、没清 localStorage」时会误判 ——
 * 所以 ① 结构比对是**必须的**（不能只靠指纹），它同时也是纯本地私有模式下唯一可用的判据。
 * 私有模式读不到 localStorage 时，只是**退化成"结构变了才重灌"**，仍然不会卡死在旧书上。
 *
 * ── 只动内容层，一张用户层表都不碰 ─────────────────────────────
 * 重灌 = 清空 7 张内容表 + 重新灌入。内容层是共享只读数据，
 * 用户层（profiles / daily_plans / review_logs / user_examples / ai_usage）**一个字都不改**。
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
  meta: {
    honest_note: string;
    confidence: number;
    is_verified: boolean;
    /** 内容指纹：由 scripts/build-seed.mjs 对内容表取 sha256 得到，前 12 位 */
    content_version: string;
    curriculum_code: string;
    volume_ids: string[];
    default_unit_id: string;
  };
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

/** 内容指纹的落盘位置。**版本号变了，键名不用变** —— 值本身就带着版本的含义 */
const MARKER_KEY = "cj.content.version";

function readMarker(): string | null {
  try {
    return window.localStorage.getItem(MARKER_KEY);
  } catch {
    // 隐私模式 / 禁用存储：读不到就当"没记过"，下面的结构比对会兜住
    return null;
  }
}

function writeMarker(version: string): void {
  try {
    window.localStorage.setItem(MARKER_KEY, version);
  } catch {
    /* 记不住就算了，下次多灌一遍而已 —— 不该因此打断用户 */
  }
}

/**
 * 库里现有的内容，是不是就是种子里那份？
 *
 * 判据刻意选**结构性的**（册次集合 + 单元总数），因为它在"读不到 localStorage"时
 * 仍然有效。少一个册次就说明新书没进来，必须重灌。
 */
async function contentLooksCurrent(db: CijingjiDB): Promise<boolean> {
  const [words, volumes, unitCount] = await Promise.all([
    db.words.count(),
    db.volumes.toArray(),
    db.units.count(),
  ]);
  if (words === 0) return false;

  const want = new Set(seedBundle.meta.volume_ids);
  const have = new Set(volumes.map((v) => v.id));
  if (want.size !== have.size) return false;
  for (const id of want) if (!have.has(id)) return false;

  if (unitCount !== seedBundle.units.length) return false;

  // 结构对上了，再看指纹。读不到指纹（私有模式）就认结构 —— 宁可少灌，不要卡在旧书
  const marker = readMarker();
  return marker === null || marker === seedBundle.meta.content_version;
}

/**
 * 保证本地库里的内容层与种子一致。
 *
 * 返回值语义：`true` = 这次真的灌了（内容有变）；`false` = 已经是最新的，什么都没做。
 * 调用方（首页 / 学习页 / 控制台 / 引导页）都不关心返回值，但测试关心。
 */
export async function ensureSeeded(db: CijingjiDB): Promise<boolean> {
  if (await contentLooksCurrent(db)) return false;

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
      // 先清后灌，而不是只 bulkPut：种子里**删掉**的东西（比如某条归属被修正合并）
      // 不这样做会永远留在库里，界面上会冒出课本上根本没有的词。
      await Promise.all([
        db.curricula.clear(),
        db.volumes.clear(),
        db.units.clear(),
        db.words.clear(),
        db.senses.clear(),
        db.word_placements.clear(),
        db.goal_profiles.clear(),
      ]);

      await db.curricula.bulkPut(seedBundle.curricula);
      await db.volumes.bulkPut(seedBundle.volumes);
      await db.units.bulkPut(seedBundle.units);
      await db.words.bulkPut(seedBundle.words);
      await db.senses.bulkPut(seedBundle.senses);
      await db.word_placements.bulkPut(seedBundle.word_placements);
      await db.goal_profiles.bulkPut(seedBundle.goal_profiles);
    },
  );

  writeMarker(seedBundle.meta.content_version);
  return true;
}
