import { defineConfig } from "vitest/config";

// v2.3.5: smoke test 独立配置
// 与主配置区别：不排除 smoke.test.ts，超时更长（真实 Neo4j 操作）
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    include: ["test/smoke.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "lcm-graph-extra/**"],
  },
});
