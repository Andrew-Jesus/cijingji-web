#!/usr/bin/env node
/**
 * 本地「假模型」服务 —— 用来在没有真 Key 的时候验证 AI 通路
 *
 * ── 它解决什么问题 ──────────────────────────────────────────
 * 真 Key 要实名、要充钱，而且验的时候会真的花钱。但那些"最容易被写错"的地方
 * 跟模型的智力**完全无关**：
 *   · 请求体拼得对不对（`response_format` / `max_tokens` / messages 结构）；
 *   · system 提示词是不是**逐字稳定**（缓存的价钱差 30 倍，全押在这一点上）；
 *   · 返回值解析（JSON 外面可能包着 ```）、schema 校验、降级、重试；
 *   · token 记账（`prompt_cache_hit_tokens` 有没有被读出来、缓存部分有没有重复计费）。
 * 这个假服务把这些链路**原样**走一遍，返回 OpenAI 兼容的响应。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *   终端 A：node scripts/mock-ai-server.mjs
 *   终端 B：npm run dev
 * 并把 `.env.local` 指过来（见 `.env.example` 里的「本地假模型」一段）。
 *
 * 想验降级链，用环境变量换档（改完要重启它）：
 *   MOCK_MODE=500      永远返回 500（看"退避重试 + 降级到下一档"）
 *   MOCK_MODE=429      永远返回 429（看"撞限流不硬重试、痛快换下一档"）
 *   MOCK_MODE=402      永远返回 402 余额不足（看"死症 → 打冷却 → 下次直接跳过"）
 *   MOCK_MODE=garbage  返回一段不是 JSON 的文本（看 schema 失败的处理）
 *   MOCK_MODE=slow     拖 30 秒才回（看超时）
 *   MOCK_MODE=empty    usage 里不给 token 数（看"取不到就记 0"）
 *   MOCK_DELAY_MS=3000 每次响应前先等 3 秒 —— 和 MODE 正交，可叠加上面任意一种。
 *                      专门用来验**时序**类问题，比如"提前写能不能把等待吃掉"：
 *                      模型慢 3 秒时，有预取的那次提交后仍应 ≈1 秒出句子。
 *
 * ── 想同时模拟"这一家坏、那一家好"怎么办 ────────────────────
 * **再起一个实例、换个端口**，然后让两家分别指向不同端口，例如：
 *   终端 A：node scripts/mock-ai-server.mjs                        → 8787，好
 *   终端 B：MOCK_PORT=8790 MOCK_MODE=429 node scripts/mock-ai-server.mjs → 8790，限流
 *   终端 C：AI_BASE_GLM=http://127.0.0.1:8790 npm start
 * 这样"GLM 限流 → 换 DeepSeek"整条链就能在本机真实走一遍。
 * （环境变量在这里是**进程环境优先**，不必去改 .env.local —— 也免得把手改的文件忘在那。）
 *
 * ── 一个额外的体检项 ────────────────────────────────────────
 * 它会打印**每一通请求的 system 提示词指纹**。如果指纹在两次调用之间变了，
 * 说明提示词里混进了"每次都不同"的东西（时间戳、随机 id、顺序不稳定的字段），
 * 那么线上缓存命中率会是 0 —— 而这个 bug 在真机上极难看出来，
 * 只会表现为"账单比预期贵"，不会报任何错。
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const MODE = process.env.MOCK_MODE ?? "ok";

/** 每次响应前先等这么久（毫秒）。0 = 立刻回。与 MODE 正交，见文件头 */
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 0);

/** 从 user 消息里抠出 `话题：xxx（xxx）` 与词头，用来证明"兴趣真的进了提示词" */
function readPrompt(userText) {
  const topic = /话题：(.+)/.exec(userText)?.[1]?.trim() ?? "(没读到话题)";
  const word = /单词：(.+)/.exec(userText)?.[1]?.trim() ?? "(没读到单词)";
  return { topic, word };
}

