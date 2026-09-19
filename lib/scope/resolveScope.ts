/**
 * resolveScope —— 从「范围描述」到「一批词」
 *
 * 铁律：**纯函数，不含 AI 调用，无副作用，可单测。**
 * 词的唯一来源是数据查询结果，绝不接受模型编出来的词表。
 *
 * 阶段 0 的实现边界：
 *   - 只实现 include type = curriculum_unit
 *   - 排序 = 单元序 → 词典序（确定性、可单测）。
 *     教材原始词表顺序需要 placement 上有排序字段，阶段 1 与真实数据一起加，本阶段不发明字段。
 *   - core_only 会被明确拒绝（is_core 未知，不能假装能筛）
 */
import type { ScopeJson } from "./schema";
import { SCOPE_INCLUDE_TYPES_IMPLEMENTED } from "./schema";
import type { Sense, Unit, Word, WordPlacement } from "@/lib/db/types";

/** 数据快照：函数只读它，不碰数据库 —— 这是"可单测"的前提 */
export interface WordSnapshot {
  units: Unit[];
  words: Word[];
  senses: Sense[];
  placements: WordPlacement[];
}

export interface WordRef {
  word_id: string;
  lemma: string;
  phonetic_uk: string | null;
  sense_id: string | null;
  sense_pos: string | null;
  meaning_zh: string | null;
  unit_id: string;
  unit_code: string;
  role: WordPlacement["role"];
  confidence: number;
}

export type ResolveErrorCode =
  | "UNSUPPORTED_SCOPE_TYPE"
  | "SCOPE_TARGET_NOT_FOUND"
  | "UNSUPPORTED_FILTER"
  | "EMPTY_RESULT";

export type ResolveResult =
  | { ok: true; words: WordRef[]; confidence: number }
  | { ok: false; code: ResolveErrorCode; message: string; details?: string[] };

export function resolveScope(scope: ScopeJson, snapshot: WordSnapshot): ResolveResult {
  const { units, words, senses, placements } = snapshot;

  const unitById = new Map(units.map((u) => [u.id, u]));
  const wordById = new Map(words.map((w) => [w.id, w]));
  const primarySenseByWord = new Map<string, Sense>();
  for (const s of senses) {
    if (s.is_primary) primarySenseByWord.set(s.word_id, s);
  }
  const collected: WordRef[] = [];
  const missingTargets: string[] = [];
  let minConfidence = 1;

  for (const item of scope.include) {
    if (!(SCOPE_INCLUDE_TYPES_IMPLEMENTED as readonly string[]).includes(item.type)) {
      return {
        ok: false,
        code: "UNSUPPORTED_SCOPE_TYPE",
        message: `阶段 0 尚未实现 include 类型「${item.type}」。当前只支持：${SCOPE_INCLUDE_TYPES_IMPLEMENTED.join("、")}`,
      };
    }

    if (item.core_only === true) {
      return {
        ok: false,
        code: "UNSUPPORTED_FILTER",
        message: "阶段 0 无法按「仅核心词」筛选：样张数据的 is_core 未知（不做假装能筛的筛选器）",
      };
    }

    const wantedUnitIds = item.units ?? [];
    if (wantedUnitIds.length === 0) {
      return {
        ok: false,
        code: "UNSUPPORTED_FILTER",
        message: "curriculum_unit 必须指定 units（单元级范围）",
      };
    }

    for (const unitId of wantedUnitIds) {
      const unit = unitById.get(unitId);
      if (!unit) {
        missingTargets.push(unitId);
        continue;
      }

      const rows = placements
        .filter((p) => p.unit_id === unitId)
        .filter((p) => (item.roles ? item.roles.includes(p.role) : true))
        .map((p) => {
          const word = wordById.get(p.word_id);
          if (!word) return null;
          const sense = primarySenseByWord.get(p.word_id) ?? null;
          if (p.confidence < minConfidence) minConfidence = p.confidence;
          const ref: WordRef = {
            word_id: p.word_id,
            lemma: word.lemma,
            phonetic_uk: word.phonetic_uk,
            sense_id: p.sense_id ?? sense?.id ?? null,
            sense_pos: sense?.pos ?? null,
            meaning_zh: sense?.cn_meaning ?? null,
            unit_id: p.unit_id,
            unit_code: unit.unit_code,
            role: p.role,
            confidence: p.confidence,
          };
          return ref;
        })
        .filter((r): r is WordRef => r !== null);

      collected.push(...rows);
    }
  }

  // 范围不存在 ≠ 范围内没有词：两者必须能区分（硬约束：不接受静默失败）
  if (missingTargets.length > 0) {
    return {
      ok: false,
      code: "SCOPE_TARGET_NOT_FOUND",
      message: "范围里有不存在的单元，未做静默降级",
      details: missingTargets,
    };
  }
  if (collected.length === 0) {
    return { ok: false, code: "EMPTY_RESULT", message: "该范围内没有词" };
  }

  // 去重：同一词在多单元出现时保留先出现的那条（阶段 0 不做义项收敛，见 §7.1 步骤 3）
  const deduped = new Map<string, WordRef>();
  for (const r of collected) {
    if (!deduped.has(r.word_id)) deduped.set(r.word_id, r);
  }

  const ordered = [...deduped.values()].sort((a, b) => {
    const unitA = unitById.get(a.unit_id)?.unit_no ?? 0;
    const unitB = unitById.get(b.unit_id)?.unit_no ?? 0;
    if (unitA !== unitB) return unitA - unitB;
    return a.lemma.toLowerCase().localeCompare(b.lemma.toLowerCase());
  });

  const limited = scope.limit ? ordered.slice(0, scope.limit) : ordered;

  return { ok: true, words: limited, confidence: minConfidence };
}
