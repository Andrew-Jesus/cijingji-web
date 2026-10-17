#!/usr/bin/env node
/**
 * 离线生成「专属助记」—— 运行时零 AI（阶段 2 · B4）
 *
 * ── 为什么是离线脚本，而不是点一次调一次 AI ────────────────────
 *
 * 慢、贵、断网就没了、质量不稳定，四条里中任意一条都不该进主流程。
 * 所以：**跑一次，产出静态 JSON，产品只读本地文件**。
 *
 * ── 产物 ──────────────────────────────────────────────────────
 *
 *   lib/db/mnemonics.json
 *     { meta: {...}, items: { "w:condition": { text, kind, generator, created_at } } }
 *
 * ⚠️ **为什么没塞进 seed-data.json**（方案原文写的是「像词库一样进 seed」）：
 * seed 是 IndexedDB 的初始数据，改它要动 `content_version` 才会让老用户重灌；
 * 而助记是**随 JS 一起发布的静态资源**，用户打开新版本自然会拿到。
 * 塞进 seed 反而会逼所有老用户重灌一遍 698 个词，为一个 30 条的表不值。
 * 这是有意的偏离，不是漏做。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *
 *   node scripts/gen-mnemonics.mjs                 # 生成 30 条（默认）
 *   node scripts/gen-mnemonics.mjs --limit 5       # 先试 5 条
 *   node scripts/gen-mnemonics.mjs --dry-run       # 只选词、不发请求（不花钱）
 *   node scripts/gen-mnemonics.mjs --merge         # 保留已有条目，只补新的
 *   node scripts/gen-mnemonics.mjs --base-url http://127.0.0.1:8787   # 指向假模型
 *
 * 需要 `.env.local` 里的 `DEEPSEEK_API_KEY`（或 `GLM_API_KEY`）是真 Key。
 *
 * ── 三条硬约束（与项目「AI 边界」一致）──────────────────────────
 *
 *   1. **只生成「编出来的」东西**：联想 / 谐音 / 拆字 / 小故事。
 *   2. **绝不许出现词源断言**（"来自拉丁语""词根是…"）。AI 不知道，只会编，
 *      而编错的词源会被记住且几乎不会自己发现 —— 比没有更糟。脚本有规则拦截。
 *   3. **拿不准就输出「无」**，我们宁可回落通用建议，也不硬凑一句话。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ------------------------------------------------------------------ 配置

/**
 * ⚠️ 与 `lib/ai/config.ts` 的 `PROVIDERS.deepseek.defaultModel` 必须一致。
 * `lib/study/mnemonicData.test.ts` 有一条断言盯着这件事，改一处漏另一处会当场红。
 */
export const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_BASE = "https://api.deepseek.com";

/** 提示词版本。改提示词就 +1，产物里记下来，出问题能知道是哪一版生成的 */
export const PROMPT_VERSION = 1;

const CONCURRENCY = 3;
const TIMEOUT_MS = 40_000;
const MAX_RETRY = 2;

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = { limit: 30, dryRun: false, merge: false, model: "", baseUrl: "", out: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--merge") out.merge = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--model") out.model = argv[++i] ?? "";
    else if (a === "--base-url") out.baseUrl = argv[++i] ?? "";
    else if (a === "--out") out.out = argv[++i] ?? "";
  }
  return out;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ------------------------------------------------------------------ 提示词

/**
 * 提示词刻意写得短、约束写死。
 *
 * 为什么反复强调"不许提词源"：模型被问到"怎么记一个词"时，**默认行为就是讲词源**
 * （因为那听起来最像正经知识）。不写死，30 条里会混进三五条"来自拉丁语"。
 */
