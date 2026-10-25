/**
 * AI 编排 —— 分档路由 + 降级链 + 退避重试 + 冷却 + 记账
 *
 * ── 链的形状（2026-09-25 定案）───────────────────────────────
 * **所有任务一律 `DeepSeek → GLM → 模板`**；谁排前面由 `config.ts` 的档位表决定，
 * 这里只负责按那张表的顺序走，自己不判断"该用谁"。
 * （曾把例句这类轻活排成"GLM 免费档打头"想省钱，被当天的线上实测推翻 —— 见 `config.ts` 头部。）
 *
 * 最后那一档是**确定性兜底**：不依赖网络、不依赖 Key、不可能失败。
 * 有了它，「学习页永不因 AI 失败而卡住」这句话才是真的，而不是一句愿望。
 *
 * ── 三道防线（每一道都是踩过坑加上的）───────────────────────
 *   ① **每档最多试 2 次**，但重试前**先退避**（默认 1.2 秒）。
 *      不加退避就是这个项目真实踩过的坑：免费档并发 1，超时后立刻重发，
 *      一头撞上还在跑的上一次 → 429，于是**兜底档每次都失败**。
 *   ①′ **超时按档算**：免费档 4 秒、付费档 12 秒（`config.ts` 的 `resolveTimeoutMsFor`）。
 *      共用一个数会让免费档被限流时**白等满 12 秒**才换档 —— 另一个真实踩过的坑。
 *      长任务（写完形填空那种）另有自己的一套超时与预算，见 `AI_TASK_LIMITS`。
 *   ② **整条链有总预算**（默认 20 秒）。没有它，2 档 × 2 次 × 12 秒 = 最坏 48 秒。
 *   ③ **冷却表**：某一档明确"死"了（余额不足 / Key 错），几分钟内直接跳过 ——
 *      否则每次请求都要在它身上白等一轮。
 *
 * ── 记账 ────────────────────────────────────────────────────
 * 每一次**真实发生的 API 调用**都产出一条 `AiUsageDraft`，
 * 包括失败的那几次（tokens 取不到就记 0，并且 `ok:false`）。
 * 被冷却跳过、被预算砍掉的那些**不算调用**，所以不产生账目 —— 它们没花钱。
 * 服务端同时打一行结构化日志 —— 服务端是唯一可信来源，
 * 本地的 `ai_usage` 是"给用户看得见"的副本，两者字段同构。
 *
 * ── 2026-10-25：从「只会写例句」到「按任务跑」（做完形填空时改的）──────
 * 原来这个文件是**为例句一个任务写的**：提示词、解析、兜底全写死在函数体里。
 * 加第二个任务时面前有两条路：
 *   ① 把整个函数复制一份改一改 —— 200 行退避/冷却/预算/记账逻辑变成两份；
 *   ② 把"执行"与"这个任务具体干什么"拆开。
 * 选了 ②。理由是那 200 行里**每一行都是踩坑踩出来的**（退避、按档超时、总预算、冷却）。
 * 复制一份之后，下次修其中一个坑，另一份必然忘掉 —— 而忘掉的表现是
 * "例句好了、完形还是老毛病"，且没有任何提示。
 *
 * 现在每个任务只需要提供三样东西：**怎么拼提示词、怎么解析、兜底给什么**。
 * 其余（换档、重试、记账、日志）一律共用一份。
 */
import {
  AI_TASK_TIER,
  backoffMs,
  MIN_ATTEMPT_MS,
  resolveCooldownMs,
  resolveModelChainForTask,
  resolveRetryBackoffMs,
  resolveTotalBudgetMs,
  type AiTaskId,
  type EnvLike,
  type ModelSpec,
} from "./config";
import type { AiAttempt, AiClozePayload, AiExamplePayload, AiUsageDraft } from "./contract";
import { estimateCost } from "./cost";
import {
  fallbackNote,
  templateCloze,
  templateExample,
  type FallbackKind,
  type FallbackReason,
} from "./fallback";
import { parseClozePayload, parseExamplePayload } from "./parse";
import { buildPrompt, type ClozePromptInput, type PromptParts, type WordFacts } from "./prompt";
import { callChatCompletion, ProviderError } from "./provider";
import { checkCloze } from "@/lib/study/cloze";
import {
  decideAfterFailure,
  providerCooldown,
  realSleep,
  type CooldownStore,
} from "./retry";

