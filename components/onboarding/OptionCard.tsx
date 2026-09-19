"use client";

/**
 * 可点卡片（选项 / 词卡都用它）
 *
 * 三条硬约束落实在这里：
 *   - **不写死颜色**：只用 bg-surface / border-subtle / text-primary 这类语义类名
 *   - **不 bounce**：按下时只做 scale(0.99) 的轻微内收，不走回弹曲线
 *   - **只动 transform / border-color / background-color**：不碰 3D、不用 will-change
 *
 * 无障碍：用原生 <button>，键盘与读屏器都能直接用；选中态不只靠颜色，
 * 还有一圈加粗描边 + 一个文字标记（色弱用户也分辨得出）。
 */
interface OptionCardProps {
  label: string;
  hint?: string;
  /** 多选场景下的选中态 */
  selected?: boolean;
  /** 灰掉但仍可见（例如"暂未收录"的目标） */
  muted?: boolean;
  onClick: () => void;
}

export function OptionCard({ label, hint, selected = false, muted = false, onClick }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "group flex w-full items-start justify-between gap-3 rounded-md border px-4 py-3.5 text-left",
        "transition-[background-color,border-color,transform] duration-200 ease-soft",
        "active:scale-[0.99]",
        selected
          ? "border-brand-600 bg-brand-50"
          : "border-subtle bg-surface hover:border-strong",
        muted && !selected ? "opacity-70" : "",
      ].join(" ")}
    >
      <span className="min-w-0">
        <span className="text-primary block text-sm leading-snug">{label}</span>
        {hint ? <span className="text-tertiary mt-1 block text-xs leading-snug">{hint}</span> : null}
      </span>

      {/* 选中标记：一个字符，不用 emoji、不用图标库 */}
      <span
        aria-hidden
        className={`mt-0.5 shrink-0 text-xs leading-none ${selected ? "text-brand-600" : "text-tertiary opacity-0"}`}
      >
        {selected ? "已选" : "—"}
      </span>
    </button>
  );
}
