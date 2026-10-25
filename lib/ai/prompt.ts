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

/** 例句任务的输入 */
export interface ExamplePromptInput {
  facts: WordFacts;
  interestTag: string;
}

/**
 * 完形填空要用的一个词。
 *
 * 除了解析出来要用的 `lemma` / `meaning_zh`，还带着 `word_id` 与 `lemma_normalized`：
 * 前者是判分回流时写 `review_logs` 的锚，后者是三道审核里"这个词在不在本单元"的比对口径。
 * 三样都从同一个地方（`groundTruth.lookupUnitVocabulary`）来，**不在这里重新查一遍**——
 * 两处各查一遍，早晚会出现"提示词里给了 51 个词、审核只认 49 个"这种没头没尾的失败。
 */
export interface ClozeWordFacts {
  /** 词库 id，如 `w:suppose` */
  word_id: string;
  lemma: string;
  /** 归一形（小写、去连字符）。**审核认它，不认 `lemma`** */
  lemma_normalized: string;
  meaning_zh: string;
}

/** 完形填空任务的输入 */
export interface ClozePromptInput {
  /** 人话的单元名，如「外研社版 八年级上册 Unit 1 This is me」 */
  unitLabel: string;
  /** 这个单元的词汇表。**挖空只能从这里取** */
  words: readonly ClozeWordFacts[];
}

/**
 * 任务 → 它需要的输入类型。
 *
 * 用条件类型而不是让两个任务共用一个宽对象：共用会导致
 * `buildClozeVariable` 里不得不写 `data.facts!` 这种断言，
 * 而一旦有人传错，运行时拿到 `undefined` 才崩 —— 那时已经在提示词里了。
 */
type PromptInputFor<T extends AiTaskId> = T extends "cloze_generate"
  ? ClozePromptInput
  : ExamplePromptInput;

