/**
 * graph-memory-pro — 社区检测 (Neo4j GDS)
 *
 * 替代原版手写的 Label Propagation 算法
 * 使用 GDS gds.labelPropagation
 * 所有操作使用原生 Cypher，无 APOC 依赖
 */

import type { Driver } from "neo4j-driver";
import { getSession } from "../store/db.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { updateCommunities, upsertCommunitySummary, pruneCommunitySummaries } from "../store/store.ts";

// v2.1.2: 新增 CAUSED_BY / LEADS_TO 因果边类型
const ALL_REL_TYPES = ["NEXT_SESSION", "CONTAINS", "MENTIONS", "USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH", "RELATES_TO", "CAUSED_BY", "LEADS_TO"];

async function getExistingRelTypes(session: any): Promise<string[]> {
  const result = await session.run(`
    MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS t
  `, { types: ALL_REL_TYPES });
  return result.records.map((r: any) => r.get("t"));
}

function buildRelProjection(existingTypes: string[]): string {
  if (existingTypes.length === 0) return "'*'";
  const parts = existingTypes.map(t => `${t}: {orientation: 'UNDIRECTED'}`);
  return `{${parts.join(", ")}}`;
}

export interface CommunityResult {
  labels: Map<string, string>;
  communities: Map<string, string[]>;
  count: number;
}

