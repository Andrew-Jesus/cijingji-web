import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // 备用产物目录（`NEXT_DIST_DIR=.next-b3`，见 next.config.ts）。
    // **必须显式加这两条**：上面那条只认 `.next` 这个名字，
    // 换个目录名之后 eslint 会把几百个构建出来的 JS 当成源码扫，
    // 于是 `npm run lint` 从"0 警告"变成"8000 多个问题" —— 而代码一行没改。
    ".next*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