export interface TaskSpec<T extends AiTaskId> {
  id: T;
  /** 逐字稳定的 system 提示词 */
  system: string;
  buildVariable: (data: PromptInputFor<T>) => string;
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

function buildExampleVariable({ facts, interestTag }: ExamplePromptInput): string {
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

/**
 * 完形填空的固定前缀。
 *
 * ⚠️ **改这段就让缓存全部失效一次**（前缀变了），所以别为了措辞好看频繁改。
 * ⚠️ **任何"随单元变化"的东西都不许进这里**（单元名、词表都在 user 消息里）——
 * 一旦混进来，每个单元都是新前缀，缓存命中率归零，而且界面上看不出来。
 *
 * ── 三条最容易被忽略、但决定题目能不能用的约束 ─────────────────
 *   · **四个选项必须是"同一词性的不同词"，不能是同一个词的不同形式**。
 *     这条如果不说，模型极爱给 `go / went / going / goes` —— 那变成了纯语法题，
 *     而我们要的是"在语境里认出这个词"，是词汇复习。用户做十个空只在练时态，
 *     跟本单元的单词一个都没关系。
 *   · **挖空处必须能靠上下文唯一确定答案**。这条不说，模型会在完全没有线索的地方
 *     挖空，于是四个选项"都说得通"，判分变成猜运气 —— 而答错会真的写进复习安排。
 *   · **`word` 写词表里的原形**。它是回流到复习安排的锚：写形变（joined）就对不上
 *     词库的 `join`，于是那次答错记到一个不存在的词上。
 */
const CLOZE_SYSTEM = [
  "你是给中国初中生出英语完形填空题的助手。",
  "",
  "你会收到：教材单元名、这个单元的词汇表（英文原形 + 课本给的中文意思）。这些词都是**已经确认过的事实**，你只能使用它们，不要改写、不要替换、不要自己加词。",
  "",
  "你的任务：写一篇英语短文，并在其中挖 10 个空，每空配 4 个选项。",
  "",
  "必须遵守：",
  "1. 只输出 JSON，不要任何解释、不要 markdown 代码块、不要多余字符。",
  '2. JSON 结构固定为：{"title": "<中文标题>", "passage": "<英文短文>", "blanks": [{"no": 1, "options": ["", "", "", ""], "answer": 0, "word": ""}]}',
  "3. blanks 必须正好 10 个，no 从 1 到 10 各出现一次。",
  "4. 每空 options 必须正好 4 个、互不相同、都是英语，且**四个必须是同一词性的不同词**。绝对不要给成同一个词的不同形式（比如 go / went / going / goes）—— 那是语法题，不是词汇题。",
  "5. answer 是正确选项在 options 里的下标，从 0 开始（0~3）。",
  "6. 每空考的词必须来自我给的那个词汇表。word 字段填它在词汇表里的**原形**（比如词汇表里是 join，就不要填 joined）。挑词时优先选有实际意思的词（名词、动词、形容词、副词），不要挑 the / of / very 这种只起连接作用的功能词。",
  "7. passage 里挖空的地方写成 {{1}} 到 {{10}}，每个编号只出现一次，并且按从上到下的顺序编号。",
  "8. 短文要求：大约 160~180 个英文词；初中水平的词汇和语法；有完整的情节或说明，读起来是一篇正常文章，不是拼凑的句子；不要出现真实的教材原文。",
  "9. 每个空都必须能**只靠上下文**判断出唯一正确答案。做不到就别在那里挖空 —— 四个选项都说得通的空等于让人猜。",
  "10. 不要出现真实人名（用 a student、our teacher、my friend 这类）、品牌名、具体日期、比分、分数、名次、金额、网址、邮箱。",
  "11. 不要出现「真题」「押题」「原题」「考过」「某年某地考过」之类的说法，也不要提到任何考试。",
  "12. 不要用 emoji、颜文字、连续感叹号。",
  "13. title 是中文标题，不超过 12 个字，概括这篇短文讲了什么。",
  "14. 输出前自己核对一遍：blanks 是不是正好 10 项？每个 no 是不是 1 到 10 各一次？每个 answer 是不是真的指向正确选项？passage 里是不是正好有 {{1}} 到 {{10}} 各一次？不满足就重写，不要输出残缺的结果。",
].join("\n");

/**
 * 完形填空的变量部分：单元名 + 词表。
 *
 * 为什么词表要**连中文意思一起给**：只给英文原形时，模型会按自己的理解挖空，
 * 而课本里这个词考的可能不是那个意思（如 `suppose` 课本给「猜想」，
 * 模型可能按「假设」去造句）。给了中文意思，它才会贴着课本的那个义项写。
 */
function buildClozeVariable({ unitLabel, words }: ClozePromptInput): string {
  const list = words
    .map((w, i) => `${i + 1}. ${w.lemma}（${w.meaning_zh}）`)
    .join("\n");

  return [
    `教材单元：${unitLabel}`,
    "",
    `本单元词汇表（共 ${words.length} 个词，挖空只能从这里取）：`,
    list,
    "",
    "请出一套 10 个空的完形填空。",
  ].join("\n");
}

/**
 * 任务登记表。
 *
 * ⚠️ **必须写在 `EXAMPLE_SYSTEM` / `CLOZE_SYSTEM` 之后**：`const` 没有提升，
 * 放在前面会报 `Cannot access before initialization` ——
 * 而这类错误发生在模块加载时，整条 AI 链路会一起挂掉（不是某一个任务降级）。
 */
export const TASK_SPECS: { [K in AiTaskId]: TaskSpec<K> } = {
  example_personalized: {
    id: "example_personalized",
    system: EXAMPLE_SYSTEM,
    buildVariable: buildExampleVariable,
  },
  cloze_generate: {
    id: "cloze_generate",
    system: CLOZE_SYSTEM,
    buildVariable: buildClozeVariable,
  },
};

/**
 * 拼提示词。
 *
 * ── 为什么用条件类型绑住 `data` ──────────────────────────────
 * `buildPrompt("cloze_generate", { facts, interestTag })` 这种传错，
 * 编译期就会报错。而如果两个任务共用一个宽 `PromptInput`（所有字段都可选），
 * 传错只会在运行时变成提示词里的一行 `undefined` —— 模型照样会写出点什么，
 * 于是你拿到一道"看似正常、其实没有词表约束"的题，**只有审核能拦住，日志里看不出异常**。
 *
 * ── 中间那两行的 `as unknown as` 是干什么的 ────────────────────
 * `TASK_SPECS[task]` 在 TS 眼里是"两个 TaskSpec 的并集"，取不出一个能接收
 * `PromptInputFor<T>` 的 `buildVariable`。但**表本身由 `{ [K in AiTaskId]: TaskSpec<K> }`
 * 钉死了**：键与 `AiTaskId` 一一对应，每个键的 builder 只接受对应类型的输入。
 * 所以"按 task 取到另一个任务的 builder"在类型层面不可能发生 —— 这次转型是安全的，
 * 它只是把"表是对的"这件事告诉编译器。
 */
export function buildPrompt<T extends AiTaskId>(task: T, data: PromptInputFor<T>): PromptParts {
  const spec = TASK_SPECS[task] as unknown as TaskSpec<T>;
  return { fixed: spec.system, variable: spec.buildVariable(data) };
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
