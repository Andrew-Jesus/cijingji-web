/**
 * 把「教材单元词表 JSON」转成本地种子文件 lib/db/seed-data.json
 *
 * 用法：
 *   node scripts/build-seed.mjs                              # 默认：外研社 八上 + 八下 + 九上
 *   node scripts/build-seed.mjs a.json b.json ...            # 指定若干册，顺序即册次顺序
 *   node scripts/build-seed.mjs --only=8B                    # 只出某一册（自检用）
 *   node scripts/build-seed.mjs --out=lib/db/seed-data.json  # 换输出位置
 *
 * ── 2026-10-02 改版 ────────────────────────────────────────────────
 * 上一版一次只吃一本书，产出**单册**种子。八下 / 九上转录验收完之后，
 * 「换一本书」在产品里变成了真实存在的动作 —— 于是这一版把「多册合并」
 * 做成脚本本身的能力，而不是靠跑三遍再手工拼 JSON。
 *
 * 四层模型里，册次属于课程图谱，而**词条（words）是跨册共享的**：
 * 同一个词在八上出现过、九上又出现，`words` 里仍然只有一行，
 * 两册各留一条 `word_placements` —— 这正是「词条向外借、归属自己建」的落点。
 * 所以合并时 **words / senses 必须按 lemma 去重，placement 绝不能去重**。
 *
 * ── 六条纪律（前四条沿用上一版，后两条本轮新增）────────────────────
 *   ① `is_core` **不导入**。八上按口径 v2 该字段留空；八下 / 九上虽跑出了算法判定，
 *      但含人工判读成分、且各册判据强度不一致 —— 一律 null，产品侧继续**不展示**
 *      「重点词筛选」，而不是显示成「0 个重点词」（那是把"不知道"伪装成"没有"）。
 *   ② 导入 `word` 与 `phrase` 两类（**2026-10-03 放宽**，原先只收 `word`）。
 *      **短语就是词条**：`take part in` / `be flooded with` 这类是课本明确要求掌握的，
 *      进 `words` 后与单词共用同一套卡片 / 判分 / 排期，不需要发明新字段 ——
 *      产品侧从不按 `entry_type` 分叉，判分也会折叠多余空格，两者走的是同一条链路。
 *      专有名词（`proper_noun`）仍不进产品：那是读物里的名字，不是要背的词。
 *   ③ 不猜数据：`role` 一律 new；`phonetic_us` 留空（只有一份音标，不伪造英美差异）；
 *      `title_zh` / `theme_tags` 留空。
 *   ④ `confidence` / `is_verified` **取自语料本身**，不在脚本里另判 ——
 *      脚本改一个数字就能"把数据变好看"，那是最不该有的口子。
 *   ⑤ **同一词跨册出现时，音标 / 释义若不一致必须记进 warnings**，
 *      不得静默取第一条（"静默覆盖"是本项目反复踩过的坑）。
 *   ⑥ 种子带 `content_version`（内容指纹）。**内容变一位数，产品端就重灌一次**；
 *      没有它的话，老用户会永远停在第一次装进去的那本书上 ——
 *      「新数据只在全新浏览器里可见」是最难发现的一类故障。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 参数 ---------------------------------------------------------------
const args = process.argv.slice(2);
const flags = new Map(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const positional = args.filter((a) => !a.startsWith("--"));

/** 默认三册。顺序 = 册次顺序 = 产品选择面板里的顺序 */
const DEFAULT_VOLUMES = ["八上", "八下", "九上"].map((tag) =>
  path.join(__dirname, `../../词径记-外研社${tag}-单元词表-v3.json`),
);

const OUT = path.resolve(__dirname, flags.get("out") ?? "../lib/db/seed-data.json");
const curriculumCode = flags.get("curriculum") ?? "wys_2024";
const goalCode = flags.get("goal") ?? "zhongkao";
/** 出版社的短名 —— 用户不认识"外语教学与研究出版社"，但认识"外研社" */
const publisherShort = flags.get("publisher-short") ?? "外研社";

// ---- 通用小工具 ----------------------------------------------------------
const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

const GRADE_NUM = { 七: 7, 八: 8, 九: 9 };

/** 「八年级」+「上册」→ 「8A」。返回 null = 这本册次的年级/册别没写清，宁可报错也不猜 */
function volumeKeyOf(cur) {
  const m = /([七八九])年级/.exec(cur.grade ?? "");
  const grade = m ? GRADE_NUM[m[1]] : null;
  const vol = cur.volume ?? "";
  const term = vol.includes("下") ? "B" : vol.includes("上") ? "A" : null;
  if (!grade || !term) return null;
  return `${grade}${term}`;
}

