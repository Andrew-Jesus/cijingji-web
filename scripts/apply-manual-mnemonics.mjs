#!/usr/bin/env node
/**
 * 手工助记入库（30 条试点）—— 运行时零 AI，产物与脚本生成**同构**
 *
 * ── 这份文件解决什么问题 ──────────────────────────────────────
 *
 * `gen-mnemonics.mjs` 需要真 Key 才能跑。在没 Key 的时候，产品不该被卡住：
 * 助记本来是「编出来的」那一类，手写同样合规，而且**更好把关**（人写的时候
 * 知道哪个词对初中生真的难、哪种联想真的站得住）。
 *
 * 所以这里放 30 条逐条写好的助记，格式与 `gen-mnemonics.mjs` 产物完全一致 ——
 * 消费端（`lib/study/mnemonic.ts`）根本不关心是谁写的。
 *
 * ── 手工版比 AI 版严格的三条 ──────────────────────────────────
 *
 *   1. **每一条都过 `checkMnemonic`**：词源断言、不雅内容、像通用建议的，一律不收。
 *      手写更容易「顺手写出词源」，所以这道闸门对人工产物比对模型产物更重要。
 *   2. **不许只解释词义**：只把中文意思说一遍等于没助记（那是释义，界面已经给了）。
 *   3. **拿不准就换一个角度**，绝不硬凑 —— 宁可这个词回落通用建议。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *
 *   node scripts/apply-manual-mnemonics.mjs            # 写 lib/db/mnemonics.json
 *   node scripts/apply-manual-mnemonics.mjs --dry-run  # 只校验，不写文件
 *
 * ⚠️ 跑 `gen-mnemonics.mjs` **不带 `--merge`** 会把这份文件整体覆盖。
 *    真要扩量就用 `--merge`，它会保留这里的条目、只补缺的。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROMPT_VERSION, checkMnemonic } from "./gen-mnemonics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** 产物里记下"谁写的"。界面不显示，但出事时要能一眼分清手工条目和模型条目 */
export const MANUAL_GENERATOR = "manual:editor";

/**
 * 30 条手工助记。
 *
 * 选词由 `gen-mnemonics.mjs --dry-run` 给出（跨 18 个单元轮转 + 哈希打散），
 * 所以这 30 个词**不是按字母序挑的**，试点才有代表性。
 *
 * 写作时逐条守的口径：
 *   · 只许联想 / 谐音 / 拆字 / 小故事；
 *   · 不许提词源、词根、来自哪种语言；
 *   · 一句话，不换行，不加引号。
 */
export const MANUAL_ENTRIES = [
  { word_id: "w:birthmark", lemma: "birthmark", text: "birth（出生）+ mark（记号）：一出生就带着的记号，就是胎记。" },
  { word_id: "w:narrow", lemma: "narrow", text: "中间藏着 arrow（箭）：箭杆又细又长，挤得过去的只有窄缝。" },
  { word_id: "w:future", lemma: "future", text: "十年后的自己站在门口等你 —— 那段时间就是 future（未来）。" },
  { word_id: "w:progress", lemma: "progress", text: "每背会一个词，进度条就往前挪一格：那一点点挪动，就是进步。" },
  { word_id: "w:clear your throat", lemma: "clear your throat", text: "clear（清空）+ throat（喉咙）：把喉咙清一清，就是清清嗓子。" },
  { word_id: "w:smoke", lemma: "smoke", text: "s + moke 念着像「冒咳」：烟一冒出来，人就咳。" },
  // 「领头的船」这条本来想用 ship（船）拆字，但那会让人以为 leadership 跟船有关
  // （-ship 是后缀，不是"船"）。拆字拆错了比不拆更糟，所以改成纯画面。
  { word_id: "w:leadership", lemma: "leadership", text: "想成一个班正在远航，站在船头指方向的那位 —— 那份本事就是领导才能。" },
  { word_id: "w:policewoman", lemma: "policewoman", text: "police（警察）后面跟着 woman（女人）：女警察。" },
  { word_id: "w:north", lemma: "north", text: "念着像「诺斯」：听着就是个北欧名字，北欧在最北边。" },
  { word_id: "w:public", lemma: "public", text: "pub（酒馆）里说的话传得最快 —— 一转眼就成了公开的。" },
  { word_id: "w:method", lemma: "method", text: "拆成 me + thod：每一步（me）都有一条道（thod）可走，那就是方法。" },
  { word_id: "w:wheat", lemma: "wheat", text: "w + heat（热）：天越热长得越欢的庄稼，就是小麦。" },
  { word_id: "w:blood", lemma: "blood", text: "中间那两个 o 就当两滴血：b-l-oo-d，两滴连着一块儿往下掉。" },
  { word_id: "w:chain", lemma: "chain", text: "想成一节扣一节的铁环：c 扣 h、a 扣 i，串起来就是链子。" },
  { word_id: "w:mystery", lemma: "mystery", text: "拆成 my + story：我的故事还没讲完，所以还是个谜。" },
  { word_id: "w:person", lemma: "person", text: "中间藏着 son（孩子）：再小的孩子，也是一个完整的人。" },
  { word_id: "w:mark", lemma: "mark", text: "念作「马克」：马克笔在纸上划一道，留下一道痕迹。" },
  { word_id: "w:reporter", lemma: "reporter", text: "report（报道）后头跟着 er（人）：负责报道的人，就是记者。" },
  { word_id: "w:height", lemma: "height", text: "eight（八）前面加个 h：八英尺那么高 —— 就是高度。" },
  { word_id: "w:double", lemma: "double", text: "两个 o 并排摆着，像两个 0 加起来 —— 双倍、两倍的。" },
  { word_id: "w:lend (sb) a hand", lemma: "lend (sb) a hand", text: "把手 lend（借）出去：借一只手给人用，就是搭把手。" },
  { word_id: "w:except", lemma: "except", text: "和 accept 只差第一个字母：a 是收下，e 是除外，别搞反。" },
  // 「老祖宗传下来的」有暗示来源的嫌疑（我们不许碰来源），改成只说规矩本身
  { word_id: "w:law", lemma: "law", text: "念起来像「老」：老规矩一条条写在那儿，谁都不能破 —— 那便是法则。" },
  { word_id: "w:scared", lemma: "scared", text: "scar（伤疤）后面加 ed：身上留着伤疤的人，都是被吓过的。" },
  { word_id: "w:beyond", lemma: "beyond", text: "想成远处的山：山的这一边是这里，山的那一边就是更远处。" },
  { word_id: "w:tonight", lemma: "tonight", text: "to（到）+ night（夜）：一直到今夜，就是今晚。" },
  { word_id: "w:strength", lemma: "strength", text: "strong（强壮）换个样子就是它：一个人最强的那一块，就是长处。" },
  { word_id: "w:virus", lemma: "virus", text: "开头的 v 想成一支针头：扎进去，就带进来一个病毒。" },
  { word_id: "w:board", lemma: "board", text: "一块木板（board）钉在墙上，上面贴满通知 —— 就是公告牌。" },
  { word_id: "w:probably", lemma: "probably", text: "说这个词时人常会耸耸肩：不敢打包票，只能说很可能。" },
];

