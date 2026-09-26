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
  // 关闭代码分割（构建产物必须自包含）——宿主（openclaw）加载插件时按「源目录捕获」逐个文件
  //   惰性物化到 plugin-captures/.../package-N/node_modules/<pkg>/ 下：入口文件先复制，
  //   其余文件在该运行时真正 import 时才按需从源目录再复制。
  //   开启分割时 dist 会产出 40+ 个内容哈希命名的兄弟 chunk（如 recall-NXFO5YHD.js），
  //   一旦捕获与 rebuild 竞争（clean 先删 dist、写入尚未完成，或源目录已被下一次构建替换），
  //   入口里写死的 chunk 名就在捕获目录中不存在 → ERR_MODULE_NOT_FOUND（Recaller/API server
  //   等动态 import 处报错），且报错点分散、与业务逻辑无关。
  //   关闭后产物为单文件 dist/index.js：入口不依赖任何兄弟 .js，捕获不可能丢文件。
  //   本插件只有一个入口，原本也不存在跨入口去重的收益。
  splitting: false,
  target: "es2022",
  external: [/^node:/, "openclaw", "neo4j-driver", "@modelcontextprotocol/sdk", "zod"],
});