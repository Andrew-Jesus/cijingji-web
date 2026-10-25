/**
 * 兜底例句 —— 纯函数，**永远不失败**
 *
 * 它是三级降级链的最后一档，存在的意义只有一个：
 * **学习页永远不会因为 AI 挂了而卡住。**
 *
 * ── 为什么兜底句要写成这个样子 ────────────────────────────────
 * 它是拼出来的，不可能"像人写的"。两个选择：
 *   ① 装作像人写的（套模板写"Tom likes playing basketball very much"之类），
 *      用户会以为这是 AI 给他写的例句 —— 这是**在骗人**；
 *   ② 老老实实写一句语法正确、含这个词、但明显是通用句式的话，
 *      界面上再标一句"AI 暂时没用上，这是通用示例"。
 * 选 ②。产品里的诚实标注不是装饰，是"用户能追问数字出处"这条规矩的一部分。
 *
 * 另外这条模板**不可能编造事实**：它只用已确认的三样东西 ——
 * 单词本身、中文词义、兴趣域名字。这正好和"AI 不许编事实"是同一个底线。
 */
import { GENERIC_INTEREST_LABEL_EN, resolveInterest } from "@/lib/onboarding/questions";
import type { ClozeBlank } from "@/lib/study/cloze";
import type { WordFacts } from "./prompt";

export interface TemplateExample {
  sentence: string;
  gloss: string;
}

/**
 * 通用句式：`We used the word "x" when we talked about <话题>.`
 *
 * 为什么用这个句式而不是"把词塞进一个像样的场景"：
 * 一个句式要同时适配名词 / 动词 / 形容词 / 副词，还要语法正确 ——
 * 只有"提到这个词"这种**元句式**做得到不犯语法错。
 * 换成 "I like ${lemma}" 那种，遇到 ancient / carefully 就立刻错。
 */
export function templateExample(facts: WordFacts, interestTag: string): TemplateExample {
  // 中英两个名字**成对取**（见 `resolveInterest`）——
  // 这两句是同一句话的两面，一边说 everyday life、一边说「篮球」，
  // 用户第一眼就会觉得这产品很糙。
  const { labelEn, label } = resolveInterest(interestTag);

  return {
    sentence: `We used the word "${facts.lemma}" when we talked about ${labelEn}.`,
    gloss: `我们聊到${label}的时候，用到了 ${facts.lemma} 这个词。`,
  };
}

/**
 * 界面上那句如实标注（按场景不同而不同）。
 *
 * 分开的原因：**"没配 Key"和"网络断了"和"模型抽风了"和"太慢等超时了"是四件不同的事**，
 * 对用户和对我的排查价值完全不同。笼统写一句"AI 不可用"等于什么都没说。
 */
export type FallbackReason = "no_provider" | "network" | "model_failed" | "too_slow" | "unexpected";

/**
 * 是哪种任务落到了兜底。**只有话术不同，判定逻辑完全一样。**
 *
 * 为什么要分：例句兜底给的是「一句通用示例」，完形兜底给的是一「套通用练习题」——
 * 同一个 `reason` 配错名词，用户看到的就是"给你一句通用示例"下面摆着一整篇文章。
 */
export type FallbackKind = "example" | "cloze";

const FALLBACK_NOUN: Record<FallbackKind, string> = {
  example: "先给你一句通用示例",
  cloze: "先给你一套通用练习题",
};

/**
 * 每种兜底**都要**说清"这不是给你量身做的"。
 *
 * ⚠️ 完形那一条尤其不能省："不计入你的复习安排"是**事实说明**，不是客套话。
 * 兜底题的挖空词跟用户当前单元没有任何关系，所以 `run.ts` 在 `source === "template"`
 * 时**不做回流**。界面上一句都不提的话，用户会以为刚才那 10 道题影响了自己的复习计划 ——
 * 而它其实一点都没影响。**该说的不说，和说假的，是一回事。**
 */
const FALLBACK_TAIL: Record<FallbackKind, string> = {
  example: "词照常可以练。",
  cloze: "这套题不计入你的复习安排，只是让你现在有得做。",
};

