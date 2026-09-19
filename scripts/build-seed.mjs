/**
 * 把「人教版八上 551 条样张」转成本地种子文件 lib/db/seed-data.json
 *
 * 用法：node scripts/build-seed.mjs
 *
 * 三条纪律（阶段 0 实施方案 §6.2）：
 *   ① emphasis 字段一律不导入 —— 已实证该字段错误率约 17%，不用的字段就不导入。
 *   ② 只导入 entry_type === 'word' 的条目。短语 / 专有名词的容器（phrases 表）
 *      上游四层模型里是独立表，本阶段不为了一个开关去发明字段 —— 留到阶段 1 与真实数据一起建。
 *   ③ 不猜数据：role 一律 new（没有七上/七下数据，无法判定"复现"）；
 *      is_core 一律 null（emphasis 不可信，宁可标"未知"也不标 false）；
 *      phonetic_us 留空（只有一份音标，不伪造英美差异）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../../词径记-人教版八上-单元词表样本-v1.json");
const OUT = path.resolve(__dirname, "../lib/db/seed-data.json");

const CONFIG = {
  curriculumCode: "renjiao_2024",
  volumeId: "renjiao_2024:8A",
  goalCode: "zhongkao",
  confidence: 0.75, // 样张数据未经人工抽查，沿用样本原值
};

/** 词表顺序：保留样本里的原始顺序，只是过滤掉非单词条目 */
const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

const raw = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
const all = raw.words;
const wordsOnly = all.filter((w) => w.entry_type === "word");

const warnings = [];

// ---- 1. 课程图谱：curricula / volumes / units
const curricula = [
  {
    id: CONFIG.curriculumCode,
    code: CONFIG.curriculumCode,
    kind: "textbook",
    publisher: raw.curriculum.publisher,
    edition_year: raw.curriculum.edition_year,
    display_name: `${raw.curriculum.publisher}（${raw.curriculum.edition_year} 版）`,
    region_hint: [],
    status: "active",
  },
];

const vocabOfVolume = (unitNo) =>
  wordsOnly.filter((w) => w.unit_no === unitNo).length;

const volumes = [
  {
    id: CONFIG.volumeId,
    curriculum_id: CONFIG.curriculumCode,
    grade_label: `${raw.curriculum.grade}${raw.curriculum.volume}`,
    grade_num: 8,
    term: "上",
    word_count: wordsOnly.length,
    status: "active",
  },
];

const units = raw.curriculum.units.map((u) => ({
  id: `${CONFIG.volumeId}:U${u.unit_no}`,
  volume_id: CONFIG.volumeId,
  unit_no: u.unit_no,
  unit_code: `Unit ${u.unit_no}`,
  title_en: u.title,
  title_zh: null, // 样本里没有中文单元名 —— 不编，留空
  theme_tags: [], // 不靠猜主题词生成标签
  sort_order: u.unit_no,
  is_verified: false,
}));

// ---- 2. 词条层 + 归属层
const words = [];
const senses = [];
const placements = [];
const seenLemma = new Map(); // lemma_normalized -> { word_id, meaning_zh, unit_no }

