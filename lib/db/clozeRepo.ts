/**
 * 完形填空的本地缓存 —— 唯一一层碰 `cloze_sets` 的代码
 *
 * 与 `studyRepo` 同思路：页面只认这里暴露的函数，阶段 1 真要搬到云端公共池时
 * 只换这一层的实现（表结构已经是能直接上云的样子）。
 *
 * ── 三件事刻意做在这里，而不是交给调用方 ─────────────────────
 * ① **读的时候校验内容指纹**。词库更新过之后，旧题可能考着已经删掉的词。
 *    让调用方自己比指纹 = 总有一个调用方会忘。
 * ② **读的时候跑一遍结构检查**。缓存是几天前写的代码写进去的，
 *    而审核规则可能已经变严（比如现在要求答案下标必须是整数）。
 *    一条越界的数据会让界面在 `options[answer]` 处拿到 `undefined` ——
 *    结构一坏就**当场删掉重出**，这是最省事也最可靠的处置。
 *    词汇检查（挖空词在不在单元词表里）不再跑：指纹一致就说明词表没变，
 *    而生成那一刻已经审过了。多跑一遍只是多一次遍历，换不来新信息。
 * ③ **兜底题不存**。见 `saveCloze`。
 */
import { seedBundle } from "./seed";
import { checkClozeStructure, type ClozeBlank } from "@/lib/study/cloze";
import { getActiveUserId } from "./identity";
import { clozeIdFor } from "./ids";
import { db } from "./local";
import type { ClozeSet } from "./types";

/** 当前的词库内容指纹。缓存与它不一致就视为失效 */
function currentContentVersion(): string {
  return seedBundle.meta.content_version;
}

/**
 * 取这个单元缓存的题。没有 / 失效 / 结构坏了都返回 `null`。
 *
 * 返回 `null` 的含义统一是"得重新出一套"，调用方不需要区分是哪一种 ——
 * 三种情况该做的事完全一样。需要知道原因时看日志（下面两处都有 `console.warn`）。
 */
export async function findCachedCloze(unitId: string): Promise<ClozeSet | null> {
  const userId = getActiveUserId();
  const row = await db.cloze_sets.get(clozeIdFor(unitId, userId));
  if (!row) return null;

  // ① 词库变过 → 这套题考的词可能已经不在词库里了，不能再给用户做
  if (row.content_version !== currentContentVersion()) {
    await db.cloze_sets.delete(row.id);
    return null;
  }

  // ② 结构坏了 → 当场删掉。留着它只会让界面在渲染时空指针
  const structure = checkClozeStructure({
    title: row.title,
    passage: row.passage,
    blanks: row.blanks,
  });
  if (!structure.ok) {
    console.warn(
      JSON.stringify({
        scope: "cloze",
        event: "cache_structure_broken",
        unit_id: unitId,
        issues: structure.issues,
        notes: structure.notes,
      }),
    );
    await db.cloze_sets.delete(row.id);
    return null;
  }

  return row;
}

export interface SaveClozeInput {
  unitId: string;
  /** 人话的单元名。服务端随响应带回来，存一份快照 */
  unitLabel: string;
  title: string;
  passage: string;
  blanks: ClozeBlank[];
  /** 这套题是怎么来的。**只有 `"ai"` 会被存下来** */
  source: "ai" | "template";
  model: string | null;
  now: Date;
}

/**
 * 存一套题（覆盖同单元旧的那套）。
 *
 * ── 为什么 `source !== "ai"` 直接返回 null、什么都不存 ───────────
 * 兜底题是那篇写死的、跟用户单元无关的通用短文。
 * 如果把它缓存下来，会有两个后果，而且**都不会报错**：
 *   · 用户下次打开这个单元，看到的还是这篇通用短文 —— 他会以为这就是自己的题；
 *   · 缓存命中的判定在那之后永远成立，于是**再也不会有"下次重试"** ——
 *     明明 AI 只是当时抖了一下，却被我们永久固化成"这个单元只有这篇通用题"。
 * 所以：兜底只在**这一次**给用户用，不落盘。
 */
export async function saveCloze(input: SaveClozeInput): Promise<ClozeSet | null> {
  if (input.source !== "ai") return null;

  const userId = getActiveUserId();
  const row: ClozeSet = {
    id: clozeIdFor(input.unitId, userId),
    user_id: userId,
    unit_id: input.unitId,
    unit_label: input.unitLabel,
    title: input.title,
    passage: input.passage,
    blanks: input.blanks,
    source: input.source,
    model: input.model,
    content_version: currentContentVersion(),
    created_at: input.now.toISOString(),
  };

  await db.cloze_sets.put(row);
  return row;
}

/**
 * 删掉这个单元的缓存（"换一套"时用）。
 *
 * 单独一个函数而不是让页面直接 `db.cloze_sets.delete(...)`：
 * 页面上算 id 就得知道 `clozeIdFor` 的规则，而规则只该住在 `ids.ts` 一处。
 */
export async function dropCachedCloze(unitId: string): Promise<void> {
  await db.cloze_sets.delete(clozeIdFor(unitId, getActiveUserId()));
}
