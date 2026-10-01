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
    // `public/` 里放的是**原样发给浏览器的文件**，不是源码。
    //   · `sw.js` 是 Service Worker —— 跑在浏览器的另一个执行环境里，
    //     那里的 `self` / `caches` / `clients` 对 ESLint 来说全是"未定义变量"，
    //     给它配一套 globals 只会制造噪音；它真正的护栏是
    //     `lib/pwa/swContract.test.ts` 那组契约测试。
    //   · `offline.html` 是自己管自己的兜底页（连样式都不许外引）。
    "public/**",
  ]),
]);

export default eslintConfig;