export function fallbackNote(reason: FallbackReason, kind: FallbackKind = "example"): string {
  const noun = FALLBACK_NOUN[kind];
  const tail = FALLBACK_TAIL[kind];

  switch (reason) {
    case "no_provider":
      return `这台设备上还没配 AI（缺 API Key），${noun} —— ${tail}`;
    case "network":
      return `现在连不上 AI（可能是断网），${noun} —— ${tail}`;
    case "model_failed":
      return `AI 这次没写出合格的题目（连着两档都没成），${noun}。下次会重试。${tail}`;
    case "too_slow":
      return `AI 这次回得太慢，等它不如先做点别的 —— ${noun}，下次会重试。${tail}`;
    default:
      return `AI 这条路出了点意外，${noun} —— ${tail}`;
  }
}

/**
 * 兜底的完形填空 —— 一篇写死的、内容中性的短文，10 空 4 选 1。
 *
 * ── 为什么它必须"真的能做完" ─────────────────────────────────
 * 它是整条链的最后一档，职责是让用户点开就有题做。给一篇只有 3 个空的残篇、
 * 或者一篇选项都一样的废题，等于把"AI 挂了"翻译成"这个产品坏了"。
 * 所以这 10 个空的每一个都能靠上下文唯一确定答案，四个选项都是同一词性的不同词。
 *
 * ── 为什么它**不计入复习安排**（重要）────────────────────────
 * 它的挖空词跟用户当前单元的词汇表**没有任何关系**（写死的内容不可能对上 18 个单元）。
 * 如果照样回流，用户答错就会把"again"记到一个他根本没在学的词上：
 * 那个词会莫名出现在难词区，而真正该复习的词一次都没被提前。
 * 这不是"少记一次"，是**往复习安排里写脏数据**。
 * 所以 `run.ts` 在 `source === "template"` 时不回流，界面上也如实说明。
 */
export function templateCloze(): { title: string; passage: string; blanks: ClozeBlank[] } {
  return {
    title: "去农场的一天",
    passage: [
      "Last Friday, our class went to a farm near the river. We left school at seven in the morning and {{1}} there by bus.",
      "The farmer was waiting for us at the gate. He was a tall man with a big smile. First, he {{2}} us around the farm. We saw cows, sheep, and hundreds of chickens. Everything was new to us.",
      "Then we helped him {{3}} the eggs. It looked easy, but it was not. We had to be quiet and careful. Some of us broke an egg, and the farmer just laughed.",
      "At noon we sat under a big tree and ate our lunch. The farmer {{4}} us a story about his childhood. He said he had lived on the farm all his life and had never wanted to {{5}} away.",
      "In the afternoon, we {{6}} in a small field. It was hard work under the sun. After an hour, we were tired and thirsty, but we felt {{7}}.",
      "When it was time to leave, the farmer gave each of us a bag of apples. We said thank you and {{8}} him to visit our school one day.",
      "On the bus back, everybody was quiet. I think we were all {{9}} about the same thing: how different our lives are, and how much we can {{10}} from people who live differently.",
    ].join("\n\n"),
    blanks: [
      { no: 1, options: ["left", "moved", "went", "stayed"], answer: 2, word: "go" },
      { no: 2, options: ["taught", "showed", "told", "gave"], answer: 1, word: "show" },
      { no: 3, options: ["cook", "eat", "sell", "collect"], answer: 3, word: "collect" },
      { no: 4, options: ["asked", "told", "answered", "called"], answer: 1, word: "tell" },
      { no: 5, options: ["run", "walk", "move", "swim"], answer: 2, word: "move" },
      { no: 6, options: ["played", "slept", "sang", "worked"], answer: 3, word: "work" },
      { no: 7, options: ["afraid", "proud", "angry", "bored"], answer: 1, word: "proud" },
      { no: 8, options: ["told", "asked", "invited", "warned"], answer: 2, word: "invite" },
      { no: 9, options: ["dreaming", "arguing", "thinking", "complaining"], answer: 2, word: "think" },
      { no: 10, options: ["buy", "build", "learn", "write"], answer: 2, word: "learn" },
    ],
  };
}

export { GENERIC_INTEREST_LABEL_EN };