/** 每个模型最多试几次（含首次）。写成常量是为了让它显式可改，而不是散在循环里 */
export const ATTEMPTS_PER_MODEL = 2;

/** 调用的函数形状。抽出来是为了单测能塞一个"假的模型"进去，走完整条链 */
export type ChatCaller = typeof callChatCompletion;

/**
 * 两个任务共用的注入点。
 *
 * 抽成一个 `RunDeps` 而不是每个任务各写一遍：例句的测试注入的是这几个，
 * 完形的测试注入的也是这几个。共用一个类型，才不会出现
 * "完形的单测漏了注入 `sleep`、于是真的等 1.2 秒"这种事。
 */
export interface RunDeps {
  /**
   * 环境变量。用 `EnvLike`（宽读）而不是 `NodeJS.ProcessEnv`：
   * 后者的 `NODE_ENV` 在 Next 的类型声明里是**必填**，会逼着调用方
   * （尤其是单测）凭空造一个 `NODE_ENV` 出来 —— 那是为迁就类型写的假数据。
   */
  env?: EnvLike;
  /** 记账用的时刻（决定峰谷价）。与 `clock` 分开：一个答"现在几点"，一个答"跑了多久" */
  now?: Date;
  /**
   * 计时用的毫秒表。默认就是真实时间。
   * 抽出来是为了单测能**控制时间流逝** —— 否则"总预算耗尽"这条分支根本测不出来
   * （真实等待 1.2 秒既慢又不可靠）。
   */
  clock?: () => number;
  /** 注入日志出口，便于测试断言"有没有记账/有没有打日志" */
  log?: (record: Record<string, unknown>) => void;
  /** 注入点（单测用）：真实调用 / 等待 / 冷却表 */
  call?: ChatCaller;
  sleep?: (ms: number) => Promise<void>;
  cooldown?: CooldownStore;
}

export interface GenerateOutput<TPayload> {
  payload: TPayload;
  source: "ai" | "template";
  model: string | null;
  degraded: boolean;
  attempts: AiAttempt[];
  usages: AiUsageDraft[];
  notes: string[];
}

export type GenerateExampleOutput = GenerateOutput<AiExamplePayload>;
export type GenerateClozeOutput = GenerateOutput<AiClozePayload>;

/** 解析器的形状。两个任务的 parser 都满足它（失败原因都是字符串） */
type PayloadParser<TPayload> = (
  text: string,
) => { ok: true; payload: TPayload } | { ok: false; reason: string };

/**
 * "这个任务具体干什么" —— 执行器唯一不认识的部分。
 *
 * 只有四样：拼提示词、解析、业务审核、兜底。**换档/重试/记账/预算全在外部**，
 * 所以新增任务不可能忘记处理这些，也不可能处理得跟别人不一样。
 */