export function buildPrompt({ lemma, pos, meaning }) {
  return [
    `请为英语单词「${lemma}」${pos ? `（${pos}）` : ""}写一句中文助记。`,
    `它在这套教材里的意思：${meaning}`,
    "",
    "硬性要求：",
    "1. 只用联想、谐音、拆字、小故事中的一种，帮人记住拼写或意思。",
    "2. 绝对不要提词源、词根、来自哪种语言、原始含义 —— 你不知道，也不许猜。",
    "3. 不要解释语法或用法，不要举例句。",
    "4. 不超过 40 个汉字，一句话，不要换行，不要加引号。",
    "5. 想不出自然的联想就只输出：无",
  ].join("\n");
}

// ------------------------------------------------------------------ 校验

/** 词源断言的雷区。命中即丢弃 —— 宁可没有，也不能给一条假词源 */
const ETYMOLOGY_WORDS = [
  "词源",
  "词根",
  "拉丁",
  "希腊",
  "古英语",
  "古法语",
  "源自",
  "来自古",
  "origin",
  "etymolog",
];

/** 极简不雅词表。够挡住明显的，不做过度过滤（中文里的正常词会被误伤） */
const VULGAR_WORDS = ["傻逼", "傻B", "他妈", "妈的", "色情", "强奸", "操你"];

/**
 * 这条文本能不能收。
 *
 * ⚠️ 它**不判断"好不好记"** —— 那没有机器方法（见验收口径 v2 的未覆盖清单）。
 * 它只挡三类硬伤：词源断言、不雅内容、以及明显不是一句话的东西。
 */
export function checkMnemonic(text) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "空" };
  if (t === "无" || t === "無") return { ok: false, reason: "模型放弃（无）" };
  if (t.length < 4) return { ok: false, reason: "太短" };
  if (t.length > 80) return { ok: false, reason: `太长（${t.length} 字）` };
  if (/\n/.test(t)) return { ok: false, reason: "多行" };

  const lower = t.toLowerCase();
  for (const w of ETYMOLOGY_WORDS) {
    if (lower.includes(w.toLowerCase())) return { ok: false, reason: `含词源断言「${w}」` };
  }
  for (const w of VULGAR_WORDS) {
    if (t.includes(w)) return { ok: false, reason: "不雅内容" };
  }
  // 建议类文本（"多读几遍""注意拼写"）不是助记，只是把通用建议又说了一遍
  if (/^(多|要|请|注意|建议|记得多)/.test(t)) return { ok: false, reason: "像通用建议，不是助记" };
  return { ok: true };
}

// ------------------------------------------------------------------ 选词

/**
 * FNV-1a 32 位哈希。
 *
 * ⚠️ 与 `lib/util/random.ts` 的 `hashSeed` **同一算法**。脚本是 .mjs 读不了 TS，
 * 所以这里复刻一份；`mnemonic.test.ts` 有一条断言对同一个输入比对两边结果，
 * 谁改了另一处都会当场红。
 *
 * 用途：把单元内的词序打散。不这么做的话，每轮每个单元取到的都是
 * 字母表最靠前的那个词（30 个词全以 a 开头），试点就变成"只测 a 开头的词"。
 */
export function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 选词：**跨册跨单元轮转**，不是"取前 30 个"。
 *
 * 取前 30 个会全部落在八上第一单元（种子是按册/单元排的），
 * 那样评审出来的是"第一单元的词好不好记"，不是"这套方法行不行"。
 * 轮转保证 18 个单元都被覆盖，试点才有代表性。
 */
