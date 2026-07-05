import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  // 启用类型声明生成：dist/index.d.ts
  // package.json 的 "types" 字段指向 ./dist/index.d.ts，必须产出该文件
  // 否则消费者无法获得 TypeScript 类型提示
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: [/^node:/, "openclaw", "neo4j-driver", "@modelcontextprotocol/sdk", "zod"],
});