export async function detectCommunities(driver: Driver, maxIter = 50): Promise<CommunityResult> {
  const session = getSession(driver);
  const graphName = `gm-community-${Date.now()}`;

  try {
    const countResult = await session.run(
      "MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c"
    );
    const nodeCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (nodeCount === 0) {
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    const relProjection = buildRelProjection(existingTypes);
    await session.run(
      `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
    );

    const lpResult = await session.run(`
      CALL gds.labelPropagation.stream('${graphName}', {
        maxIterations: toInteger($maxIter)
      })
      YIELD nodeId, communityId
      WITH gds.util.asNode(nodeId) AS node, communityId
      WHERE node.status = 'active'
      RETURN node.id AS id, toString(communityId) AS rawCommunityId
    `, { maxIter });

    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}

    const rawLabels = new Map<string, string>();
    const rawCommunities = new Map<string, string[]>();

    for (const r of lpResult.records) {
      const nodeId = r.get("id");
      const rawCid = r.get("rawCommunityId");
      rawLabels.set(nodeId, rawCid);
      if (!rawCommunities.has(rawCid)) rawCommunities.set(rawCid, []);
      rawCommunities.get(rawCid)!.push(nodeId);
    }

    const sorted = Array.from(rawCommunities.entries())
      .sort((a, b) => b[1].length - a[1].length);

    const renameMap = new Map<string, string>();
    sorted.forEach(([oldId], i) => renameMap.set(oldId, `c-${i + 1}`));

    const finalLabels = new Map<string, string>();
    for (const [nodeId, oldLabel] of rawLabels) {
      finalLabels.set(nodeId, renameMap.get(oldLabel) || oldLabel);
    }

    const finalCommunities = new Map<string, string[]>();
    for (const [oldId, members] of rawCommunities) {
      finalCommunities.set(renameMap.get(oldId) || oldId, members);
    }

    await updateCommunities(driver, finalLabels);

    return {
      labels: finalLabels,
      communities: finalCommunities,
      count: finalCommunities.size,
    };
  } catch (err) {
    try { await session.run("CALL gds.graph.drop($graphName)", { graphName }); } catch {}
    return { labels: new Map(), communities: new Map(), count: 0 };
  } finally {
    await session.close();
  }
}

export async function getCommunityPeers(driver: Driver, nodeId: string, limit = 5): Promise<string[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {id: $nodeId, status: 'active'})
      WITH n.communityId AS cid
      WHERE cid IS NOT NULL
      MATCH (peer:Task|Skill|Event {communityId: cid, status: 'active'})
      WHERE peer.id <> $nodeId
      RETURN peer.id AS id
      ORDER BY peer.validatedCount DESC, peer.updatedAt DESC
      LIMIT toInteger($limit)
    `, { nodeId, limit });
    return result.records.map(r => r.get("id"));
  } finally {
    await session.close();
  }
}

// ── S-4 层次化社区（v2.1.2 第四批）─────────────────────────────

/**
 * 层次化社区层次结构
 *
 * - level 1: 原始社区（社区→节点）
 * - level 2: 主题（主题→社区）
 * - level 3: 领域（领域→主题）
 *
 * 节点字段：
 *   - communityId:   level 1 社区 id（已有）
 *   - topicId:       level 2 主题 id（S-4 新增）
 *   - domainId:      level 3 领域 id（S-4 新增）
 */
export interface HierarchicalCommunityResult {
  /** 各层次的 communityId 映射（key = 节点 id, value = {level1, level2, level3}） */
  hierarchy: Map<string, { level1: string; level2?: string; level3?: string }>;
  /** 各层次社区数 */
  level1Count: number;
  level2Count: number;
  level3Count: number;
  /** 层次关系：上层 id → 下层 id 列表 */
  level2ToLevel1: Map<string, string[]>;
  level3ToLevel2: Map<string, string[]>;
}

/**
 * 检测层次化社区
 *
 * 算法：自底向上
 *   - Level 1: 调用 detectCommunities 得到原始社区
 *   - Level 2: 每个社区的 PageRank 最高节点作为"代表"，对代表节点跑 Label Propagation
 *   - Level 3: 对 level 2 的代表再跑一次（depth=3 时）
 *
 * @param driver Neo4j driver
 * @param depth 层次深度（1=单层, 2=社区+主题, 3=社区+主题+领域，默认 3）
 */
export async function detectHierarchicalCommunities(
  driver: Driver,
  depth: number = 3,
): Promise<HierarchicalCommunityResult> {
  // Level 1: 原始社区检测
  const level1 = await detectCommunities(driver);

  const hierarchy = new Map<string, { level1: string; level2?: string; level3?: string }>();
  for (const [nodeId, cid] of level1.labels) {
    hierarchy.set(nodeId, { level1: cid });
  }

  const level2ToLevel1 = new Map<string, string[]>();
  const level3ToLevel2 = new Map<string, string[]>();

  let level2Count = 0;
  let level3Count = 0;

  // Level 2: 社区代表节点的聚类（→ 主题）
  if (depth >= 2 && level1.communities.size > 1) {
    const level2Result = await clusterRepresentatives(driver, level1.communities);
    level2Count = level2Result.communities.size;

    // 写入 topicId 到节点 + 层次映射
    for (const [nodeId, cid] of level1.labels) {
      const topicId = level2Result.labels.get(cid);
      if (topicId && hierarchy.has(nodeId)) {
        hierarchy.get(nodeId)!.level2 = topicId;
      }
    }

    // 建立 level2 → level1 关系
    for (const [topicId, memberCids] of level2Result.communities) {
      level2ToLevel1.set(topicId, memberCids);
    }

    // 将 topicId 写入 Neo4j 节点
    await updateHierarchicalFields(driver, hierarchy, "topicId");

    // Level 3: 主题代表的聚类（→ 领域）
    if (depth >= 3 && level2Result.communities.size > 1) {
      const level3Result = await clusterRepresentatives(driver, level2Result.communities);
      level3Count = level3Result.communities.size;

      // 建立 level3 → level2 关系 + 写入 domainId
      for (const [domainId, memberTopics] of level3Result.communities) {
        level3ToLevel2.set(domainId, memberTopics);
        // 把 domainId 写到所有属于该领域的节点
        for (const topicId of memberTopics) {
          for (const [nodeId, h] of hierarchy) {
            if (h.level2 === topicId) {
              h.level3 = domainId;
            }
          }
        }
      }
      await updateHierarchicalFields(driver, hierarchy, "domainId");
    }
  }

  return {
    hierarchy,
    level1Count: level1.count,
    level2Count,
    level3Count,
    level2ToLevel1,
    level3ToLevel2,
  };
}

/**
 * 对一组"代表节点"（每个社区的代表）运行 Label Propagation
 *
 * 策略：代表节点间的连接通过其原社区成员之间的边权重之和度量。
 * 简化方案：直接用原社区 id 作为虚拟节点，社区间共现边作为连接。
 *
 * @param driver Neo4j driver
 * @param communities 下层社区（key = 下层社区 id, value = 成员节点 id 列表）
 */
async function clusterRepresentatives(
  driver: Driver,
  communities: Map<string, string[]>,
): Promise<{ labels: Map<string, string>; communities: Map<string, string[]> }> {
  if (communities.size === 0) {
    return { labels: new Map(), communities: new Map() };
  }

  const session = getSession(driver);
  try {
    // 简化策略：基于社区成员间的实际边构建社区共现图
    // 对每对社区，统计成员之间的边数作为权重
    // 然后用简单的聚类：按共现权重最高的邻居归并

    // 收集所有社区成员
    const allMembers: string[] = [];
    const memberToCommunity = new Map<string, string>();
    for (const [cid, members] of communities) {
      for (const m of members) {
        allMembers.push(m);
        memberToCommunity.set(m, cid);
      }
    }

    if (allMembers.length === 0) {
      return { labels: new Map(), communities: new Map() };
    }

    // 查询跨社区的边，统计社区对的共现权重
    const edgeResult = await session.run(
      `MATCH (a:Task|Skill|Event {status: 'active'})-[r]->(b:Task|Skill|Event {status: 'active'})
       WHERE a.id IN $members AND b.id IN $members
         AND NOT type(r) IN ['NEXT_SESSION', 'CONTAINS', 'MENTIONS']
       RETURN a.id AS fromId, b.id AS toId, r.weight AS weight`,
      { members: allMembers },
    );

    // 构建社区共现权重矩阵
    const communityWeights = new Map<string, Map<string, number>>();
    for (const rec of edgeResult.records) {
      const fromId = rec.get("fromId");
      const toId = rec.get("toId");
      const weight = rec.get("weight")?.toNumber?.() ?? 1;

      const fromCid = memberToCommunity.get(fromId);
      const toCid = memberToCommunity.get(toId);
      if (!fromCid || !toCid || fromCid === toCid) continue;

      if (!communityWeights.has(fromCid)) communityWeights.set(fromCid, new Map());
      if (!communityWeights.has(toCid)) communityWeights.set(toCid, new Map());

      const fromMap = communityWeights.get(fromCid)!;
      fromMap.set(toCid, (fromMap.get(toCid) ?? 0) + weight);
      const toMap = communityWeights.get(toCid)!;
      toMap.set(fromCid, (toMap.get(fromCid) ?? 0) + weight);
    }

    // 简单聚类：每个社区归并到共现权重最高的邻居（贪心）
    // 目标社区数 ≈ sqrt(下层社区数)，避免过度归并
    const targetCount = Math.max(1, Math.floor(Math.sqrt(communities.size)));
    const labels = new Map<string, string>();

    // 初始化：每个社区自成一簇
    for (const cid of communities.keys()) {
      labels.set(cid, cid);
    }

    // 贪心合并：按权重排序，合并最强的边直到达到目标数
    const edges: Array<{ a: string; b: string; w: number }> = [];
    for (const [a, neighbors] of communityWeights) {
      for (const [b, w] of neighbors) {
        if (a < b) edges.push({ a, b, w });
      }
    }
    edges.sort((x, y) => y.w - x.w);

    // Union-Find
    const parent = new Map<string, string>();
    for (const cid of communities.keys()) parent.set(cid, cid);
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    let currentClusters = communities.size;
    for (const { a, b } of edges) {
      if (currentClusters <= targetCount) break;
      if (find(a) !== find(b)) {
        union(a, b);
        currentClusters--;
      }
    }

    // 重命名簇
    const rootToNewId = new Map<string, string>();
    let clusterIdx = 0;
    for (const cid of communities.keys()) {
      const root = find(cid);
      if (!rootToNewId.has(root)) {
        clusterIdx++;
        rootToNewId.set(root, `h-${clusterIdx}`);
      }
      labels.set(cid, rootToNewId.get(root)!);
    }

    // 构建层次映射
    const resultCommunities = new Map<string, string[]>();
    for (const [cid, label] of labels) {
      if (!resultCommunities.has(label)) resultCommunities.set(label, []);
      resultCommunities.get(label)!.push(cid);
    }

    return { labels, communities: resultCommunities };
  } finally {
    await session.close();
  }
}

/**
 * 将层次化字段（topicId / domainId）写入节点
 */
async function updateHierarchicalFields(
  driver: Driver,
  hierarchy: Map<string, { level1: string; level2?: string; level3?: string }>,
  field: "topicId" | "domainId",
): Promise<void> {
  const session = getSession(driver);
  try {
    // 批量更新：按层次值分组
    const groups = new Map<string, string[]>();
    for (const [nodeId, h] of hierarchy) {
      const value = field === "topicId" ? h.level2 : h.level3;
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value)!.push(nodeId);
    }

    for (const [value, nodeIds] of groups) {
      // 分批处理避免参数过长
      const batchSize = 500;
      for (let i = 0; i < nodeIds.length; i += batchSize) {
        const batch = nodeIds.slice(i, i + batchSize);
        await session.run(
          `MATCH (n:Task|Skill|Event) WHERE n.id IN $ids
           SET n.${field} = $value`,
          { ids: batch, value },
        );
      }
    }
  } finally {
    await session.close();
  }
}