function termOf(volumeLabel) {
  if ((volumeLabel ?? "").includes("上")) return "上";
  if ((volumeLabel ?? "").includes("下")) return "下";
  return "全";
}

/**
 * 验收结论归一化。
 *
 * 为什么要有这一步：八上 v3 的 `QC.acceptance_criteria` 是个**对象**（老写法），
 * 八下 / 九上 v3 是个**字符串**（指向口径文档），结论另放在 `QC.acceptance`。
 * 两种都见过，所以这里统一成一种形状 —— 否则"八上能跑、九上崩"这种
 * 因数据形状不一致而导致的失败，每次加册都要重查一遍。
 */
function normalizeAcceptance(qc) {
  const ac = qc?.acceptance_criteria;
  if (ac && typeof ac === "object") {
    return {
      name: ac.name ?? null,
      effective: ac.effective ?? null,
      rule: ac.rule ?? null,
      result: ac.result ?? null,
      note: ac.note ?? null,
      why_not_full_pass: ac.why_not_full_pass ?? null,
    };
  }
  const a = qc?.acceptance ?? null;
  return {
    name: typeof ac === "string" ? ac : null,
    effective: null,
    rule: null,
    result: a?.conclusion ?? null,
    note: a?.reason ?? null,
    why_not_full_pass: a?.condition ?? null,
  };
}

/**
 * 进产品的条目类型。
 *
 * 为什么把「短语」和「单词」放进同一个容器：对学习者来说 `take part in` 和
 * `instead` 是同一件事 —— 都是课本要求我掌握的、要能认出来也能写出来的东西。
 * 分两个容器会立刻带来短语卡要不要单独一套模板这种没必要的分叉。
 */
const IMPORTED_TYPES = new Set(["word", "phrase"]);

// ---- 逐册归一 ------------------------------------------------------------
const warnings = [];
const filePaths = (positional.length ? positional : DEFAULT_VOLUMES).map((p) => path.resolve(p));
const only = flags.get("only");

const normalized = [];
for (const fp of filePaths) {
  const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
  const cur = raw.curriculum;
  const key = volumeKeyOf(cur);
  if (!key) {
    throw new Error(
      `${path.basename(fp)}：curriculum 里读不出「年级+册别」（grade=${cur.grade} volume=${cur.volume}）`,
    );
  }
  if (only && key !== only) continue;

  const volumeId = `${curriculumCode}:${key}`;
  const qc = raw.QC ?? {};
  const allEntries = [...(raw.words ?? []), ...(raw.proper_nouns ?? [])];
  const imported = allEntries.filter((w) => IMPORTED_TYPES.has(w.entry_type));
  const skipped = allEntries.filter((w) => !IMPORTED_TYPES.has(w.entry_type));

  normalized.push({
    file: path.basename(fp),
    volumeKey: key,
    volumeId,
    cur,
    qc,
    acceptance: normalizeAcceptance(qc),
    allEntries,
    imported,
    skipped,
    units: (cur.units ?? []).map((u) => ({
      id: `${volumeId}:U${u.unit_no}`,
      volume_id: volumeId,
      unit_no: u.unit_no,
      unit_code: `Unit ${u.unit_no}`,
      title_en: u.title,
      title_zh: null, // 语料里没有中文单元名 —— 不编，留空
      theme_tags: [], // 不靠猜主题词生成标签
      sort_order: u.unit_no,
      // 页码校验 0 违规 + 已按口径 v2 逐字段核验 ⇒ 该单元可用
      is_verified:
        (qc.page_range_violations?.length ?? 1) === 0 && qc.verification_status?.is_verified !== false,
    })),
  });
}

if (normalized.length === 0) throw new Error("一册都没匹配上（--only 写错了？）");

// 多册必须属于同一套课程体系，否则会被并进一个 curriculum 里 —— 那是个安静的错
const pubSet = new Set(normalized.map((v) => `${v.cur.publisher}|${v.cur.edition_year}`));
if (pubSet.size > 1) {
  throw new Error(
    `多册的出版社/版次不一致（${[...pubSet].join("  vs  ")}）：不能合成一个课程体系`,
  );
}

const cur0 = normalized[0].cur;

// ---- 1. 课程图谱：curricula / volumes / units ----------------------------
const curricula = [
  {
    id: curriculumCode,
    code: curriculumCode,
    kind: "textbook",
    publisher: cur0.publisher,
    edition_year: cur0.edition_year,
    display_name: `${publisherShort}版 初中英语（${cur0.edition_year} 版）`,
    region_hint: [],
    status: "active",
  },
];

