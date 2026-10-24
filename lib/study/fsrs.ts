/**
 * FSRS 的**唯一**真实实现 —— 把算法库藏在这个文件里
 *
 * 对外只暴露 `replay.ts` 定义的 `MemoryScheduler` 接口（`initial` / `next`）。
 * 上层（重放、仓库、页面）**谁都不许直接 import `ts-fsrs`**，
 * 这样换算法只改这一个文件，而且"这段代码用了哪个算法"在调用处看得见。
 *
 * ── 三条把算法接错也不会报错的坑，先写在这里 ────────────────────
 *
 * ① **`enable_fuzz` 必须是 false。**
 *    FSRS 默认会给间隔加一点随机扰动，让同一天的复习不要全挤在一起 ——
 *    对"单个用户跟着走"是好设计，对本产品是**致命的**：
 *    我们的状态表是 `review_logs` 的派生值，靠重放重建。
 *    一旦开 fuzz，同一批流水重放两次会得到两个不同的 `due`，
 *    "状态可丢弃"这个前提当场失效，而且**不会有任何报错**。
 *    所以这里显式写死 false —— 不依赖库的默认值（哪天升级改了默认值，
 *    我们就会被静默带进坑里）。
 *
 * ② **state 是数字，我们存的是字符串。**
 *    ts-fsrs: 0 New / 1 Learning / 2 Review / 3 Relearning
 *    本项目: "new" / "learning" / "review" / "relearning"
 *    两边各写一遍映射，**但只在这一个文件里写**。写错的表现是
 *    "词永远停在学习中"或"新词被当成复习词"，都是不报错的那种错。
 *
 * ③ **`at` 必须由调用方给，这里绝不取 `Date.now()`。**
 *    重放时"现在"没有任何意义 —— 重放用的是流水里那条记录的时间。
 *    在这个文件里取当前时间，重放就会得到"今天重放 = 今天的状态"，
 *    历史全被抹平成最后一次作答。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Grade } from "ts-fsrs";
import type { MemoryState } from "@/lib/db/types";
import type { MemoryGrade, MemoryScheduler, MemorySlice } from "./replay";

/**
 * 固定的算法参数。
 *
 * `request_retention: 0.9` 是 FSRS 的默认目标记忆保持率（九成的东西到点还记得）。
 * 对我们这种"每天 24 个词、中考前要记牢"的场景是合适的：
 * 调高（0.95）会让复习量涨三四成，中学生扛不住；调低（0.8）会让词掉得太快。
 *
 * ⚠️ **这些参数一旦改了，历史重放的结果就全变了**（同一批流水算出另一个 due）。
 * 真要改，必须同时把所有人的状态表清空重建 —— 否则机器上会一半新参数、
 * 一半旧参数，而且看不出来。改之前先问：这个改动值得让所有人重算一遍吗？
 */
const PARAMS = generatorParameters({
  request_retention: 0.9,
  /** 见文件头 ① —— 不是"顺手抄的默认值"，是**重放确定性的前提** */
  enable_fuzz: false,
  /**
   * 短时记忆（1 分钟 / 10 分钟两个学习步骤）。
   * 打开它的效果：第一次答对后，词会在 10 分钟后再问一次，
   * 答对了才真正进入"天"级别的间隔。
   * 这对"当天就记住"很有用，所以保持默认的开启状态。
   */
  enable_short_term: true,
});

/** 全局唯一一个调度器实例。它是无状态的纯计算器，可以安全共享 */
const SCHEDULER = fsrs(PARAMS);

const STATE_TO_STRING: Record<number, MemoryState> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const STRING_TO_STATE: Record<MemoryState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/**
 * ts-fsrs 的 Card → 我们存的切片。
 *
 * `last_review` 在库里是 `Date | undefined`（新卡没有），我们存 null ——
 * 库里不存 `undefined`，Dexie 会把 `undefined` 的字段整个丢掉，
 * 读回来时那个键不存在，和"值是 null"是两种形状，混用迟早出 bug。
 */
function toSlice(card: {
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: Date;
  learning_steps: number;
}): MemorySlice {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_STRING[card.state] ?? "new",
    last_review: card.last_review ? card.last_review.toISOString() : null,
    learning_steps: card.learning_steps,
  };
}

/** 我们存的切片 → ts-fsrs 的 Card。`last_review` 的坏时间戳按"没有"处理 */
function toCard(slice: MemorySlice) {
  const lastReview = slice.last_review ? new Date(slice.last_review) : undefined;
  return {
    due: new Date(slice.due),
    stability: slice.stability,
    difficulty: slice.difficulty,
    elapsed_days: slice.elapsed_days,
    scheduled_days: slice.scheduled_days,
    reps: slice.reps,
    lapses: slice.lapses,
    state: STRING_TO_STATE[slice.state] ?? State.New,
    last_review: lastReview && !Number.isNaN(lastReview.getTime()) ? lastReview : undefined,
    learning_steps: slice.learning_steps,
  };
}

/**
 * 真实调度器。**只有两个方法，都是纯的**：同样的输入必然同样的输出。
 *
 * `next` 里没有 try/catch —— 算法抛错就让它抛。
 * 吞掉异常会写出一个"看起来更新了、其实没更新"的状态，
 * 那比当场失败更难查（而且失败点在作答那一刻，用户还看得见）。
 */
export const fsrsScheduler: MemoryScheduler = {
  initial(at: Date): MemorySlice {
    return toSlice(createEmptyCard(at));
  },

  next(prev: MemorySlice, grade: MemoryGrade, at: Date): MemorySlice {
    const gradeMap: Record<MemoryGrade, Grade> = {
      1: Rating.Again,
      2: Rating.Hard,
      3: Rating.Good,
      4: Rating.Easy,
    };
    return toSlice(SCHEDULER.next(toCard(prev), at, gradeMap[grade]).card);
  },
};