/**
 * 自顶向下钻取：给定领域/主题 id，返回所有底层节点
 *
 * 用于召回时的层次化导航
 */
export async function drillDownCommunity(
  driver: Driver,
  opts: { domainId?: string; topicId?: string; communityId?: string },
): Promise<string[]> {
  const session = getSession(driver);
  try {
    let query: string;
    let params: any = {};

    if (opts.domainId) {
      query = `MATCH (n:Task|Skill|Event {status: 'active', domainId: $domainId})
               RETURN n.id AS id`;
      params = { domainId: opts.domainId };
    } else if (opts.topicId) {
      query = `MATCH (n:Task|Skill|Event {status: 'active', topicId: $topicId})
               RETURN n.id AS id`;
      params = { topicId: opts.topicId };
    } else if (opts.communityId) {
      query = `MATCH (n:Task|Skill|Event {status: 'active', communityId: $communityId})
               RETURN n.id AS id`;
      params = { communityId: opts.communityId };
    } else {
      return [];
    }

    const result = await session.run(query, params);
    return result.records.map(r => r.get("id"));
  } finally {
    await session.close();
  }
}

const COMMUNITY_SUMMARY_SYS = `你是知识图谱社区摘要引擎。根据社区内的节点列表，生成一句话描述该社区的主题领域。
要求：
- 只返回一句话，不超过 30 个字
- 描述该社区涵盖的工具/技术/任务领域
- 不要使用"社区"这个词
- 不要加引号或标点以外的格式`;

