/**
 * graph-memory-pro — benchmark 数据库隔离（v2.9.0）
 *
 * 背景（断链修复）：benchmark 物理切库链路此前四层断裂，数据全落生产库：
 *   1. CLI 进程从不调用 setCachedEdition → withDatabase 闸门恒关，静默跳过切库
 *   2. cfg.benchmark.database / cfg.neo4j.database 实际为 "" 空串，
 *      `?? "neo4j"` 不兜空串 → 目标库名解析为 ""
 *   3. 无自动 CREATE DATABASE → 目标库不存在
 *   4. MCP gm_benchmark 路径未包 withDatabase
 *
 * 本模块统一「benchmark 目标库名」的解析逻辑（CLI 与 MCP 共用），
 * 修复断链②：空串/缺失一律回落到默认隔离库名 "benchmarks"。
 */

import type { GmConfig } from "../types.ts";

/** 默认隔离库名（未显式配置 benchmark.database 时使用） */
export const DEFAULT_BENCHMARK_DATABASE = "benchmarks";

/**
 * 解析 benchmark 应使用的目标数据库名。
 *
 * 优先级：cfg.benchmark.database → cfg.neo4j.database → "benchmarks"。
 * 空串视为未配置（与 `||` 语义一致，区别于 `??` 只兜 null/undefined）。
 */
export function resolveBenchmarkDatabase(cfg: GmConfig): string {
  return (
    cfg.benchmark?.database ||
    cfg.neo4j?.database ||
    DEFAULT_BENCHMARK_DATABASE
  );
}
