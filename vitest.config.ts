import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // 排除 lcm-graph-extra 子目录（有独立测试套件，由其自身 CI 运行）
    // v2.3.5: 排除 smoke test（需要真实 Neo4j，由 test:smoke 单独运行）
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "lcm-graph-extra/**",
      "**/test/smoke.test.ts",
    ],
  },
});