export async function summarizeCommunities(
  driver: Driver,
  communities: Map<string, string[]>,
  llm: CompleteFn,
  embedFn?: EmbedFn,
): Promise<number> {
  await pruneCommunitySummaries(driver);
  let generated = 0;

  for (const [communityId, memberIds] of communities) {
    if (memberIds.length === 0) continue;

    const session = getSession(driver);
    let members: any[];
    try {
      const result = await session.run(`
        MATCH (n:Task|Skill|Event {status: 'active'})
        WHERE n.id IN $memberIds
        RETURN n.name AS name, n.type AS type, n.description AS description
        ORDER BY n.validatedCount DESC
        LIMIT 10
      `, { memberIds });
      members = result.records.map(r => ({
        name: r.get("name"),
        type: r.get("type"),
        description: r.get("description"),
      }));
    } finally {
      await session.close();
    }

    if (members.length === 0) continue;

    const memberText = members
      .map(m => `${m.type}:${m.name} — ${m.description}`)
      .join("\n");

    try {
      const summary = await llm(COMMUNITY_SUMMARY_SYS, `社区成员：\n${memberText}`);
      const cleaned = summary.trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*/gi, "")
        .replace(/^["'「」]|["'「」]$/g, "")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 100);

      if (cleaned.length === 0) continue;

      let embedding: number[] | undefined;
      if (embedFn) {
        try {
          const embedText = `${cleaned}\n${members.map(m => m.name).join(", ")}`;
          embedding = await embedFn(embedText);
        } catch (err) {
          console.warn(`[graph-memory-pro] community embedding failed for ${communityId}: ${err}`);
        }
      }

      await upsertCommunitySummary(driver, communityId, cleaned, memberIds.length, embedding);
      generated++;
    } catch (err) {
      console.warn(`[graph-memory-pro] community summary failed for ${communityId}: ${err}`);
    }
  }

  return generated;
}
