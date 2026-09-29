/**
 * v2.8.x — :GmMessage 写入路径审计与可选去重（安全优先）
 *
 * 用途：配合 index.ts `persistSessionMessages` 的修复上线前后使用。
 * 背景（已核实）：
 *   - 旧写端每轮 `agent_end` 重放全量 messages，`saveMessage` 是
 *     `MERGE {id} SET ... m.createdAt = $createdAt` → 每轮把整段历史的
 *     createdAt 刷成本轮时间（真实时间戳不可恢复）。
 *   - id 含位置分量 `turnIndex` → 历史被 compaction 改写后同一消息换 id，
 *     会产生重复行。
 *
 * 本工具**只做两件事**：
 *   1) audit（默认，只读）：量化重复行、createdAt 塌缩程度、id 方案分布、
 *      rebuildProcessedAt 覆盖情况，并给出修复前的基线。
 *   2) dedup（需显式 --apply）：删除「完全重复」的 :GmMessage 行，每组保留
 *      一行。**不重写任何 id**（原因见下），不触碰内容与时间戳。
 *
 * 为什么不做 id 迁移（重要）：
 *   :GmMessage.id 被**持久化引用**到磁盘队列文件里 ——
 *   src/store/messages.ts:201 记载队列条目结构为
 *   `{user, assistant, sessionKey?, id?|msgIds?}`，且 index.ts 会读取
 *   `item.msgIds` 回传给 markMessagesProcessed（按 id 精确标记）。
 *   其中 extract-queue.jsonl 由外部插件写入。**就地改写 m.id 会让这些
 *   已落盘的引用变成孤儿**，且无法回溯修复。因此正确做法是「新行用新键、
 *   旧行保持原样 + 写入端按内容去重防止重放」，而不是改历史 id。
 *
 * 用法：
 *   npx tsx scripts/gm-message-audit.ts                     # 只读审计（读默认配置）
 *   npx tsx scripts/gm-message-audit.ts --config <path>     # 指定 openclaw.json
 *   npx tsx scripts/gm-message-audit.ts --session <key>     # 只审计某个会话
 *   npx tsx scripts/gm-message-audit.ts --dedup             # 预览将删除哪些重复行
 *   npx tsx scripts/gm-message-audit.ts --dedup --apply     # 实际执行删除
 *
 * 退出码：0 = 正常；1 = 连接/参数错误。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface Args {
  config?: string;
  session?: string;
  dedup: boolean;
  apply: boolean;
  limit: number;
}

function getArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  return {
    config: getArg(argv, "config"),
    session: getArg(argv, "session"),
    dedup: argv.includes("--dedup"),
    apply: argv.includes("--apply"),
    limit: Math.max(1, Math.floor(Number(getArg(argv, "limit") ?? 200))),
  };
}

/** 解析 Neo4j 连接信息：--config > 环境变量 > ~/.openclaw/openclaw.json */
function resolveNeo4j(args: Args): { uri: string; user: string; password: string; database?: string } | null {
  const env = {
    uri: process.env.GM_NEO4J_URI,
    user: process.env.GM_NEO4J_USER,
    password: process.env.GM_NEO4J_PASSWORD,
  };
  if (env.uri && env.user && env.password) {
    return { uri: env.uri, user: env.user, password: env.password, database: process.env.GM_NEO4J_DATABASE };
  }
  const path = args.config ?? join(process.env.HOME || homedir(), ".openclaw", "openclaw.json");
  try {
    const root = JSON.parse(readFileSync(path, "utf-8")) as {
      plugins?: { entries?: Record<string, { config?: { neo4j?: Record<string, string> } }> };
    };
    const n = root.plugins?.entries?.["graph-memory-pro"]?.config?.neo4j;
    if (n?.uri && n.user && n.password) {
      return { uri: n.uri, user: n.user, password: n.password, database: n.database };
    }
  } catch (err) {
    console.error(`读取配置失败（${path}）：${(err as Error).message}`);
  }
  return null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const conn = resolveNeo4j(args);
  if (!conn) {
    console.error("未找到 Neo4j 连接信息。可设 GM_NEO4J_URI / GM_NEO4J_USER / GM_NEO4J_PASSWORD，或用 --config 指定 openclaw.json。");
    return 1;
  }

  const neo4j = (await import("neo4j-driver")).default;
  const driver = neo4j.driver(conn.uri, neo4j.auth.basic(conn.user, conn.password));
  const session = driver.session(conn.database ? { database: conn.database } : {});
  const scope = args.session ? "WHERE m.sessionKey = $sessionKey" : "";
  const params: Record<string, unknown> = args.session ? { sessionKey: args.session } : {};

  try {
    console.log("──────── :GmMessage 审计 ────────");
    console.log(`endpoint ${conn.uri}${args.session ? `  session=${args.session}` : "  （全部会话）"}\n`);

    // 1) 总量与 id 方案分布
    const totals = await session.run(
      `MATCH (m:GmMessage) ${scope}
       RETURN count(m) AS total,
              count(DISTINCT m.sessionKey) AS sessions,
              sum(CASE WHEN m.rebuildProcessedAt IS NULL THEN 1 ELSE 0 END) AS unprocessed`,
      params,
    );
    const t = totals.records[0];
    const total = t.get("total").toNumber();
    console.log(`消息总数            ${total}`);
    console.log(`会话数              ${t.get("sessions").toNumber()}`);
    console.log(`未标记 rebuildProcessedAt  ${t.get("unprocessed").toNumber()}`);

    if (total === 0) {
      console.log("\n无数据，无需处理。");
      return 0;
    }

    // 2) 完全重复行（同 session + role + content）—— 位置键位移的典型产物
    const dup = await session.run(
      `MATCH (m:GmMessage) ${scope}
       WITH m.sessionKey AS sk, m.role AS role, m.content AS content, collect(m) AS rows
       WHERE size(rows) > 1
       RETURN sk, role, count(*) AS groups, sum(size(rows) - 1) AS redundant,
              collect(left(content, 60))[0..5] AS sample
       ORDER BY redundant DESC
       LIMIT toInteger($limit)`,
      { ...params, limit: neo4j.int(args.limit) },
    );
    let redundantTotal = 0;
    for (const r of dup.records) redundantTotal += r.get("redundant").toNumber();
    console.log(`\n──────── 完全重复（可安全去重）────────`);
    console.log(`涉及会话数          ${dup.records.length}`);
    console.log(`多余行数            ${redundantTotal}`);
    for (const r of dup.records.slice(0, 10)) {
      console.log(`  ${r.get("sk")}  [${r.get("role")}]  冗余 ${r.get("redundant").toNumber()} 行`);
      for (const s of r.get("sample") as string[]) console.log(`      "${String(s).replace(/\n/g, " ")}"`);
    }
    if (dup.records.length > 10) console.log(`  …（其余 ${dup.records.length - 10} 个会话略）`);

    // 3) createdAt 塌缩程度：同会话内 distinct(createdAt) / count
    const collapse = await session.run(
      `MATCH (m:GmMessage) ${scope}
       WITH m.sessionKey AS sk, count(m) AS n, count(DISTINCT m.createdAt) AS distinctTs,
            min(m.createdAt) AS minTs, max(m.createdAt) AS maxTs
       WHERE n > 1
       RETURN sk, n, distinctTs, maxTs - minTs AS spanMs
       ORDER BY n DESC
       LIMIT toInteger($limit)`,
      { ...params, limit: neo4j.int(args.limit) },
    );
    console.log(`\n──────── createdAt 塌缩（旧写端每轮全量重写的后果）────────`);
    console.log("会话".padEnd(34) + "消息数".padEnd(9) + "不同时间戳".padEnd(12) + "跨度(ms)".padEnd(12) + "判定");
    let collapsedSessions = 0;
    for (const r of collapse.records) {
      const n = r.get("n").toNumber();
      const d = r.get("distinctTs").toNumber();
      const span = r.get("spanMs").toNumber();
      // 跨度远小于条数 → 时间戳被同一轮重写覆盖（正常应随对话增长）
      const suspicious = span < n * 50;
      if (suspicious) collapsedSessions++;
      console.log(
        String(r.get("sk")).slice(0, 32).padEnd(34) +
          String(n).padEnd(9) +
          String(d).padEnd(12) +
          String(span).padEnd(12) +
          (suspicious ? "⚠ 疑似塌缩（真实时间戳已不可恢复）" : "正常"),
      );
    }
    if (collapsedSessions > 0) {
      console.log(
        `\n注意：塌缩会话共 ${collapsedSessions} 个。旧写端把整段历史的 createdAt 刷成最后一轮的时间，` +
          `\n      原始时间戳**无法恢复**。修复只需停止继续覆盖（写端改 ON CREATE SET），无需（也无法）回填。`,
      );
    }

    // 4) 旧位置键分布（仅统计，不做改写）
    const legacy = await session.run(
      `MATCH (m:GmMessage) ${scope}
       RETURN size(split(m.id, ':')) AS parts, count(*) AS c ORDER BY c DESC`,
      params,
    );
    console.log(`\n──────── id 方案分布（仅统计，本工具不改写 id）────────`);
    for (const r of legacy.records) console.log(`  ':' 分段数 ${r.get("parts").toNumber()} → ${r.get("c").toNumber()} 行`);
    console.log(
      "  旧方案 id = gm:<sessionKey>:<turnIndex>:<role>:<hash200>（位置键，compaction 后会产生重复）\n" +
        "  不就地改写 id：队列文件里持久化了 msgIds 引用（src/store/messages.ts:201），改写会留下孤儿引用。",
    );

    // 5) 去重（可选）
    if (!args.dedup) {
      console.log(`\n如需清理重复行，加 --dedup 预览；确认后再加 --apply 执行。`);
      return 0;
    }
    console.log(`\n──────── 去重${args.apply ? "（执行）" : "（预览，未改动）"}────────`);
    if (!args.apply) {
      const preview = await session.run(
        `MATCH (m:GmMessage) ${scope}
         WITH m.sessionKey AS sk, m.role AS role, m.content AS content, collect(m) AS rows
         WHERE size(rows) > 1
         RETURN sk, role, size(rows) AS n, left(content, 50) AS sample
         ORDER BY n DESC LIMIT toInteger($limit)`,
        { ...params, limit: neo4j.int(args.limit) },
      );
      console.log(`将删除 ${redundantTotal} 行（每组保留 createdAt 最早的一行，若无则任意一行）。`);
      for (const r of preview.records) {
        console.log(`  ${r.get("sk")} [${r.get("role")}] ${r.get("n").toNumber()} → 1   "${String(r.get("sample")).replace(/\n/g, " ")}"`);
      }
      console.log(`\n确认无误后执行：npx tsx scripts/gm-message-audit.ts${args.session ? ` --session ${args.session}` : ""} --dedup --apply`);
      return 0;
    }
    // 保留策略：优先保留已有 rebuildProcessedAt 的行；否则保留 createdAt 最早的；再否则任意
    const res = await session.run(
      `MATCH (m:GmMessage) ${scope}
       WITH m.sessionKey AS sk, m.role AS role, m.content AS content, collect(m) AS rows
       WHERE size(rows) > 1
       WITH [r IN rows | r] AS rows
       WITH rows, reduce(acc = rows[0], r IN rows |
              CASE
                WHEN acc.rebuildProcessedAt IS NOT NULL AND r.rebuildProcessedAt IS NULL THEN acc
                WHEN acc.rebuildProcessedAt IS NULL AND r.rebuildProcessedAt IS NOT NULL THEN r
                WHEN coalesce(r.createdAt, 9223372036854775807) < coalesce(acc.createdAt, 9223372036854775807) THEN r
                ELSE acc END) AS keep
       UNWIND [r IN rows WHERE r <> keep] AS drop
       DELETE drop
       RETURN count(*) AS removed`,
      params,
    );
    console.log(`已删除多余行      ${res.records[0].get("removed").toNumber()}`);
    console.log(`\n复查：重复行数应为 0。建议紧接着跑一次写端修复后的回归（同一会话连续两轮 agent_end，断言行数不增）。`);
    return 0;
  } finally {
    await session.close();
    await driver.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("审计失败：", err);
    process.exit(1);
  });