const units = normalized.flatMap((v) => v.units);

// ---- 2. 词条层 + 归属层 --------------------------------------------------
const words = [];
const senses = [];
const placements = [];
const seenLemma = new Map(); // lemma_normalized -> { word_id, phonetic, meaning_zh, unit_no, volume_id, count }
const seenPlacementId = new Set();
let duplicatePlacementCount = 0;

for (const vol of normalized) {
  for (const w of vol.imported) {
    const lemmaNormalized = normalize(w.headword);
    const wordId = `w:${lemmaNormalized}`;
    const unitId = `${vol.volumeId}:U${w.unit_no}`;

    const prev = seenLemma.get(lemmaNormalized);
    if (!prev) {
      seenLemma.set(lemmaNormalized, {
        word_id: wordId,
        phonetic: w.phonetic || null,
        meaning_zh: w.meaning_zh,
        unit_no: w.unit_no,
        volume_id: vol.volumeId,
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
      prev.count += 1;
      // 纪律 ⑤：跨册的不一致必须留痕，不能静默取第一条
      if ((w.phonetic || null) !== prev.phonetic) {
        warnings.push({
          type: "cross_volume_phonetic_conflict",
          lemma: w.headword,
          first: { volume_id: prev.volume_id, phonetic: prev.phonetic },
          later: { volume_id: vol.volumeId, phonetic: w.phonetic || null },
          note: "同形词在另一册的音标不同：words 表只有一份音标，保留先录入的那份",
        });
      }
      if (prev.meaning_zh !== w.meaning_zh) {
        warnings.push({
          type: "duplicate_lemma_meaning_conflict",
          lemma: w.headword,
          first: { volume_id: prev.volume_id, unit_no: prev.unit_no, meaning_zh: prev.meaning_zh },
          later: { volume_id: vol.volumeId, unit_no: w.unit_no, meaning_zh: w.meaning_zh },
          note: "同形不同义：本阶段只保留第一条义项，未被保留的义项需在阶段 1 用 senses 补全",
        });
      }
    }

    // placement 的 id 带单元，所以同一词跨册 / 跨单元各留一条 —— 这正是设计意图
    const placementId = `p:${lemmaNormalized}:${unitId}`;
    if (seenPlacementId.has(placementId)) {
      duplicatePlacementCount += 1;
      continue;
    }
    seenPlacementId.add(placementId);
    placements.push({
      id: placementId,
      word_id: wordId,
      unit_id: unitId,
      sense_id: null,
      role: "new",
      is_core: null, // 纪律 ①：一律未知
      occurrence_no: prev ? prev.count : 1,
      first_volume_id: prev ? prev.volume_id : null,
      source: w.source ?? "extracted",
      confidence: w.confidence ?? 0.75,
      is_verified: w.is_verified ?? false,
    });
  }
}
if (duplicatePlacementCount > 0) {
  warnings.push({
    type: "duplicate_placement_skipped",
    count: duplicatePlacementCount,
    note: "同一册同一单元出现了重复的「词+单元」——已跳过重复项，请核对源数据",
  });
}

// ---- 3. 册次层（要等 placement 算完才知道词数）---------------------------
/** 册次顺序 = 年级升序、同年级上册在前。产品选择面板直接照这个顺序渲染 */
const TERM_RANK = { 上: 0, 下: 1, 全: 2 };
const volumes = normalized
  .map((v) => ({
    id: v.volumeId,
    curriculum_id: curriculumCode,
    grade_label: `${v.cur.grade}${v.cur.volume}`,
    grade_num: GRADE_NUM[/([七八九])年级/.exec(v.cur.grade)[1]],
    term: termOf(v.cur.volume),
    word_count: placements.filter((p) => p.unit_id.startsWith(`${v.volumeId}:`)).length,
    status: "active",
  }))
  .sort((a, b) => a.grade_num - b.grade_num || TERM_RANK[a.term] - TERM_RANK[b.term]);

// ---- 4. 策略包：中考（一笔一行配置） --------------------------------------
const goal_profiles = [
  {
    id: `${goalCode}@v1`,
    goal_code: goalCode,
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
    user_facing_summary: "按你的课本单元来，重点练会写，每个词只练课本里考的那个意思。",
  },
];

// ---- 5. 诚实标注（唯一的用户可见文案来源） --------------------------------
const verifiedCount = placements.filter((p) => p.is_verified).length;
const allVerified = verifiedCount === placements.length;
const confidences = [...new Set(placements.map((p) => p.confidence))];
const minConfidence = Math.min(...confidences);

const gradeLabels = volumes.map((v) => v.grade_label).join(" / ");
const honest_note = allVerified
  ? `${publisherShort}版初中英语（${cur0.edition_year} 版）${gradeLabels}：拼写、音标、词性、释义、页码都对着课本逐条核过，没发现错。` +
    `只有「哪些是重点词」还判不准（课本是用加粗标的，机器认不出字重），所以暂时不提供重点词筛选。`
  : `${publisherShort}版初中英语（${cur0.edition_year} 版）${gradeLabels} 词表还没逐条核对过，可信度 ${minConfidence}，个别地方可能有出入。`;

// ---- 6. 内容指纹（纪律 ⑥）------------------------------------------------
// 只对**内容表**取指纹：样式、日期、报告这些变了不该触发重灌 ——
// 否则每次构建都会让所有用户重灌一遍词库。
const contentVersion = crypto
  .createHash("sha256")
  .update(
    JSON.stringify({ curricula, volumes, units, words, senses, word_placements: placements, goal_profiles }),
  )
  .digest("hex")
  .slice(0, 12);

// ---- 7. 报告 -------------------------------------------------------------
const perVolume = normalized.map((v) => ({
  volume_id: v.volumeId,
  grade_label: `${v.cur.grade}${v.cur.volume}`,
  source: v.file,
  acceptance: v.acceptance.result,
  entries_total: v.allEntries.length,
  entries_imported: v.imported.length,
  entries_skipped: v.skipped.length,
  skipped_by_type: v.skipped.reduce((acc, w) => {
    acc[w.entry_type] = (acc[w.entry_type] ?? 0) + 1;
    return acc;
  }, {}),
  units: v.units.length,
  placements: placements.filter((p) => p.unit_id.startsWith(`${v.volumeId}:`)).length,
  per_unit: v.units.map((u) => ({
    unit_code: u.unit_code,
    title_en: u.title_en,
    imported: v.imported.filter((w) => w.unit_no === u.unit_no).length,
  })),
}));

const report = {
  sources: normalized.map((v) => v.file),
  built_at: new Date().toISOString().slice(0, 10),
  content_version: contentVersion,
  acceptance: normalized.map((v) => ({
    volume_id: v.volumeId,
    grade_label: `${v.cur.grade}${v.cur.volume}`,
    result: v.acceptance.result,
    why_not_full_pass: v.acceptance.why_not_full_pass,
  })),
  counts: {
    volumes: volumes.length,
    entries_total: normalized.reduce((n, v) => n + v.allEntries.length, 0),
    entries_imported: normalized.reduce((n, v) => n + v.imported.length, 0),
    entries_skipped: normalized.reduce((n, v) => n + v.skipped.length, 0),
    words: words.length,
    senses: senses.length,
    placements: placements.length,
    units: units.length,
  },
  confidence: { distinct: confidences, min: minConfidence, verified: verifiedCount },
  per_volume: perVolume,
  warnings,
};

const bundle = {
  meta: {
    purpose: `${publisherShort}版初中英语（${cur0.edition_year} 版）${gradeLabels} 单元级词汇归属数据 —— 产品里真正在用的数据源。`,
    schema_version: "word_placements/v1.1",
    curriculum_code: curriculumCode,
    volume_ids: volumes.map((v) => v.id),
    /** 新用户的第一本书：第一部册次的 Unit 1。必须与 lib/scope/schema.ts 的 defaultScope() 对齐 */
    default_unit_id: `${volumes[0].id}:U1`,
    confidence: minConfidence,
    is_verified: allVerified,
    content_version: contentVersion,
    acceptance: normalized.map((v) => ({ volume_id: v.volumeId, ...v.acceptance })),
    honest_note,
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
console.log("内容指纹:", contentVersion);
console.log(JSON.stringify(report.counts, null, 1));
console.log("置信度:", JSON.stringify(report.confidence));
for (const v of perVolume) {
  console.log(
    `  ${v.grade_label}（${v.source}）验收=${v.acceptance ?? "未标注"}  ` +
      `导入 ${v.entries_imported}/${v.entries_total} 条，跳过 ${v.entries_skipped}  ` +
      `→ ${v.placements} 条归属 / ${v.units} 单元`,
  );
  console.log("    " + v.per_unit.map((u) => `${u.unit_code}=${u.imported}`).join("  "));
}
if (warnings.length) {
  console.log(`\n注意：${warnings.length} 条数据冲突已记入 warnings（不会静默丢失）：`);
  for (const w of warnings) console.log("  -", JSON.stringify(w));
}
