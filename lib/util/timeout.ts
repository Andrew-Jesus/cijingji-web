/**
 * 给一个 Promise 加"最多等多久"的上限。
 *
 * 为什么需要它：**断网时 Supabase 客户端不会立刻报错，而是静静地挂着**
 * （浏览器默认要等 TCP 超时，几十秒到一分钟）。用它兜住，
 * 用户拿到的才是"等一下就知道结果"，而不是白屏。
 *
 * 注意它是**不等了**，不是**取消**：原来那次请求还在跑，只是我们不再等它。
 * 所以不要拿它当"重试之前先取消"用（那需要 AbortController）。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`操作超过 ${ms} 毫秒还没结果`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
