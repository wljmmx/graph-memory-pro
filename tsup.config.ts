import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: [/^node:/, "openclaw", "neo4j-driver", "@modelcontextprotocol/sdk", "zod"],
});