export function pickWords(snapshot, limit) {
  const primaryByWord = new Map();
  for (const s of snapshot.senses) if (s.is_primary) primaryByWord.set(s.word_id, s);

  const unitById = new Map(snapshot.units.map((u) => [u.id, u]));
  const wordById = new Map(snapshot.words.map((w) => [w.id, w]));

  const byUnit = new Map();
  for (const p of snapshot.placements) {
    if (!unitById.has(p.unit_id) || !wordById.has(p.word_id)) continue;
    const sense = primaryByWord.get(p.word_id);
    if (!sense || !sense.cn_meaning.trim()) continue;
    const arr = byUnit.get(p.unit_id);
    if (arr) arr.push(p);
    else byUnit.set(p.unit_id, [p]);
  }

  // 册次 → unit_no，跨册顺序稳定（不能只按 unit_no，三册都从 Unit 1 开始）
  const unitIds = [...byUnit.keys()].sort((a, b) => {
    const va = a.split(":")[1] ?? "";
    const vb = b.split(":")[1] ?? "";
    if (va !== vb) return va < vb ? -1 : 1;
    return (unitById.get(a)?.unit_no ?? 0) - (unitById.get(b)?.unit_no ?? 0);
  });

  const pools = new Map(
    unitIds.map((u) => [
      u,
      // 单元内按 word_id 的哈希排序：确定性（每次跑完全一样），但**与字母序无关**
      [...byUnit.get(u)].sort((x, y) => fnv1a(x.word_id) - fnv1a(y.word_id)),
    ]),
  );

  const cursor = new Map(unitIds.map((u) => [u, 0]));
  const picked = [];
  /**
   * 同一个词可能出现在多个单元（`word_placements` 有 704 条，词只有 698 个）。
   * 助记是**按词条**的，不分单元 —— 不去重就会生成两遍：多花一次钱，
   * 而且后写的把前面的覆盖掉，评审时看到的是随机的那一条。
   */
  const seenWords = new Set();
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const uid of unitIds) {
      if (picked.length >= limit) break;
      const pool = pools.get(uid) ?? [];
      const i = cursor.get(uid) ?? 0;
      if (i >= pool.length) continue;
      const p = pool[i];
      cursor.set(uid, i + 1);
      if (seenWords.has(p.word_id)) {
        // 游标已经前进过，这一轮确实动了 —— 不标记的话会被误判成"扫完了"提前退出
        progressed = true;
        continue;
      }
      const word = wordById.get(p.word_id);
      const sense = primaryByWord.get(p.word_id);
      if (!word || !sense) continue;
      seenWords.add(p.word_id);
      picked.push({
        word_id: p.word_id,
        lemma: word.lemma,
        pos: sense.pos,
        meaning: sense.cn_meaning,
        unit_id: p.unit_id,
        unit_label: `${unitById.get(p.unit_id)?.unit_code ?? ""}（${p.unit_id.split(":")[1] ?? ""}）`,
      });
      progressed = true;
    }
  }
  return picked;
}

// ------------------------------------------------------------------ 调用

