/**
 * 设计变量（JS 侧）
 *
 * 颜色**不在这里**。理由：颜色只有一份来源 —— app/globals.css 的 @theme 块，
 * 由 Tailwind 生成 bg-surface / text-secondary 这类语义类名。
 * 如果在 TS 里再抄一份色值，就会出现两处真相，早晚不一致。
 *
 * 这里只放 CSS 类名表达不了的东西：动效参数、圆角数值、断点。
 * 与 globals.css 的对应关系在注释里标出，改一处必须同时改另一处。
 */
import type { Transition } from "framer-motion";

/** 与 globals.css 的 --duration-* / --ease-soft 同源 */
export const MOTION = {
  fast: 0.16,
  base: 0.2,
  slow: 0.24,
  /** 柔和收尾，无回弹 —— 禁 bounce 是产品级硬约束 */
  easeSoft: [0.32, 0.72, 0, 1] as [number, number, number, number],
} as const;

/** 与 globals.css 的 --radius-* 同源 */
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 18,
} as const;

/** 位移距离：降级模式下由 CSS 变量 --motion-shift 归零，这里读同一个变量 */
export const MOTION_SHIFT_CSS_VAR = "--motion-shift";

export const transitionBase: Transition = {
  duration: MOTION.base,
  ease: MOTION.easeSoft,
};

/** 只允许平移 / 缩放 / 淡入 —— 禁 3D transform，禁 will-change（微信内核会白屏） */
export const fadeInUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: transitionBase,
} as const;
