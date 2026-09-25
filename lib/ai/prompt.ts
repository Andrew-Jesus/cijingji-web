/**
 * 提示词拼装 —— 纯函数，无 IO，可单测
 *
 * ── 这个文件唯一的设计重点：**不变的部分在前，变的部分在后** ──────────
 * 缓存是按"请求前缀"命中的（DeepSeek 自动做，不需要任何额外参数）。
 * 所以只要把「角色 + 输出格式 + 固定约束」整段放进 **system 消息**，
 * 并且让它在所有请求里**逐字一致**，这一大段就会被缓存住，
 * 输入价从 ¥1.5/百万 掉到 ¥0.05/百万（**30 倍**）。
 *
 * 反过来说：**只要往 system 里塞一个随请求变化的东西（哪怕是今天的日期），
 * 缓存就永远不命中**，而这个损失在账单上看得见、在界面上看不见 ——
 * 所以单测专门钉住"换一个词/换一个兴趣域，system 必须逐字相同"。
 *
 * ── 为什么词的事实要单独列出来 ────────────────────────────────
 * 「AI 边界」这条产品规矩：**查出来的东西不许 AI 编**。
 * 词头、音标、词性、中文义项全部由服务端从种子数据查出后**原样注入**，
 * AI 只负责"把已知事实写进他感兴趣的场景"。所以提示词里给的是事实，
 * 而不是让模型"回忆"这个词是什么意思 —— 后者一定会编。
 */
import { GENERIC_INTEREST_LABEL, resolveInterest } from "@/lib/onboarding/questions";
import type { AiTaskId } from "./config";

/** 服务端查出来的单词事实。**这是 ground truth，模型只能用它、不能改它** */
export interface WordFacts {
  lemma: string;
  phonetic: string | null;
  pos: string | null;
  meaning_zh: string;
}

export interface PromptParts {
  /** 稳定前缀（放 system 消息）。**必须与具体单词、兴趣无关** */
  fixed: string;
  /** 变量部分（放 user 消息） */
  variable: string;
}

export interface PromptInput {
  facts: WordFacts;
  interestTag: string;
}

export interface TaskSpec {
  id: AiTaskId;
  /** 逐字稳定的 system 提示词 */
  system: string;
  buildVariable: (input: PromptInput) => string;
}

/**
 * 固定约束。改这里要意识到一件事：**改了就等于让缓存全部失效一次**
 * （前缀变了，旧缓存对不上新前缀）。所以别为了措辞好看频繁改。
 */
const EXAMPLE_SYSTEM = [
  "你是给中国初中生做英语单词记忆的助手。",
  "你的任务：把一个已经给定的英语单词，写进一句和他感兴趣的话题有关的英文短句里。",
  "",
  "你会收到：话题、单词、音标、词性、词义。这些信息都是**已经确认过的事实**，你不要去质疑、不要改写、不要补充。",
  "",
  "必须遵守：",
  "1. 只输出 JSON，不要任何解释、不要 markdown 代码块、不要多余字符。",
  "2. JSON 结构固定为：{\"sentence\": \"<英文句子>\", \"gloss\": \"<中文大意>\"}",
  "3. sentence：一句英文，6~16 个词，语法正确，必须用上给定的那个单词。",
  "4. 单词可以用常见词形变化（如 -s / -ed / -ing / -er），但要一眼认得出是它。",
  "5. gloss：sentence 的中文大意，不超过 30 个字，不逐词直译。",
  "6. 全句用词控制在初中水平。宁可句子简单，也不要出现生僻词。",
  "7. 句子内容要围绕给的话题展开，读起来像真会碰到的场景，不要生硬地把话题词塞进去。",
  "8. 不要出现具体人名、品牌名、日期、比分、分数、名次、金额；不要编造任何事实。",
  "9. 不要用 emoji、颜文字、连续感叹号。",
  "10. 不要写“XX 的意思是……”“这个词表示……”这类讲解句，只写正常的一句话。",
].join("\n");

function buildExampleVariable({ facts, interestTag }: PromptInput): string {
  // 中英两个名字**必须成对取**（见 `resolveInterest` 的注释）：
  // 各调一个函数会在"认不出的 tag"上得出互相打架的两个名字 ——
  // 模型接到「英文 everyday life（中文 篮球）」这种自相矛盾的输入，写出来的句子也跟着拧巴。
  // 两个都给的原因：英文名让它直接用，中文名防止标签是多义词时理解偏。
  const { labelEn, label } = resolveInterest(interestTag);

  return [
    `话题：${labelEn}（${label}）`,
    `单词：${facts.lemma}`,
    `音标：${facts.phonetic ?? "（未收录，不必在句子里体现音标）"}`,
    `词性：${facts.pos ?? "（未收录）"}`,
    `词义：${facts.meaning_zh}`,
  ].join("\n");
}

export const TASK_SPECS: Record<AiTaskId, TaskSpec> = {
  example_personalized: {
    id: "example_personalized",
    system: EXAMPLE_SYSTEM,
    buildVariable: buildExampleVariable,
  },
};

export function buildPrompt(task: AiTaskId, input: PromptInput): PromptParts {
  const spec = TASK_SPECS[task];
  return { fixed: spec.system, variable: spec.buildVariable(input) };
}

/**
 * 提示词里"固定前缀"的字数 —— 开发者模式拿它佐证"该缓存的都缓存了"。
 * 只是诊断用，不参与任何业务判断。
 */
export function fixedPrefixLength(task: AiTaskId): number {
  return TASK_SPECS[task].system.length;
}

/**
 * 这句话是不是"没有个性"的（落到了日常话题）——
 * 界面据此如实说明，而不是假装这是按他的兴趣写的例句。
 *
 * 判据走 `resolveInterest().personalized`，而不是"等不等于 general"：
 * 传进来一个认不出的 tag 时（老数据里已下线的 tag、或前端漏传），
 * 实际效果同样是通用话题，界面就该照实说。
 */
export function isGenericInterest(interestTag: string): boolean {
  return !resolveInterest(interestTag).personalized;
}

export { GENERIC_INTEREST_LABEL };
