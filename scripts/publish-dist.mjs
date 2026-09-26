#!/usr/bin/env node
// 原子发布 dist：本次构建先完整落在 dist.staging，构建成功后再整体替换 dist。
//
// 动机：宿主（openclaw）按「源目录捕获 + 惰性物化」加载插件，可能在任意时刻读取 dist/。
//   原先 tsup 直接对 dist 做 clean + 写入：clean 会先删空 dist，随后数秒（dts 生成）的构建期内
//   dist/index.js 缺失或处于半写状态 —— 此时捕获到的入口就是空/半截的。
//   改为「先完整构建到 dist.staging，再用两次 rename 替换」后，dist 仅在两次 rename 之间有
//   极短（微秒级）空窗，相对整个构建时长（秒级）大幅收窄。
//
// 诚实说明：POSIX 无法对非空目录做单次原子替换（renameat2 RENAME_EXCHANGE 不可移植），
//   因此这里把空窗从「秒级」压缩到「微秒级」，而非彻底消除。彻底消除需要宿主侧原子物化保证。

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, "dist.staging");
const dist = join(root, "dist");
const previous = join(root, "dist.old");

if (!existsSync(staging)) {
  console.error("[publish-dist] 未找到 dist.staging（构建未成功？），放弃发布以保留现有 dist");
  process.exit(1);
}

rmSync(previous, { recursive: true, force: true });
// 两次 rename 之间是唯一的空窗；不可用「先删 dist 再 rename」——那会把空窗重新拉长。
if (existsSync(dist)) renameSync(dist, previous);
renameSync(staging, dist);
rmSync(previous, { recursive: true, force: true });

console.log("[publish-dist] dist 已替换为本次构建产物");