/** 超过这个字数就不再是"一句话助记"，而是一段解释 —— 界面上会挤成一坨 */
const MAX_LEN = 60;

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const seedPath = join(ROOT, "lib", "db", "seed-data.json");
  if (!existsSync(seedPath)) {
    console.error(`✗ 找不到词库：${seedPath}`);
    process.exit(1);
  }
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const knownIds = new Set(seed.words.map((w) => w.id));

  const items = {};
  const rejected = [];

  for (const e of MANUAL_ENTRIES) {
    // ① word_id 必须真在词库里 —— 拼错一个字母，这条助记就永远不会被查到，
    //    而且**不会报错**（查表未命中 → 静默回落通用建议）。所以在这里拦住。
    if (!knownIds.has(e.word_id)) {
      rejected.push({ word_id: e.word_id, lemma: e.lemma, reason: "词库里没有这个 word_id" });
      continue;
    }
    const text = String(e.text ?? "").trim();
    // ② 与模型产物同一道闸门：词源断言 / 不雅 / 像通用建议 / 空 / 多行
    const check = checkMnemonic(text);
    if (!check.ok) {
      rejected.push({ word_id: e.word_id, lemma: e.lemma, reason: check.reason, raw: text });
      continue;
    }
    if (text.length > MAX_LEN) {
      rejected.push({
        word_id: e.word_id,
        lemma: e.lemma,
        reason: `太长（${text.length} 字，上限 ${MAX_LEN}）`,
        raw: text,
      });
      continue;
    }
    items[e.word_id] = {
      text,
      kind: "association",
      generator: MANUAL_GENERATOR,
      created_at: new Date().toISOString(),
    };
  }

  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));

  const payload = {
    meta: {
      generated_at: new Date().toISOString(),
      // 诚实记录来源：这是人写的，不是模型生成的。别让后来的人以为跑过 AI
      generator: MANUAL_GENERATOR,
      prompt_version: PROMPT_VERSION,
      requested: MANUAL_ENTRIES.length,
      count: Object.keys(sorted).length,
      rejected,
      failed: [],
      // 「好不好记」没有机器方法 —— 如实列出未覆盖项（验收口径 v2）
      uncovered_fields: ["助记质量（靠人工抽检）"],
    },
    items: sorted,
  };

  console.log(`候选 ${MANUAL_ENTRIES.length} 条 · 收下 ${Object.keys(sorted).length} 条 · 退回 ${rejected.length} 条`);
  for (const r of rejected) console.log(`  ✗ ${String(r.lemma).padEnd(16)} ${r.reason}`);

  if (dryRun) {
    console.log("\n--dry-run：只校验，不写文件。");
    if (rejected.length > 0) process.exitCode = 1;
    return;
  }

  const outPath = join(ROOT, "lib", "db", "mnemonics.json");
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`→ ${outPath}`);

  // 有退回的条目就不算"全清"：退出码 1 让闸门看得见，但文件照样写（部分可用好过全无）
  if (rejected.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
