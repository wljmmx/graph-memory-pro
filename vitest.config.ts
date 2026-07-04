import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // 排除 lcm-graph-extra 子目录（有独立测试套件，由其自身 CI 运行）
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "lcm-graph-extra/**",
    ],
  },
});
