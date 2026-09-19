/**
 * 进度条（分段式）
 *
 * 为什么用分段而不是连续进度条：21 道题里"走到第 7 题"比"完成 33%"更好读，
 * 而且碎片本身给了一种"在往前走"的推进感 —— 这是引导流程里最便宜的正反馈。
 *
 * 只用语义类名（bg-brand-600 / bg-strong），不写死颜色。
 */
interface StepProgressProps {
  /** 已完成/当前进行到第几段，从 1 开始 */
  current: number;
  total: number;
  /** 右侧文字，如 "第 7 / 20" */
  label?: string;
}

export function StepProgress({ current, total, label }: StepProgressProps) {
  const safeTotal = Math.max(total, 1);
  const safeCurrent = Math.min(Math.max(current, 0), safeTotal);

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex flex-1 items-center gap-1"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={safeTotal}
        aria-valuenow={safeCurrent}
        aria-label={`第 ${safeCurrent} 步，共 ${safeTotal} 步`}
      >
        {Array.from({ length: safeTotal }, (_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${i < safeCurrent ? "bg-brand-600" : "bg-strong"}`}
          />
        ))}
      </div>
      {label ? <span className="text-tertiary shrink-0 text-xs tabular-nums">{label}</span> : null}
    </div>
  );
}
