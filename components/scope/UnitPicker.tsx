"use client";

/**
 * 「选我的单元」—— 手机底部的选择抽屉。
 *
 * ── 为什么是手写的，不是 shadcn 的 Sheet / Dialog ──────────────
 * 项目没装 Radix（见 components/ 目录：全是手写组件）。为这一个抽屉
 * 拖进一整套原语 + 依赖，不划算；这里要的东西很有限：
 * 遮罩、从下往上入场、Esc 关闭、把焦点收进来。四条，各几行。
 *
 * ── 入口放在哪（Andy 2026-10-02 拍板 = 方案①）────────────────
 * **首页「今天从这些开始」那一行本身可点**。理由：改动最小，
 * 也最贴真实动作（"我今天想背 Unit 3"），不用去翻设置页。
 *
 * ── 2026-10-02 改版：从「一本书的 6 个单元」改成「按册分组」──────
 * 八下 / 九上进来之后，抽屉里要同时容纳 3 册 × 6 单元 = 18 行。
 * 平铺 18 行用户找不到自己在哪，所以**按册分组**：
 * 每组一个小标题（「八年级下册」），组内仍是单元行。
 * 组的顺序由数据层的册次顺序决定（年级升序、同年级上册在前），
 * 组件自己**不排序** —— 排序口径只允许有一处。
 *
 * ── 视觉语言 ────────────────────────────────────────────────
 * 借既有的一套，不另起：暖白 surface 托盘 + shadow-float（浮在内容之上的
 * 元素才允许投影）+ 全站唯一那条 rise-in 入场（于是"减少动态效果"的降级白拿）。
 * 选中行用暖砂底衬（bg-feature）—— 与首页主卡同一个"被托着"的语义，
 * 不用冷色（brand-50）去标选中，那会在暖白页面上发青。
 */

import { useEffect, useRef } from "react";

export interface UnitOption {
  id: string;
  /** 已经是给人看的完整名，如「八上 Unit 1 · This is me」 */
  label: string;
  /** 该单元一共有多少词（与选中后首页显示的口径一致） */
  count: number;
}

/** 一本书 = 一组。产品里有几册书就有几组 */
export interface UnitGroup {
  id: string;
  /** 册次的显示名，如「八年级下册」—— 与课本封面/目录上的叫法一致 */
  title: string;
  options: UnitOption[];
}

interface UnitPickerProps {
  /** 顶部的说明：这是哪套书 */
  subtitle: string;
  groups: UnitGroup[];
  /** 当前选中的那个单元 */
  currentId: string;
  onPick: (unitId: string) => void;
  onClose: () => void;
}

export function UnitPicker({ subtitle, groups, currentId, onPick, onClose }: UnitPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // 展开就把焦点收进面板 —— 键盘用户按 Esc 才能生效（不然焦点还留在那一行上）
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 抽屉开着时锁住身后的页面滚动 —— 否则在手机上滑动抽屉，背景会跟着一起滚
  // （遮罩只拦点击，拦不住滚轮与触摸）。卸载时把原值还回去，别留下副作用。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    // z-[60]：要压过常驻在左下角的小词（它是 z-50），否则球会戳在遮罩上
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="选择单元"
    >
      {/* 遮罩：点它关闭。用 button 而不是 div —— 键盘用户也能按到 */}
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="bg-primary/35 absolute inset-0 cursor-default"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        data-animated
        className="bg-surface shadow-float relative max-h-[75vh] w-full max-w-md overflow-y-auto rounded-t-xl px-5 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))] outline-none"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-tertiary text-[11px] tracking-[0.08em]">从哪个单元开始</p>
          <button
            type="button"
            onClick={onClose}
            className="text-tertiary hover:text-secondary -mr-1 rounded-sm px-1.5 py-0.5 text-[11px] transition-colors"
          >
            关闭
          </button>
        </div>

        <p className="text-secondary mt-2 text-xs leading-relaxed">{subtitle}</p>

        {groups.map((group) => (
          <div key={group.id}>
            {/* 册次小标题。`sticky top-0` 让它在往下滚时贴住抽屉顶部 ——
                18 行的情况下，滚到第九行还能知道自己在哪本书里。
                底色必须是 surface（与抽屉同色）并补一段纵向内边距，
                否则滚动的文字会从它上下两边的缝里透出来。 */}
            <p className="bg-surface text-tertiary sticky top-0 z-10 mt-4 py-2 text-[11px] tracking-[0.08em]">
              {group.title}
            </p>
            <ul className="space-y-1">
              {group.options.map((option) => {
                const active = option.id === currentId;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => onPick(option.id)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-3 text-left transition-colors ${
                        active ? "bg-feature" : "hover:bg-sunken"
                      }`}
                    >
                      <span
                        className={`text-sm leading-snug ${active ? "text-primary font-medium" : "text-secondary"}`}
                      >
                        {option.label}
                      </span>
                      <span className="text-tertiary shrink-0 text-[11px] tabular-nums">
                        {option.count} 词
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* 说清这一下点了会发生什么 —— 它会换掉今天的任务单，用户有权先知道 */}
        <p className="text-tertiary mt-4 text-[11px] leading-relaxed">
          换一个单元会重新排今天的任务单。已经开始练的部分不会丢，只是今天要练的词换成新的这一批。
        </p>
      </div>
    </div>
  );
}
