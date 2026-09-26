/**
 * 把 Supabase 的报错翻成**人话**。
 *
 * 为什么单独写一层：Supabase 返回的是 `Invalid login credentials` 这种英文码。
 * 直接甩给用户，他不知道是自己打错了、还是账号没开、还是网断了 ——
 * 三件事要做的事完全不同（改密码 / 找我要账号 / 检查网络）。
 * 把"码"翻成"下一步该干嘛"，是这个函数唯一的职责。
 *
 * 刻意不 import Supabase 的类型：这样它没有依赖、纯输入输出，好测也好复用。
 * 任何带 `code` / `status` / `message` 的对象丢进来都行。
 *
 * 兜底那条**必须带上原始信息**：翻译不出来的错不能吞掉，
 * 用户把那句话发给我，我才查得到（不然只剩"登录失败"四个字，无从下手）。
 */

/** 能从错误对象/字符串里稳定拿到的三样东西 */
interface AuthErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function pick(error: unknown): { code: string; status: number | null; message: string } {
  if (typeof error === "string") return { code: "", status: null, message: error };
  if (error && typeof error === "object") {
    const e = error as AuthErrorLike;
    return {
      code: typeof e.code === "string" ? e.code : "",
      status: typeof e.status === "number" ? e.status : null,
      message: typeof e.message === "string" ? e.message : "",
    };
  }
  return { code: "", status: null, message: String(error ?? "") };
}

/** 网络层失败的典型长相（浏览器给的，不是 Supabase 给的） */
function looksLikeNetworkFailure(message: string): boolean {
  return /failed to fetch|network|load failed|fetch failed|timeout|timed out|aborted/i.test(
    message,
  );
}

export function describeAuthError(error: unknown): string {
  const { code, status, message } = pick(error);

  // 先按 code 认（最准），再按 HTTP 状态码，最后按英文原文，最后兜底
  switch (code) {
    case "invalid_credentials":
      return "邮箱或密码不对，再试一次。";
    case "email_not_confirmed":
      // 我们自己会在后台"自动确认"，所以撞上这条基本是账号没开成功
      return "这个账号还没激活。跟我说一声，我给你开一下。";
    case "user_banned":
      return "这个账号被停用了。";
    case "email_address_invalid":
    case "validation_failed":
      return "邮箱的格式看着不太对，检查一下。";
    case "weak_password":
      return "密码太短了，至少 6 位。";
    case "signup_disabled":
      return "这个网站没开自助注册 —— 账号由我统一开通。";
    case "over_request_rate_limit":
    case "too_many_requests":
    case "over_email_send_rate_limit":
      return "试得有点频繁了，等一分钟再试。";
    case "same_password":
      return "新密码不能和旧的一样。";
    default:
      break;
  }

  if (status === 429) return "试得有点频繁了，等一分钟再试。";
  if (status === 400 && /invalid login credentials/i.test(message)) {
    return "邮箱或密码不对，再试一次。";
  }
  if (looksLikeNetworkFailure(message) || status === 0) {
    return "连不上账号服务器 —— 检查一下网络，或者稍后再试。";
  }

  // 兜底：把原文带出来。翻译不了不代表可以吞掉。
  const detail = [code, message].filter((s) => s.length > 0).join(" / ");
  return detail.length > 0
    ? `登录没成功（${detail}）。把括号里这句发给我，我来查。`
    : "登录没成功，原因没认出来。稍后再试一次。";
}
