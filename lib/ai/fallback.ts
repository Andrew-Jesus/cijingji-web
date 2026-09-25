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
import { GENERIC_INTEREST_LABEL_EN, interestLabel, interestLabelEn } from "@/lib/onboarding/questions";
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
  const en = interestLabelEn(interestTag);
  const zh = interestLabel(interestTag);

  return {
    sentence: `We used the word "${facts.lemma}" when we talked about ${en}.`,
    gloss: `我们聊到${zh}的时候，用到了 ${facts.lemma} 这个词。`,
  };
}

/**
 * 界面上那句如实标注（按场景不同而不同）。
 *
 * 分开的原因：**"没配 Key"和"网络断了"和"模型抽风了"和"太慢等超时了"是四件不同的事**，
 * 对用户和对我的排查价值完全不同。笼统写一句"AI 不可用"等于什么都没说。
 */
export type FallbackReason = "no_provider" | "network" | "model_failed" | "too_slow" | "unexpected";

export function fallbackNote(reason: FallbackReason): string {
  switch (reason) {
    case "no_provider":
      return "这台设备上还没配 AI（缺 API Key），先给你一句通用示例 —— 词照常可以练。";
    case "network":
      return "现在连不上 AI（可能是断网），先给你一句通用示例 —— 断网不影响练词。";
    case "model_failed":
      return "AI 这次没写出合格的句子（连着两档都没成），先给你一句通用示例，下次会重试。";
    case "too_slow":
      return "AI 这次回得太慢，等它不如先练词 —— 先给你一句通用示例，下次会重试。";
    default:
      return "AI 这条路出了点意外，先给你一句通用示例。";
  }
}

export { GENERIC_INTEREST_LABEL_EN };
