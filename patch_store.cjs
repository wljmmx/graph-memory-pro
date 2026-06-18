const fs = require('fs');
const path = './src/store/store.ts';
let c = fs.readFileSync(path, 'utf8');

// 1. Replace gm_node_embedding vector query with UNION of 3 indexes
const oldQuery = "CALL db.index.vector.queryNodes('gm_node_embedding'";
const newQuery = "UNION ALL\n      CALL db.index.vector.queryNodes('gm_node_embedding_task', toInteger($topK), $vec)\n       YIELD node, score\n       UNION ALL\n       CALL db.index.vector.queryNodes('gm_node_embedding_skill', toInteger($topK), $vec)\n       YIELD node, score\n       UNION ALL\n       CALL db.index.vector.queryNodes('gm_node_embedding_event'";

// Find and replace the single query with 3-way UNION
const oldBlock = `CALL db.index.vector.queryNodes('gm_node_embedding', toInteger($topK), $vec)
       YIELD node, score`;
const newBlock = `CALL db.index.vector.queryNodes('gm_node_embedding_task', toInteger($topK), $vec)
       YIELD node, score
       UNION ALL
       CALL db.index.vector.queryNodes('gm_node_embedding_skill', toInteger($topK), $vec)
       YIELD node, score
       UNION ALL
       CALL db.index.vector.queryNodes('gm_node_embedding_event', toInteger($topK), $vec)
       YIELD node, score`;
c = c.replace(oldBlock, newBlock);

// 2. Replace ensureSchema vector index creation (3 separate indexes)
const oldNodeIdx = `CALL db.index.vector.createNodeIndex(
          'gm_node_embedding', '节点嵌入',
          1024, 'cosine'
        )`;
const newNodeIdx = `CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_task', ['Task'], 'embedding', 1024, 'cosine'
        )`
+ `
    try {\n      await session.run(\`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_skill', ['Skill'], 'embedding', 1024, 'cosine'
        )
      \`);\n    } catch { /* may exist */ }

    try {\n      await session.run(\`
        CALL db.index.vector.createNodeIndex(
          'gm_node_embedding_event', ['Event'], 'embedding', 1024, 'cosine'
        )
      \`);`

c = c.replace(oldNodeIdx, newNodeIdx);

// Fix community index too
const oldCommIdx = `CALL db.index.vector.createNodeIndex(
          'gm_community_embedding', '社区嵌入',
          1024, 'cosine'
        )`;
const newCommIdx = `CALL db.index.vector.createNodeIndex(
          'gm_community_embedding', ['GmCommunity'], 'embedding', 1024, 'cosine'
        )`;
c = c.replace(oldCommIdx, newCommIdx);

fs.writeFileSync(path, c);
console.log('store.ts patched OK');