interface TaskAdapter<TPayload, TInput> {
  /** 由任务自己把自己的输入拼成提示词 */
  buildPrompt(data: TInput): PromptParts;
  parse: PayloadParser<TPayload>;
  /**
   * 业务审核（可选）。**格式对了不代表内容能用。**
   *
   * 为什么它要挂在执行器里而不是外面：审核不合格时该做的事**跟解析失败一模一样** ——
   * 立刻再问一次（这次不退避，窗口是空的），两次都不行就换档，最后落兜底。
   * 如果放到外层做，就得在外面再写一套"重试几次、什么时候放弃、什么时候落兜底"，
   * 于是那套踩坑踩出来的逻辑就有了第二份。
   *
   * 对完形填空来说，这里跑的是那三道（结构 / 词汇 / 敏感）。
   */
  accept?(payload: TPayload, data: TInput): { ok: true } | { ok: false; reason: string };
  /** 落到兜底时给什么 */
  fallbackPayload(data: TInput): TPayload;
  /** 兜底话术用哪种名词（"通用示例" / "通用练习题"） */
  fallbackKind: FallbackKind;
  /** 首选档没成、由后面的档写出来时，那句如实说明 */
  degradedNote(model: string): string;
}

interface RunInput<TPayload, TInput> extends RunDeps {
  task: AiTaskId;
  /**
   * 日志里认出"这次是给谁的"。**不是给用户看的**，是给我排查时用的：
   * 例句是 `{ word_id }`，完形是 `{ unit_id }`。
   * 用展开的方式并进日志对象，所以字段名与以前逐字一致。
   */
  logContext: Record<string, unknown>;
  data: TInput;
  adapter: TaskAdapter<TPayload, TInput>;
}

function attemptOf(spec: ModelSpec, ok: boolean, latency: number, error?: string): AiAttempt {
  return { model: spec.model, ok, latency_ms: latency, ...(error ? { error } : {}) };
}

function usageDraft(
  task: AiTaskId,
  spec: ModelSpec,
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  latency: number,
  ok: boolean,
  at: Date,
): AiUsageDraft {
  const cost = estimateCost(spec.model, usage, at);
  return {
    task,
    model: spec.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens: usage.cached_tokens,
    cost_cny: cost.cost_cny,
    priced: cost.priced,
    peak: cost.peak,
    latency_ms: latency,
    ok,
  };
}

/** 失败也要留下的那笔账：没拿到 tokens 就记 0，但"这次调用发生过"必须留下 */
function failedUsageDraft(task: AiTaskId, spec: ModelSpec, latency: number): AiUsageDraft {
  return {
    task,
    model: spec.model,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cost_cny: 0,
    priced: true,
    peak: false,
    latency_ms: latency,
    ok: false,
  };
}

/**
 * 跑完整条链。**这里是全项目唯一一处"换档、退避、预算、冷却、记账"的实现。**
 *
 * 逻辑与 2026-10-25 之前那一版**逐行对应**，只把三件事换成了参数：
 * 提示词、解析、兜底。所以例句的行为一个字都没变（`run.test.ts` 的 20 个测试钉着）。
 */