/** 假模型"写"的句子。刻意把话题原样嵌进去 —— 这样"换了兴趣例句就该不同"肉眼可验 */
function fakeExample({ topic, word }) {
  return {
    sentence: `Last week I read something about ${word} in a piece on ${topic}, and it stayed with me.`,
    gloss: `上周我在一篇讲${topic}的文章里读到了 ${word}，一直记着。`,
  };
}

/**
 * 从 user 消息里抠出单元词表。
 *
 * 提示词那边的格式是 `1. suppose（猜想）`（见 `lib/ai/prompt.ts` 的 `buildClozeVariable`）。
 * 这里按同一个格式读回来，于是**"词表到底有没有进提示词"这件事变成可验证的**：
 * 假模型只会拿它读到的词去挖空，读不到就凑不出 10 个空，一眼就看得出来。
 */
function readWordList(userText) {
  const out = [];
  const seen = new Set();
  for (const line of String(userText).split("\n")) {
    const m = /^\s*\d+\.\s+([A-Za-z][A-Za-z' -]*?)\s*（/.exec(line);
    if (!m) continue;
    const word = m[1].trim();
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/**
 * 假模型"出"的完形填空。
 *
 * 两个刻意的做法：
 *   ① **挖空词全部取自它读到的词表** —— 这样它输出能过 `checkCloze` 的词汇校验。
 *      如果词表没进提示词（有人把变量拼错了），这里就凑不出 10 个空，
 *      假模型会返回一个不合格的题，客户端当场判废 —— **链路一断就看得见**。
 *   ② **短文按固定句式重复 10 遍**，凑够 150 词。它不是一篇好文章，
 *      但它**满足全部结构约束**（150 词落在 120~280 区间、10 个 `{{n}}`、每空 4 个不同选项）。
 *      假模型的职责是把管道跑通，不是写范文。
 */
function fakeCloze(userText) {
  const words = readWordList(userText);
  const pool = words.length >= 10 ? words : [];
  if (pool.length < 10) {
    // 读不到词表就明确报错 —— 不要"凑一个能过的",那会把真问题藏起来
    return null;
  }

  const picked = pool.slice(0, 10);
  const sentence =
    "The students often talk about this topic with their teacher after class in the afternoon.";
  const passage = picked.map((_, i) => `${sentence} {{${i + 1}}}`).join(" ");

  const blanks = picked.map((word, i) => {
    // 干扰项从词表里挑别的词，保证归一后互不相同（选项重复会被审核判废）
    const others = pool.filter((w) => w.toLowerCase() !== word.toLowerCase());
    const distractors = [];
    for (let k = 0; distractors.length < 3; k++) {
      const candidate = others[(i * 3 + k) % others.length];
      if (!candidate) break;
      if (distractors.some((d) => d.toLowerCase() === candidate.toLowerCase())) continue;
      if (candidate.toLowerCase() === word.toLowerCase()) continue;
      distractors.push(candidate);
    }
    while (distractors.length < 3) distractors.push(`filler${distractors.length}${i}`);

    // 把正确答案随机放到 4 个位置之一（`i % 4` 就够乱，且完全确定、便于复现）
    const options = [word, ...distractors];
    const answer = i % 4;
    const shuffled = options.slice();
    [shuffled[0], shuffled[answer]] = [shuffled[answer], shuffled[0]];
    return { no: i + 1, options: shuffled, answer, word };
  });

  return { title: "课后的一段对话", passage, blanks };
}

/** 这一通请求是哪个任务。判据与线上一致：看 system 提示词 */
function detectTask(systemText) {
  return String(systemText).includes("完形填空") ? "cloze_generate" : "example_personalized";
}

/** 粗估 token 数。不用精确 —— 这里只是为了让记账那一行有数可看 */
function roughTokens(text) {
  return Math.max(Math.ceil(text.length / 4), 1);
}

let systemPromptFingerprint = null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "只有 POST /chat/completions" }));
    return;
  }

  const raw = await readBody(req);

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "请求体不是 JSON" } }));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const { topic, word } = readPrompt(String(user));
  const task = detectTask(system);
  const unitWords = task === "cloze_generate" ? readWordList(String(user)) : [];

  // —— 体检：system 是不是逐字稳定 ——
  const fp = createHash("sha1").update(String(system)).digest("hex").slice(0, 12);
  const same = systemPromptFingerprint === fp;
  systemPromptFingerprint = fp;
  console.log(
    (task === "cloze_generate"
      ? `\n[假模型] 收到：model=${body.model} · 任务=完形填空 · 词表 ${unitWords.length} 个` +
        (unitWords.length > 0 ? `（${unitWords.slice(0, 5).join("、")}…）` : "（⚠ 一个都没读到）")
      : `\n[假模型] 收到：model=${body.model} · 词=${word} · 话题=${topic}`) +
      `\n         system 指纹=${fp} ${same ? "（与上一通相同 ✓ 能命中缓存）" : "（变了 ⚠ 缓存会失效）"}` +
      `\n         请求约束：response_format=${JSON.stringify(body.response_format)} · max_tokens=${body.max_tokens} · temperature=${body.temperature}`,
  );

  if (DELAY_MS > 0) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  if (MODE === "slow") {
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (MODE === "500") {
    console.log("         → 按 MOCK_MODE=500 返回 500");
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "假故障：内部错误" } }));
    return;
  }
  if (MODE === "429") {
    // 复刻智谱免费档那条"并发 1"的规矩被撞到时回的东西。
    // 关键看**客户端**怎么反应：应当立刻换下一档，而不是在同一档上硬碰。
    console.log("         → 按 MOCK_MODE=429 返回 429（限流）");
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "1302", message: "并发数超限，请稍后重试" } }));
    return;
  }
  if (MODE === "402") {
    // 复刻 DeepSeek 余额不足。这是**死症**：几分钟内重试一百次结果一样。
    // 客户端应当把它记进冷却表，之后一段时间连试都不试 —— 否则每次都要白等一轮。
    console.log("         → 按 MOCK_MODE=402 返回 402（余额不足）");
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Insufficient Balance", type: "insufficient_balance" } }));
    return;
  }

  // 按任务分支。⚠️ 这里绝不能"不管什么任务都回例句 JSON" ——
  // 完形请求收到例句 JSON 会解析失败，而那种失败看起来像"模型不会写题"，
  // 会把人往"换个模型试试"的方向带，真问题（分支没写）反而被藏起来。
  let content;
  if (MODE === "garbage") {
    content = "好的，这是你要的：它很好看，但格式完全不按要求来。";
  } else if (task === "cloze_generate") {
    const cloze = fakeCloze(String(user));
    if (cloze) {
      content = JSON.stringify(cloze);
    } else {
      // 读不到 10 个词 ⇒ 明确退化，让链路当场断掉、日志里看得见。
      // **不要在这里凑一篇能过的短文** —— 那会把"变量拼错了"这件事藏起来。
      console.log("         → ⚠ 提示词里凑不出 10 个词，出不了题（词表可能没进提示词）");
      content = "抱歉，我这次出不了题。";
    }
  } else {
    content = JSON.stringify(fakeExample({ topic, word }));
  }

  const systemTokens = roughTokens(String(system));
  const userTokens = roughTokens(String(user));
  const outTokens = roughTokens(content);

  // 缓存命中：system 是逐字稳定的那部分，按"整段都命中"算 —— 这正是缓存分层设计
  // 想达到的效果，也让开发者模式里的命中率有个真实可读的数
  const cached = MODE === "empty" ? 0 : systemTokens;

  const payload = {
    id: `mock-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };

  if (MODE !== "empty") {
    payload.usage = {
      prompt_tokens: systemTokens + userTokens,
      completion_tokens: outTokens,
      total_tokens: systemTokens + userTokens + outTokens,
      // DeepSeek 的字段名。provider.ts 两个名字都认，这里用 DeepSeek 那个
      prompt_cache_hit_tokens: cached,
    };
  }

  console.log(
    `         → 返回：in=${systemTokens + userTokens}（命中 ${cached}）· out=${outTokens}`,
  );

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[假模型] 已启动：http://127.0.0.1:${PORT} · 模式 ${MODE}`);
  console.log("        把 AI_BASE_DEEPSEEK / AI_BASE_GLM 指向它即可（模型名可以不写，用代码默认值）。");
});
