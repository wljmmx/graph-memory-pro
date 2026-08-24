/**
 * graph-memory-pro v2.6.x — store/community.ts 社区向量索引缺失降级 + 自愈触发
 *
 * 背景：gm_community_embedding 索引创建曾用已被 Neo4j 2026.x 移除的过程化 API，
 * 失败被静默吞掉 → 索引缺失 → communityVectorSearch* 每轮抛
 * "There is no such vector schema index: gm_community_embedding" → recall-generalized 全挂。
 * 修复后：索引缺失时优雅降级返回空数组（不抛错），非缺失错误照常抛出。
 */

import { describe, it, expect } from "vitest";
import {
  communityVectorSearch,
  communityVectorSearchWithReps,
} from "../src/store/community.ts";
import { mockDriver } from "./helpers/neo4j-mock.ts";

const MISSING_INDEX_ERR = new Error(
  "Neo4jError: Failed to invoke procedure `db.index.vector.queryNodes`: " +
  "Caused by: java.lang.IllegalArgumentException: There is no such vector schema index: gm_community_embedding",
);

function makeThrowingSession(driver: ReturnType<typeof mockDriver>, err: Error): void {
  const session = driver.session() as unknown as { run: (...a: unknown[]) => Promise<never> };
  session.run = async () => { throw err; };
}

describe("communityVectorSearchWithReps 索引缺失降级 (v2.6.x)", () => {
  it("索引缺失 → 返回空数组而非抛错", async () => {
    const driver = mockDriver();
    makeThrowingSession(driver, MISSING_INDEX_ERR);
    const res = await communityVectorSearchWithReps(driver as never, [1, 2, 3], 3);
    expect(res).toEqual([]);
  });

  it("非索引缺失错误 → 照常抛出", async () => {
    const driver = mockDriver();
    makeThrowingSession(driver, new Error("connection refused"));
    await expect(
      communityVectorSearchWithReps(driver as never, [1, 2, 3], 3),
    ).rejects.toThrow("connection refused");
  });
});

describe("communityVectorSearch 索引缺失降级 (v2.6.x)", () => {
  it("索引缺失 → 返回空数组而非抛错", async () => {
    const driver = mockDriver();
    makeThrowingSession(driver, MISSING_INDEX_ERR);
    const res = await communityVectorSearch(driver as never, [1, 2, 3]);
    expect(res).toEqual([]);
  });

  it("非索引缺失错误 → 照常抛出", async () => {
    const driver = mockDriver();
    makeThrowingSession(driver, new Error("boom"));
    await expect(
      communityVectorSearch(driver as never, [1, 2, 3]),
    ).rejects.toThrow("boom");
  });
});