async function runChain<TPayload, TInput>(
  input: RunInput<TPayload, TInput>,
): Promise<GenerateOutput<TPayload>> {
  const { task, adapter } = input;
  const now = input.now ?? new Date();
  // 预算的底线跟着**这条任务所在的档位**算 —— 不同档位的第一家可能不同，
  // 不能拿一个写死的数当"第一档超时"。长任务另有自己的一套数。
  const budgetMs = resolveTotalBudgetMs(input.env, AI_TASK_TIER[task], task);
  const backoffBase = resolveRetryBackoffMs(input.env);
  const cooldownMs = resolveCooldownMs(input.env);
  const chain = resolveModelChainForTask(task, input.env);

  const log = input.log ?? ((record) => console.log(JSON.stringify({ scope: "ai", ...record })));
  const call = input.call ?? callChatCompletion;
  const sleep = input.sleep ?? realSleep;
  const clock = input.clock ?? Date.now;
  // 冷却表用**全局那一份**：冷却能生效的前提就是"所有请求共用一张表"，
  // 每次调用新建一张等于没做冷却。单测里可以注入自己的那份。
  const cooldown = input.cooldown ?? providerCooldown;

  const attempts: AiAttempt[] = [];
  const usages: AiUsageDraft[] = [];
  const notes: string[] = [];
  let sawNetworkIssue = false;
  let sawTimeout = false;
  let ranOutOfTime = false;

  if (chain.length === 0) {
    notes.push(fallbackNote("no_provider", adapter.fallbackKind));
    return {
      payload: adapter.fallbackPayload(input.data),
      source: "template",
      model: null,
      degraded: true,
      attempts,
      usages,
      notes,
    };
  }

  const prompt = adapter.buildPrompt(input.data);
  const messages = [
    { role: "system" as const, content: prompt.fixed },
    { role: "user" as const, content: prompt.variable },
  ];

  const startedAt = clock();
  const elapsed = () => clock() - startedAt;

  chainLoop: for (let ci = 0; ci < chain.length; ci++) {
    const spec = chain[ci];
    const hasNextProvider = ci < chain.length - 1;

    // 冷却中：这一档刚刚明确"死"过（余额不足 / Key 错），连试都不试。
    // 不产生账目 —— 没发生调用，就没花钱。
    if (cooldown.isCooling(spec.provider, clock())) {
      attempts.push(
        attemptOf(spec, false, 0, "冷却中：这一档刚才明确失败过（余额或密钥问题），暂时跳过"),
      );
      log({
        event: "provider_cooling_skip",
        ...input.logContext,
        provider: spec.provider,
        model: spec.model,
        until: cooldown.until(spec.provider),
      });
      continue;
    }

    for (let i = 0; i < ATTEMPTS_PER_MODEL; i++) {
      // 总预算兜底：剩下的时间连一次最短的尝试都不够，就别开了，
      // 直接去兜底 —— 让用户干等是最差的结果。
      const remaining = budgetMs - elapsed();
      if (remaining < MIN_ATTEMPT_MS) {
        ranOutOfTime = true;
        log({
          event: "budget_exhausted",
          ...input.logContext,
          elapsed_ms: elapsed(),
          budget_ms: budgetMs,
        });
        break chainLoop;
      }
      // 单次超时**按档算**（免费档比付费档短，理由见 `config.ts` 的 `FREE_TIMEOUT_MS`），
      // 并且不许超过剩余预算，否则等于把预算当摆设。
      const attemptTimeoutMs = Math.min(spec.timeoutMs, remaining);

      const attemptStarted = clock();
      try {
        const res = await call(spec, messages, { timeoutMs: attemptTimeoutMs });
        const latency = clock() - attemptStarted;

        // 先记账再看内容 —— 一次调用只要发生了就产生了费用，
        // 和它有没有写出合格 JSON 无关。
        const draft = usageDraft(task, spec, res.usage, latency, true, now);
        usages.push(draft);

        const parsed = adapter.parse(res.text);
        if (parsed.ok) {
          /**
           * 格式对了，再看内容能不能用。
           *
           * 这一层是 2026-10-25 做完形填空时加的：那道题"JSON 合法"和"题目能用"
           * 差得很远 —— 空数不对、四个选项里有两个一样、挖空词根本不在本单元，
           * 这些全都是一份完全合法的 JSON。
           * 不合格时**走的路与解析失败完全相同**（下面那段），
           * 因为该做的事本来就一样：立刻再问一次。
           */
          const audit = adapter.accept ? adapter.accept(parsed.payload, input.data) : { ok: true as const };

          if (audit.ok) {
            attempts.push(attemptOf(spec, true, latency));
            log({
              event: "generated",
              ...input.logContext,
              provider: spec.provider,
              model: spec.model,
              input_tokens: draft.input_tokens,
              output_tokens: draft.output_tokens,
              cached_tokens: draft.cached_tokens,
              cache_hit: draft.input_tokens > 0 ? draft.cached_tokens / draft.input_tokens : 0,
              cost_cny: draft.cost_cny,
              priced: draft.priced,
              latency_ms: latency,
            });

            // 「降级」= 首选那一档没成，由链上更靠后的档写出来的。
            // 判据是"是不是 chain[0]"，而不是"是不是免费档" ——
            // 这样改顺序时这里不用跟着动，跟着表走就行。
            const degraded = spec.model !== chain[0].model;
            if (degraded) notes.push(adapter.degradedNote(spec.model));

            return {
              payload: parsed.payload,
              source: "ai",
              model: spec.model,
              degraded,
              attempts,
              usages,
              notes,
            };
          }

          // 内容没过审核：这次调用已经记账了，只是没产出可用的结果。
          // **不退避** —— 上一次已经正常返回了，窗口是空的。
          attempts.push(attemptOf(spec, false, latency, `内容没通过审核（${audit.reason}）`));
          log({
            event: "audit_failed",
            ...input.logContext,
            provider: spec.provider,
            model: spec.model,
            reason: audit.reason,
            cost_cny: draft.cost_cny,
            latency_ms: latency,
          });
          continue;
        }

        // 内容不合格：这次调用已经记账了，只是标成"没产出可用结果"由 attempts 反映。
        // 这里**不退避**：上一次已经正常返回了，窗口是空的，立刻再问一次就行。
        attempts.push(attemptOf(spec, false, latency, `模型输出不合格（${parsed.reason}）`));
        log({
          event: "parse_failed",
          ...input.logContext,
          provider: spec.provider,
          model: spec.model,
          reason: parsed.reason,
          cost_cny: draft.cost_cny,
          latency_ms: latency,
        });
        continue;
      } catch (e) {
        const latency = clock() - attemptStarted;
        const kind = e instanceof ProviderError ? e.kind : "unknown";
        const message = e instanceof Error ? e.message : String(e);
        // 「超时」和「连不上」是两件事，别混：
        // 超时多半是模型太慢（换个档/等一等就好），连不上才是网络问题 ——
        // 对用户是两句话，对我也是一条不同的排查线索。
        if (kind === "network") sawNetworkIssue = true;
        if (kind === "timeout") sawTimeout = true;

        attempts.push(attemptOf(spec, false, latency, message));
        usages.push(failedUsageDraft(task, spec, latency));

        const decision = decideAfterFailure(e, {
          attemptIndex: i,
          attemptsPerModel: ATTEMPTS_PER_MODEL,
          hasNextProvider,
        });
        if (decision.coolDown) cooldown.cool(spec.provider, cooldownMs, clock());

        log({
          event: "call_failed",
          ...input.logContext,
          provider: spec.provider,
          model: spec.model,
          kind,
          status: e instanceof ProviderError ? e.status : null,
          error: message.slice(0, 200),
          next: decision.action,
          cooled_down: decision.coolDown,
          latency_ms: latency,
        });

        if (decision.action !== "retry_same") break; // 换下一档

        // 退避：等上一次真正跑完，再重试 —— 这是那个"每次都失败"的解药
        const wait = backoffMs(i, backoffBase);
        if (elapsed() + wait >= budgetMs) {
          ranOutOfTime = true;
          log({
            event: "budget_exhausted",
            ...input.logContext,
            elapsed_ms: elapsed(),
            budget_ms: budgetMs,
            would_wait_ms: wait,
          });
          break chainLoop;
        }
        await sleep(wait);
      }
    }
  }

  // 为什么落到兜底，要分得清：断网 / 太慢 / 模型没写好，
  // 对用户是三种不同的话，对我排查也是三条不同线索。
  const reason: FallbackReason = sawNetworkIssue
    ? "network"
    : sawTimeout || ranOutOfTime
      ? "too_slow"
      : "model_failed";
  notes.push(fallbackNote(reason, adapter.fallbackKind));
  log({
    event: "fell_back_to_template",
    ...input.logContext,
    reason,
    tier: AI_TASK_TIER[task],
    tried: attempts.map((a) => a.model),
  });

  return {
    payload: adapter.fallbackPayload(input.data),
    source: "template",
    model: null,
    degraded: true,
    attempts,
    usages,
    notes,
  };
}