async function callModel({ baseUrl, apiKey, model, prompt }) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9, // 助记要的是"有点巧"，低温度会千篇一律
    max_tokens: 300,
    // ★ DeepSeek V4-Flash 默认先思考，思考与正文**共用** max_tokens 且按输出计费。
    //   不关掉的话，预算被思考吃光会**静默返回空正文**（HTTP 200）—— 2026-09-29 踩过。
    thinking: { type: "disabled" },
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt)); // 退避，别硬碰
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue; // 限流 / 服务端故障：退避再来
      }
      if (!res.ok) {
        // 401 / 402 是死症，重试一百次也一样
        throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }

      const json = await res.json();
      const choice = json?.choices?.[0];
      const text = choice?.message?.content ?? "";
      // 判据：finish_reason === "length" 且正文为空 → 预算被思考吃光
      if (!String(text).trim() && choice?.finish_reason === "length") {
        throw new Error("返回空正文且 finish_reason=length（输出预算被吃光）");
      }
      return String(text).trim();
    } catch (e) {
      lastErr = e;
      if (e?.name === "AbortError") lastErr = new Error("超时");
    }
  }
  throw lastErr ?? new Error("未知错误");
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...readEnvFile(join(ROOT, ".env.local")), ...process.env };

  const seedPath = join(ROOT, "lib", "db", "seed-data.json");
  if (!existsSync(seedPath)) {
    console.error(`✗ 找不到词库：${seedPath}`);
    process.exit(1);
  }
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const snapshot = {
    units: seed.units,
    words: seed.words,
    senses: seed.senses,
    placements: seed.word_placements,
  };

  const picked = pickWords(snapshot, args.limit);
  const outPath = args.out ? resolve(args.out) : join(ROOT, "lib", "db", "mnemonics.json");

  let existing = { meta: {}, items: {} };
  if (args.merge && existsSync(outPath)) {
    try {
      existing = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      // 旧文件坏了就当没有 —— 不因为一份缓存挡住一次生成
    }
  }

  const target = args.merge
    ? picked.filter((w) => !existing.items?.[w.word_id])
    : picked;

  console.log(`词库 ${snapshot.words.length} 词 / ${snapshot.units.length} 单元`);
  console.log(`选中 ${picked.length} 个词${args.merge ? `，其中 ${target.length} 个还没有助记` : ""}`);
  console.log(
    `清单：${target.map((w) => `${w.lemma}(${w.meaning})`).join("、") || "（无）"}`,
  );

  if (args.dryRun) {
    console.log("\n--dry-run：只选词，不发请求、不写文件。");
    return;
  }
  if (target.length === 0) {
    console.log("\n没有要生成的词（用 --merge 时全部已有）。");
    return;
  }

  const apiKey = env.DEEPSEEK_API_KEY ?? "";
  const baseUrl = args.baseUrl || env.AI_BASE_DEEPSEEK || DEFAULT_BASE;
  const model = args.model || env.AI_MODEL_DEEPSEEK || DEFAULT_MODEL;

  // 占位 Key 一律 8 字符（项目里的约定），别拿它去打真接口白等
  if (!args.baseUrl && apiKey.trim().length <= 8) {
    console.error(
      `\n✗ DEEPSEEK_API_KEY 看起来是占位值（长度 ${apiKey.trim().length}），没有真 Key 就不发请求。\n` +
        `  想验管线可以加 --base-url http://127.0.0.1:8787 指向本地假模型。`,
    );
    process.exit(2);
  }

  console.log(`\n模型 ${model} · 地址 ${baseUrl} · 提示词 v${PROMPT_VERSION}`);
  const startedAt = new Date().toISOString();
  const items = { ...(args.merge ? existing.items : {}) };
  const rejected = [];
  const failed = [];
  let done = 0;

  async function worker(queue) {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const prompt = buildPrompt(job);
      try {
        const raw = await callModel({ baseUrl, apiKey, model, prompt });
        const check = checkMnemonic(raw);
        if (!check.ok) {
          rejected.push({ word_id: job.word_id, lemma: job.lemma, reason: check.reason, raw });
          console.log(`  ✗ ${job.lemma.padEnd(14)} 丢弃：${check.reason}`);
        } else {
          items[job.word_id] = {
            text: raw,
            kind: "association",
            generator: model,
            created_at: new Date().toISOString(),
          };
          console.log(`  ✓ ${job.lemma.padEnd(14)} ${raw}`);
        }
      } catch (e) {
        failed.push({ word_id: job.word_id, lemma: job.lemma, error: String(e?.message ?? e) });
        console.log(`  ! ${job.lemma.padEnd(14)} 失败：${e?.message ?? e}`);
      }
      done += 1;
      console.log(`    —— ${done}/${target.length}`);
    }
  }

  const queue = [...target];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)));

  // 按 word_id 排序，避免"两次跑出来的文件顺序不同"这种无意义 diff
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));

  const payload = {
    meta: {
      generated_at: startedAt,
      generator: model,
      prompt_version: PROMPT_VERSION,
      requested: target.length,
      count: Object.keys(sorted).length,
      rejected,
      failed,
      // 「好不好记」没有机器方法 —— 如实列出未覆盖项，别装作验过（验收口径 v2）
      uncovered_fields: ["助记质量（靠人工抽检）"],
    },
    items: sorted,
  };

  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `\n完成：收入 ${Object.keys(sorted).length} 条 · 丢弃 ${rejected.length} 条 · 失败 ${failed.length} 条`,
  );
  console.log(`→ ${outPath}`);
  if (failed.length > 0) process.exitCode = 1;
}

// 只有在直接执行时才跑主流程（被 import 时不跑，便于单测拿 buildPrompt / checkMnemonic）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
