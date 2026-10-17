/**
 * 记忆法抽屉 —— 专属联想（离线预生成）+ 通用建议（兜底）
 *
 * ── 一句话说清这一块的分工 ──────────────────────────────────
 *
 *   · **专属助记**（`lib/db/mnemonics.json`）：离线产出的静态文件，
 *     来源要么是脚本（`scripts/gen-mnemonics.mjs`，需要 Key），
 *     要么是人工逐条写（`scripts/apply-manual-mnemonics.mjs`，不需要 Key）。
 *     产品只读这份文件，两条来源产出的格式完全一致。
 *     只放「编出来的」东西 —— 联想、谐音、拆字、小故事。
 *   · **通用建议**（本文件）：与具体是哪个词无关的练习动作，因此永远不会编错。
 *
 * 没有专属助记的词，照旧给通用建议 —— **不留空、不硬凑**。
 *
 * ── 为什么坚决不碰词源（这条从阶段 0 起没变过）──────────────
 *
 * 「AI 边界」把"编出来的"和"查出来的"分得很清楚：
 *   - 助记句、故事 → 编出来的，可以交给 AI；
 *   - 词根、词源、音标、"考过几次" → 查出来的，绝不可以。
 * 一个"听起来很有道理"的假词源（比如把 island 说成 "is-land"）**比没有更糟** ——
 * 它会被记住，而且记错了几乎不会自己发现。
 *
 * 所以：生成脚本里有规则拦截「词源 / 词根 / 拉丁 / 希腊 / 源自…」，
 * 界面上一律标注「这是联想，不是词源」。用户知道自己在看什么，才不算被误导。
 *
 * ── 为什么运行时零 AI ────────────────────────────────────────
 *
 * 点一次调一次会：慢、贵、断网就没了、质量不稳定。四条里中任意一条都不该进主流程。
 * 所以是**离线生成一次，产品只读本地静态文件**（详见 `scripts/gen-mnemonics.mjs`）。
 */
import mnemonicsData from "@/lib/db/mnemonics.json";
import type { StudyCard, StudyMode } from "./types";

export interface MnemonicTip {
  title: string;
  lines: string[];
  /** 底部的诚实说明，界面上以小字呈现 */
  note: string;
  /**
   * `association` = 这个词专属的联想（离线生成）；
   * `generic` = 与词无关的通用练习建议。
   * 界面若要区分呈现方式（比如给专属助记加一点强调），看这个字段，别去猜文案。
   */
  kind: "association" | "generic";
}

/** 通用练习建议：按"问法"分，与具体是哪个词无关，所以永远是真的 */
const GENERIC_LINES: Record<StudyMode, string[]> = {
  recognize: [
    "先别看选项 —— 自己心里说一遍它是什么意思，再去找对应的那一条。",
    "四个选项里先排除明显不可能的，剩下两个再比一比差别在哪。",
    "选错了，就把你选的那条和正确的那条并排读两遍 —— 差别通常只在一个词上。",
  ],
  recall_spell: [
    "先按读音把它分成几段，一段一段写，别一口气抄。",
    "写完从头念一遍，看有没有漏字母 —— 漏字母是拼写错误里最常见的一种。",
    "只重写写错的那一段，不要把整个词抄十遍（抄十遍记住的是手，不是脑子）。",
  ],
};

/** 没有专属助记时的那段说明。措辞刻意保留「阶段」的由来，不装作这块早就有了 */
const GENERIC_NOTE =
  "这是通用的练习建议，不是这个词专属的助记。专属助记要靠联想，编得不合适反而添乱，所以我们只给确定不会错的那部分。";

/** 有专属助记时的说明 —— 这一句是「不冒充词源」的关键，别删 */
const ASSOCIATION_NOTE =
  "这是帮你记住这个词的联想，不是词源 —— 它没有语言学依据，好记就行、不好记就忽略。";

interface MnemonicEntry {
  text: string;
  kind: string;
  generator: string;
  created_at: string;
}

const TABLE: Record<string, MnemonicEntry> = (
  mnemonicsData as unknown as { items: Record<string, MnemonicEntry> }
).items;

/** 查这个词有没有专属助记。导出是为了让测试和界面都能单独问这一件事 */
export function associationFor(wordId: string): string | null {
  const entry = TABLE[wordId];
  const text = entry?.text?.trim();
  return text ? text : null;
}

/** 产物里一共有多少条可用助记（给"助记覆盖了多少词"这类展示用） */
export function associationCount(): number {
  return Object.values(TABLE).filter((e) => e?.text?.trim()).length;
}

export function mnemonicFor(card: StudyCard): MnemonicTip {
  const association = associationFor(card.word_id);
  if (association) {
    return {
      title: "这个词怎么记",
      lines: [association],
      note: ASSOCIATION_NOTE,
      kind: "association",
    };
  }
  return {
    title: card.mode === "recall_spell" ? "写不出来时怎么办" : "选不出来时怎么办",
    lines: GENERIC_LINES[card.mode],
    note: GENERIC_NOTE,
    kind: "generic",
  };
}

/**
 * 抽屉的展开按钮文案。
 * 单独一个函数是为了让"这东西存在"这件事在数据层面可见 ——
 * 界面上永远要有一个入口，而不是藏起来当它不存在（用户会以为这产品就是没有助记）。
 */
export const MNEMONIC_TRIGGER_LABEL = "记忆法 / 写不出来怎么办";
