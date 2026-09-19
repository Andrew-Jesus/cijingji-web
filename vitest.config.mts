import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 单测配置。
 *
 * 只测纯函数（无 IO、无网络、无浏览器）—— 项目硬约束：resolveScope / buildDailyPlan /
 * mergeProfile 必须可单测。`npm run test` 全绿是每次交付的闸门。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "."),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