/* ══════════════════════════ 任务一：例句 ══════════════════════════ */

export interface GenerateExampleInput extends RunDeps {
  wordId: string;
  interestTag: string;
  facts: WordFacts;
  /**
   * 任务 id。**档位是从它推出来的**，不是写死在函数名里 ——
   * 以后 `generateExample` 拆成通用入口时，这里不用改。
   */
  task?: AiTaskId;
}

const EXAMPLE_ADAPTER: TaskAdapter<AiExamplePayload, GenerateExampleInput> = {
  buildPrompt: (input) =>
    buildPrompt("example_personalized", { facts: input.facts, interestTag: input.interestTag }),
  parse: parseExamplePayload,
  fallbackPayload: (input) => templateExample(input.facts, input.interestTag),
  fallbackKind: "example",
  degradedNote: (model) => `首选档没成，这一句是「${model}」写的。`,
};

export async function generateExample(input: GenerateExampleInput): Promise<GenerateExampleOutput> {
  return runChain({
    task: input.task ?? "example_personalized",
    logContext: { word_id: input.wordId, interest_tag: input.interestTag },
    data: input,
    adapter: EXAMPLE_ADAPTER,
    env: input.env,
    now: input.now,
    clock: input.clock,
    log: input.log,
    call: input.call,
    sleep: input.sleep,
    cooldown: input.cooldown,
  });
}

