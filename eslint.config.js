// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Graph Memory Pro ESLint flat config
 *
 * 设计原则：
 *   - 只对 src/ 与 index.ts 做类型检查增强
 *   - 测试文件放宽 no-explicit-any
 *   - 不阻塞现有代码风格，仅捕获真正风险
 *   - 与 CI lint job 配合（v2.3.0 起 lint 阻塞 CI）
 */
export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "benchmarks/data/**",
      "*.js",        // 根目录的配置文件（tsup.config.ts 等仍会被 lint）
      "actionlint",  // v2.2.2 已删除的二进制
    ],
  },

  // 基础规则
  eslint.configs.recommended,

  // TypeScript 推荐规则（非 type-checked，避免历史代码 976 个 unsafe-* 报错）
  // type-checked 模式可在未来代码清理后启用
  ...tseslint.configs.recommended,

  // 源码规则（src/ + index.ts）
  {
    files: ["src/**/*.ts", "index.ts"],
    rules: {
      // 允许 console（项目使用 createLogger，但 embed.ts 等诊断路径仍用 console.warn）
      "no-console": "off",
      // 允许空 catch 块（项目惯例：try { await x() } catch {} 表示有意忽略错误，
      // 如 session.close() 失败、可选依赖加载失败等。强制加注释反而增加噪声）
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 允许 any（项目历史代码含 any，渐进式收紧）
      "@typescript-eslint/no-explicit-any": "warn",
      // 允许非空断言（图算法中常见 n.id! 模式）
      "@typescript-eslint/no-non-null-assertion": "off",
      // 允许未使用变量以下划线开头（_cfg / _llm 等私有约定）
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // require() 用于动态加载 SDK 模块（如 require("./src/logger.ts")）
      // 这些路径需运行时解析，import() 异步加载会改变执行时序
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // 测试文件规则放宽
  {
    files: ["test/**/*.ts", "test/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  // 配置文件规则放宽
  {
    files: ["*.config.ts", "*.config.js", "vitest.config.ts", "tsup.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
