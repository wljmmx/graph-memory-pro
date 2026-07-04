# Graph Memory Pro

> Neo4j 知识图谱记忆引擎插件 for OpenClaw

基于 [adoresever/graph-memory](https://github.com/adoresever/graph-memory) 的 fork 增强版本，提供更强大的知识图谱记忆能力。

## 特性

- **三元组提取**：从对话中自动提取 (实体, 关系, 实体) 知识三元组
- **Neo4j 图数据库**：使用原生 Cypher，不依赖 APOC 插件
- **GDS 图算法**：PageRank、社区检测（Label Propagation）
- **向量索引**：语义搜索 + 去重（Neo4j 5.11+ 向量索引）
- **双路径召回**：精确召回（全文 + 向量 + 图游走 + PPR）+ 泛化召回（社区级）
- **图谱维护**：自动去重、PageRank 计算、社区检测、社区摘要
- **OpenClaw 集成**：Agent 工具、HTTP API、Prompt Hook

## 版本

**当前版本：2.1.0**

### 相比原版的改进

- 修复 `CHARS_PER_TOKEN` 从字面量 `***` 改为 `4`
- 移除脆弱的动态 `import("openai")`，改用原生 fetch
- LLM 调用增加重试逻辑（移植自 V1）
- 移除 APOC 依赖，全部使用原生 Cypher
- CRUD 路由不再暴露密码等敏感信息
- 使用 `before_prompt_build` hook（替代已废弃的 `before_agent_start`）
- 新增 `gm_reembed` 工具，批量补充缺失的向量嵌入
- 并发维护锁增加超时机制，防止挂死

## 安装

```bash
npm install @openclaw/graph-memory-pro
```

## 配置

在 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "entries": {
      "graph-memory-pro": {
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "your-password"
          },
          "compactTurnCount": 6,
          "recallMaxNodes": 6,
          "recallMaxDepth": 2,
          "freshTailCount": 10,
          "dedupThreshold": 0.90,
          "pagerankDamping": 0.85,
          "pagerankIterations": 20,
          "llm": {
            "apiKey": "your-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "",
            "baseURL": "http://localhost:11434",
            "model": "nomic-embed-text",
            "dimensions": 768
          },
          "timing": {
            "enabled": false,
            "maxSamples": 1000,
            "reportEveryN": 50
          }
        }
      }
    }
  }
}
```

### 配置项说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `neo4j.uri` | string | `bolt://localhost:37687` | Neo4j bolt 连接地址 |
| `neo4j.user` | string | `neo4j` | Neo4j 用户名 |
| `neo4j.password` | string | `""` | Neo4j 密码 |
| `compactTurnCount` | number | `6` | 压缩轮次 |
| `recallMaxNodes` | number | `6` | 召回最大节点数 |
| `recallMaxDepth` | number | `2` | 图游走最大深度 |
| `freshTailCount` | number | `10` | 新鲜消息尾部数量 |
| `dedupThreshold` | number | `0.90` | 去重余弦相似度阈值 |
| `pagerankDamping` | number | `0.85` | PageRank 阻尼因子 |
| `pagerankIterations` | number | `20` | PageRank 迭代次数 |
| `llm.apiKey` | string | - | LLM API Key |
| `llm.baseURL` | string | - | LLM Base URL |
| `llm.model` | string | - | LLM 模型名 |
| `embedding.apiKey` | string | - | Embedding API Key |
| `embedding.baseURL` | string | - | Embedding Base URL |
| `embedding.model` | string | - | Embedding 模型名 |
| `embedding.dimensions` | number | `1024` | 向量维度 |
| `timing.enabled` | boolean | `false` | 是否启用延迟统计 |

## Agent 工具

### `gm_search`
搜索知识图谱中的节点。

**参数：**
- `query` (string): 搜索关键词
- `limit` (number, 可选): 返回结果数量上限，默认 10

### `gm_record`
手动记录知识到图谱中。

**参数：**
- `type` (string): 节点类型：`SKILL` / `TASK` / `EVENT`
- `name` (string): 节点英文名
- `description` (string): 描述
- `content` (string): 详细内容

### `gm_stats`
查看图谱统计信息。

### `gm_maintain`
手动触发图谱维护（去重 + PageRank + 社区检测）。

### `gm_reembed`
批量为缺失向量的活跃节点重新生成嵌入。

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 插件状态 |
| GET | `/api/stats` | 图谱统计 |
| GET | `/api/nodes/:id` | 获取节点详情 |
| GET | `/api/search` | 搜索节点 |
| GET | `/api/top` | Top 节点（按 PageRank） |
| GET | `/api/nodes-by-type/:type` | 按类型获取节点 |
| POST | `/api/maintain` | 触发维护 |

## 知识图谱结构

### 节点类型

- **TASK**：用户提出的具体任务需求
- **SKILL**：完成任务使用的方法、工具、代码片段或最佳实践
- **EVENT**：发生的具体事件、错误、异常或问题
- **GmCommunity**：社区摘要节点

### 关系类型

- `USED_SKILL`：TASK → SKILL，任务使用了某个技能
- `SOLVED_BY`：EVENT → SKILL，事件被某个技能解决
- `REQUIRES`：TASK → TASK，任务依赖另一个任务
- `PATCHES`：SKILL → SKILL，新的技能修正了旧的技能
- `CONFLICTS_WITH`：SKILL → SKILL，两种技能互相冲突或互斥
- `RELATES_TO`：跨领域关联关系

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 测试
npm test

# Lint
npm run lint
```

## 项目结构

```
src/
├── engine/
│   ├── llm.ts          # LLM 引擎（带重试和超时）
│   └── embed.ts        # Embedding 引擎（Ollama 原生 API）
├── extractor/
│   └── extract.ts      # 三元组提取器
├── format/
│   ├── assemble.ts     # 上下文组装
│   └── transcript-repair.ts  # 消息配对修复
├── graph/
│   ├── community.ts    # 社区检测
│   ├── dedup.ts        # 向量去重
│   ├── maintenance.ts  # 图谱维护
│   ├── pagerank.ts     # PageRank 算法
│   └── reembed.ts      # 批量重嵌入
├── recaller/
│   └── recall.ts       # 跨对话召回
├── routes/
│   └── crud.ts         # HTTP CRUD 路由
├── store/
│   ├── db.ts           # Neo4j 连接管理
│   └── store.ts        # 数据操作层
├── timing.ts           # 延迟分布统计
└── types.ts            # 类型定义
```

## 许可证

MIT
