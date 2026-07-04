import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // 排除针对旧 SQLite 实现的失效测试文件（与当前 Neo4j 代码不兼容）
    // 这些文件待后续重写为 Neo4j 版本后可移除排除
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // 旧 SQLite 版测试（基于 @photostructure/sqlite，与当前 Neo4j 实现脱节）
      "test/helpers.ts",
      "test/store.test.ts",
      "test/graph.test.ts",
      "test/extract.test.ts",
      "test/assemble.test.ts",
      "test/recall-community.test.ts",
    ],
  },
});