for (const w of wordsOnly) {
  const lemmaNormalized = normalize(w.headword);
  const wordId = `w:${lemmaNormalized}`;
  const unitId = `${CONFIG.volumeId}:U${w.unit_no}`;

  if (!seenLemma.has(lemmaNormalized)) {
    seenLemma.set(lemmaNormalized, {
      word_id: wordId,
      meaning_zh: w.meaning_zh,
      unit_no: w.unit_no,
      count: 1,
    });
    words.push({
      id: wordId,
      lemma: w.headword,
      lemma_normalized: lemmaNormalized,
      phonetic_uk: w.phonetic || null,
      phonetic_us: null,
      freq_rank: null,
    });
    senses.push({
      id: `s:${lemmaNormalized}:primary`,
      word_id: wordId,
      pos: w.pos ? w.pos.split(/[;，]/)[0].trim() || null : null,
      cn_meaning: w.meaning_zh,
      is_primary: true,
    });
  } else {
    // 同一个词在多个单元出现 —— 这是两条真实事实（两条 placement 是对的），
    // 但释义不同时我们必须把冲突记下来，不能默默用第一条覆盖。
    const prev = seenLemma.get(lemmaNormalized);
    prev.count += 1;
    if (prev.meaning_zh !== w.meaning_zh) {
      warnings.push({
        type: "duplicate_lemma_meaning_conflict",
        lemma: w.headword,
        first: { unit_no: prev.unit_no, meaning_zh: prev.meaning_zh },
        later: { unit_no: w.unit_no, meaning_zh: w.meaning_zh },
        note: "同形不同义：阶段 0 只保留第一条义项，未被保留的义项需在阶段 1 用 senses 补全",
      });
    }
  }

  placements.push({
    id: `p:${lemmaNormalized}:${unitId}`,
    word_id: wordId,
    unit_id: unitId,
    sense_id: null,
    role: "new",
    is_core: null,
    occurrence_no: 1,
    first_volume_id: null,
    source: "extracted",
    confidence: CONFIG.confidence,
    is_verified: false,
  });
}

// ---- 3. 策略包：中考（一笔一行配置。权重只填上游文档给出的前三位，其余留待补全）
const goal_profiles = [
  {
    id: `${CONFIG.goalCode}@v1`,
    goal_code: CONFIG.goalCode,
    version: 1,
    channel_weights: { recognize: 0.4, recall_spell: 0.3, collocate: 0.15 },
    sense_policy: "single",
    context_sources: ["textbook_unit", "generated_topic"],
    networks: { topic_cluster: 0.5, morphology: 0.3 },
    pace: {
      new_ratio: 0.6,
      session_size: 20,
      spelling_required: true,
      speed_drill: false,
      review_priority: "weak_first",
    },
    phases: {},
    user_facing_summary:
      "按你的课本单元来，重点练会写，每个词只练课本里考的那个意思。",
  },
];

// ---- 4. 报告
const report = {
  source: path.basename(SAMPLE),
  built_at: new Date().toISOString().slice(0, 10),
  counts: {
    entries_total: all.length,
    entries_imported: wordsOnly.length,
    entries_skipped: all.length - wordsOnly.length,
    skipped_by_type: {
      phrase: all.filter((w) => w.entry_type === "phrase").length,
      proper_noun: all.filter((w) => w.entry_type === "proper_noun").length,
    },
    words: words.length,
    senses: senses.length,
    placements: placements.length,
    units: units.length,
  },
  per_unit: units.map((u) => ({
    unit_code: u.unit_code,
    title_en: u.title_en,
    imported: vocabOfVolume(u.unit_no),
  })),
  warnings,
};

const bundle = {
  meta: {
    purpose:
      "阶段 0 本地种子数据。样张来源为人教版八上，仅用于界面与流程验证，与 Andy 的外研社课本不一致。",
    schema_version: "word_placements/v1.1",
    confidence: CONFIG.confidence,
    is_verified: false,
    honest_note:
      "本单元词表为样张数据（人教版八上），与你的课本不一致，且尚未经人工核对，可信度 0.75。",
  },
  report,
  curricula,
  volumes,
  units,
  words,
  senses,
  word_placements: placements,
  goal_profiles,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(bundle, null, 1), "utf8");

console.log("已生成:", path.relative(process.cwd(), OUT));
console.log(JSON.stringify(report.counts, null, 1));
console.log("每单元导入词数:", report.per_unit.map((u) => `${u.unit_code}=${u.imported}`).join("  "));
if (warnings.length) {
  console.log(`注意：${warnings.length} 条数据冲突已记入 warnings（不会静默丢失）：`);
  for (const w of warnings) console.log("  -", JSON.stringify(w));
}
