/**
 * scope_json 校验（zod）
 *
 * 它是「用户能理解的范围描述」的序列化形式，特性：可校验、可展示、可编辑、可保存。
 *
 * 阶段 0 的边界：
 *   - schema 接受上游定义的全部 include 类型（白名单），**但 resolveScope 只实现 curriculum_unit 一种**；
 *     其余类型会返回明确的 UNSUPPORTED_SCOPE_TYPE 错误，而不是静默返回空集。
 *   - 不允许 include 为空而 exclude 非空（那等于"从全库减去一点"，会把整个词库导进来）。
 */
import { z } from "zod";

import type { Unit, Volume } from "@/lib/db/types";

/** 上游 词库方案 §6.2 定义的 include 类型全集 */
export const SCOPE_INCLUDE_TYPES = [
  "curriculum_unit",
  "curriculum_volume",
  "exam_syllabus",
  "exam_freq",
  "theme",
  "relation",
  "wrong_book",
  "mastery_band",
  "manual_list",
  "saved_set",
] as const;

/** 阶段 0 真正实现了的类型（其余为"契约已定义、实现待补"） */
export const SCOPE_INCLUDE_TYPES_IMPLEMENTED = ["curriculum_unit"] as const;

export const LIMITS = {
  limit: 200,
  daily_cap: 50,
} as const;

const includeItem = z.strictObject({
  type: z.enum(SCOPE_INCLUDE_TYPES),
  curriculum: z.string().min(1).optional(),
  volume: z.string().min(1).optional(),
  units: z.array(z.string().min(1)).optional(),
  roles: z.array(z.enum(["new", "review", "extension"])).optional(),
  core_only: z.boolean().optional(),
  include_phrases: z.boolean().optional(),
  themes: z.array(z.string()).optional(),
  exam: z.string().optional(),
  bands: z.array(z.string()).optional(),
  min_count: z.number().int().nonnegative().optional(),
  word_id: z.string().optional(),
  relation_types: z.array(z.string()).optional(),
  words: z.array(z.string()).optional(),
  set_ids: z.array(z.string()).optional(),
  field: z.string().optional(),
  op: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional(),
});

const excludeItem = z.strictObject({
  type: z.enum(["mastery", "manual_remove", "dedupe"]),
  field: z.string().optional(),
  op: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional(),
  words: z.array(z.string()).optional(),
});

const boostItem = z.strictObject({
  type: z.enum(["wrong_book", "exam_freq", "manual"]),
  weight: z.number().positive(),
  exam: z.string().optional(),
  words: z.array(z.string()).optional(),
});

export const scopeJsonSchema = z
  .strictObject({
    v: z.literal(1),
    label: z.string().optional(),
    include: z.array(includeItem).min(1),
    exclude: z.array(excludeItem).optional(),
    boost: z.array(boostItem).optional(),
    order: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(LIMITS.limit).optional(),
    daily_cap: z.number().int().positive().max(LIMITS.daily_cap).optional(),
    new_review_ratio: z.number().min(0).max(1).optional(),
  })
  .refine((s) => !(s.include.length === 0 && (s.exclude?.length ?? 0) > 0), {
    message: "禁止 include 为空但 exclude 非空（会把全库导出来）",
  });

export type ScopeJson = z.infer<typeof scopeJsonSchema>;

/** 校验结果：不抛异常，返回结构化结果（调用方必须处理失败分支） */
export type ValidateResult =
  | { ok: true; scope: ScopeJson }
  | { ok: false; code: "INVALID_SCOPE"; issues: string[] };

export function validateScope(input: unknown): ValidateResult {
  const parsed = scopeJsonSchema.safeParse(input);
  if (parsed.success) return { ok: true, scope: parsed.data };

  return {
    ok: false,
    code: "INVALID_SCOPE",
    issues: parsed.error.issues.map((i) => {
      const path = i.path.length ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    }),
  };
}

/**
 * 冷启动用的默认范围。
 *
 * 2026-10-01 改：样张（人教版八上）换成**外研社八上**（产品里真正在用的那本）。
 * id 必须与 `scripts/build-seed.mjs` 生成的 `lib/db/seed-data.json` 里的
 * `meta.curriculum_code` / `meta.volume_id` / `meta.default_unit_id` 一致 ——
 * 这三处**只能由种子脚本产生**，这里的字面量是它的镜像，改数据源时要一起改。
 *
 * 等「选我的课本 / 选我的单元」做出来之后，这个函数就退化成"新用户的第一本书"，
 * 不再是唯一的范围来源。
 */
export function defaultScope(): ScopeJson {
  return {
    v: 1,
    label: "八上 Unit 1 · This is me",
    include: [
      {
        type: "curriculum_unit",
        curriculum: "wys_2024",
        volume: "wys_2024:8A",
        units: ["wys_2024:8A:U1"],
      },
    ],
    daily_cap: 20,
  };
}

/** 年级的中文数字。下标 = grade_num（1 年级 → "一"） */
const GRADE_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * 教材简称：`{grade_num: 8, term: "上"}` → 「八上」。
 * 课本封面、目录页用的都是这个叫法，用户也是照着它找的。
 */
export function shortVolumeLabel(volume: Pick<Volume, "grade_num" | "term">): string {
  const grade = GRADE_CN[volume.grade_num] ?? String(volume.grade_num);
  return `${grade}${volume.term}`;
}

/**
 * 单元的显示名：`八上 Unit 1 · This is me`。
 *
 * **唯一一处** —— 首页那一行、选择面板里的每一行、任务单的"起点"全用它，
 * 这样三个地方说的单元名绝不会长得不一样。
 * 带上教材里的英文标题是刻意的：用户手上翻的是课本目录，
 * 目录上印的就是 "Unit 1 This is me"，只写"Unit 1"他会对不上号。
 */
export function unitDisplayLabel(
  volume: Pick<Volume, "grade_num" | "term">,
  unit: Pick<Unit, "unit_code" | "title_en">,
): string {
  const head = `${shortVolumeLabel(volume)} ${unit.unit_code}`;
  return unit.title_en ? `${head} · ${unit.title_en}` : head;
}

/**
 * 从一条单元记录生成范围描述 —— **「选我的单元」的唯一入口**。
 *
 * 与 `defaultScope()` 一样，这里的课程 / 册次 id 都取自传入的记录本身
 * （不是写死的字面量），所以换教材 / 换册次时不用改这里。
 * `daily_cap` 沿用阶段 0 的 20，与默认范围保持一致 —— 换单元不该顺带改每日量。
 */
export function scopeForUnit(volume: Volume, unit: Unit): ScopeJson {
  return {
    v: 1,
    label: unitDisplayLabel(volume, unit),
    include: [
      {
        type: "curriculum_unit",
        curriculum: volume.curriculum_id,
        volume: volume.id,
        units: [unit.id],
      },
    ],
    daily_cap: defaultScope().daily_cap,
  };
}