/* ══════════════════════════ 任务二：完形填空 ══════════════════════════ */

export interface GenerateClozeInput extends RunDeps {
  unitId: string;
  /** 人话的单元名，进提示词（不进 system —— 那会毁掉缓存前缀） */
  unitLabel: string;
  /** 本单元词汇表。挖空只能从这里取，审核也拿它核对 */
  words: ClozePromptInput["words"];
}

/**
 * 完形填空的兜底**不看输入** —— 它就是那篇写死的短文。
 *
 * 这一点值得说明：例句兜底还能把"这个词 + 这个兴趣"拼进去，因为一句话塞得下。
 * 一篇 200 词的短文塞不进用户的词表（那等于现场写一篇），
 * 所以它只能是通用的。**代价写在界面上**：`run.ts` 把 `source: "template"`
 * 如实交出去，页面据此标"这套题不计入复习安排"。
 */
const CLOZE_ADAPTER: TaskAdapter<AiClozePayload, GenerateClozeInput> = {
  buildPrompt: (input) =>
    buildPrompt("cloze_generate", { unitLabel: input.unitLabel, words: input.words }),
  parse: parseClozePayload,
  /**
   * 三道审核 —— 格式合法不等于题目能用。
   *
   * ⚠️ 词表用的是 `input.words`（与提示词同一个来源），**不是**另外再查一遍。
   * 两处各查一遍，就会出现"提示词里给了 51 个词、审核只认 49 个"这种
   * 没头没尾的失败：模型明明照着词表挖的，审核却说不在表里，于是重试、再失败、落兜底。
   */
  accept: (payload, input) => {
    const pool = new Set(input.words.map((w) => w.lemma_normalized));
    const check = checkCloze(payload, pool);
    return check.ok ? { ok: true } : { ok: false, reason: check.notes.join("；") };
  },
  fallbackPayload: () => templateCloze(),
  fallbackKind: "cloze",
  degradedNote: (model) => `首选档没成，这套题是「${model}」出的。`,
};

export async function generateCloze(input: GenerateClozeInput): Promise<GenerateClozeOutput> {
  return runChain({
    task: "cloze_generate",
    logContext: { unit_id: input.unitId },
    data: input,
    adapter: CLOZE_ADAPTER,
    env: input.env,
    now: input.now,
    clock: input.clock,
    log: input.log,
    call: input.call,
    sleep: input.sleep,
    cooldown: input.cooldown,
  });
}
