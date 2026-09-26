#!/usr/bin/env node
// 构建产物自包含门禁（CI / Release 阻断步骤）
//
// 背景：openclaw 宿主按「源目录捕获 + 惰性物化」加载插件——先把入口 dist/index.js 复制到
//   plugin-captures/.../dist/ 下，其余文件在运行时真正 import 时才按需从源目录再复制。
//   一旦入口引用了兄弟产物（如代码分割产生的 40+ 个内容哈希 chunk，例如 recall-NXFO5YHD.js），
//   捕获与 rebuild 竞争时该兄弟文件就可能未落地 → ERR_MODULE_NOT_FOUND，且报错点分散、
//   表现为「Recaller init failed」「API server start failed」等与业务逻辑无关的故障。
//
// 本脚本把「产物必须自包含」从一次性的构建配置约定，升级为可阻断的构建期不变式，断言三件事：
//   1. 清单声明的入口 dist/index.js 存在；
//   2. dist 内 JS 产物有且仅有该入口一个（不存在任何兄弟 chunk / 孤儿产物）；
//   3. 入口内不存在相对模块引用（"./x" / "../x"），因为相对目标同样可能被捕获遗漏。
//
// 任一条不满足即非零退出。故意把 tsup 的 splitting 改回 true 时，本步骤必须变红。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JS_FAMILY = new Set([".js", ".mjs", ".cjs"]);

// 相对模块引用：静态 import / export ... from / 副作用 import / 动态 import()
// 只关心以 ./ 或 ../ 开头的 specifier，裸模块名（openclaw、node:fs 等）不在本门禁范围。
const RELATIVE_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n[verify-dist] ✗ ${message}\n`);
  process.exit(1);
}

function walkJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (JS_FAMILY.has(full.slice(full.lastIndexOf(".")))) {
      out.push(full);
    }
  }
  return out;
}

// 入口以 package.json 的 openclaw.extensions 为准，避免脚本与清单漂移。
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = pkg?.openclaw?.extensions ?? [];
const entryRel = declared[0]?.replace(/^\.\//, "");
if (!entryRel) {
  fail("package.json 未声明 openclaw.extensions[0]，无法确定插件入口");
}
const entryPath = join(root, entryRel);
const distDir = dirname(entryPath);

// 断言 1：入口存在
if (!existsSync(entryPath)) {
  fail(`清单声明的入口不存在：${entryRel}（请先执行 npm run build）`);
}

// 断言 2：dist 内 JS 产物有且仅有入口一个
const jsFiles = walkJsFiles(distDir);
const extra = jsFiles.filter((f) => f !== entryPath);
if (extra.length > 0) {
  fail(
    `dist 内存在入口之外的 JS 产物，说明代码分割/多入口被重新启用，\n` +
      `  宿主捕获可能遗漏这些文件并触发 ERR_MODULE_NOT_FOUND：\n` +
      extra.map((f) => `    - ${relative(root, f)}`).join("\n"),
  );
}

// 断言 3：入口不含相对模块引用
const src = readFileSync(entryPath, "utf8");
const relatives = [];
for (const match of src.matchAll(RELATIVE_SPECIFIER_RE)) {
  const spec = match[2];
  if (spec.startsWith("./") || spec.startsWith("../")) relatives.push(spec);
}
if (relatives.length > 0) {
  const detail = [...new Set(relatives)]
    .map((spec) => {
      const target = resolve(dirname(entryPath), spec);
      const state = existsSync(target) ? "存在（但宿主捕获仍可能遗漏）" : "缺失 → 必然 ERR_MODULE_NOT_FOUND";
      return `    - ${spec}  [${state}]`;
    })
    .join("\n");
  fail(`入口 ${entryRel} 引用了相对模块，破坏自包含不变式：\n${detail}`);
}

console.log(`[verify-dist] ✓ ${entryRel} 自包含（单文件、无相对模块引用）`);