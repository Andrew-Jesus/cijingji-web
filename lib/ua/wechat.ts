/**
 * 微信内置浏览器 / 系统偏好的动效降级
 *
 * 为什么阶段 0 就做：这是**全局开关**，等动画都写完了再加，要动每一个动画（方案 §9）。
 *
 * 做法：给 <html> 打 `data-motion="reduced"`，
 * globals.css 里据此把 `--motion-shift` 归零 —— 位移消失、只留淡入，
 * 并把 `[data-animated]` 的循环动画整个关掉。
 *
 * 为什么用**内联脚本**而不是 React：
 * 必须在首帧之前执行。放在 React 里会先按正常动效渲染一帧、再切成降级，
 * 用户看到的就是"先跳一下再静止"（闪烁）。内联脚本是同步的，不存在这一帧。
 */

export const MOTION_ATTR = "data-motion";
export const MOTION_REDUCED = "reduced";

/** 纯函数，便于单测与在服务端复用 */
export function shouldReduceMotion(userAgent: string, prefersReduced: boolean): boolean {
  return /MicroMessenger/i.test(userAgent) || prefersReduced;
}

/**
 * 注入到 <head> 的引导脚本。**刻意写得极小**（它阻塞首帧，每个字节都算数），
 * 并且整体包在 try 里 —— 它出错的代价不能是白屏。
 */
export const MOTION_BOOTSTRAP_SCRIPT = `(function(){try{
var u=navigator.userAgent||"";
var r=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if(/MicroMessenger/i.test(u)||r){document.documentElement.setAttribute("${MOTION_ATTR}","${MOTION_REDUCED}");}
}catch(e){}})();`;
