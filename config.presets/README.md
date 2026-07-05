# Graph Memory Pro 配置预设

3 档预设配置，降低新用户配置复杂度。覆盖常见使用场景，复制对应预设为 `config.json`，替换占位符后即可使用。

## 预设对比

| 维度 | minimal.json | balanced.json | full.json |
|------|--------------|----------------|-----------|
| 定位 | 最小可用 | 推荐起点 | 全功能实验 |
| 适用场景 | 快速试用、连通性验证、开发环境 | 生产环境推荐起点 | 评测、高级用户、全功能体验 |
| 必需配置 | neo4j + llm + embedding | neo4j + llm + embedding | neo4j + llm + embedding |
| **核心召回增强** | | | |
| judge（Tier 1 启发式）| ❌ | ✅ | ✅ |
| queryCache | ❌ | ✅ | ✅ |
| temporal | ❌ | ✅ | ✅ |
| staleness | ❌ | ✅ | ✅ |
| graphHealth | ❌ | ✅ | ✅ |
| state | ❌ | ✅ | ✅ |
| causalEdges | ❌ | ✅ | ✅ |
| feedback | ❌ | ✅ | ✅ |
| **高级图算法** | | | |
| hierarchicalCommunity | ❌ | ❌ | ✅ |
| conflictResolution | ❌ | ❌ | ✅ |
| edgeWeights | ❌ | ❌ | ✅ |
| reverseMemory | ❌ | ❌ | ✅ |
| evolvableEmbedding | ❌ | ❌ | ✅ |
| marginalUtility | ❌ | ❌ | ✅ |
| importance | ❌ | ❌ | ✅ |
| **需要额外资源** | | | |
| associationMatrix | ❌ | ❌ | ✅（需 warmup 100 feedback）|
| autoTuner | ❌ | ❌ | ✅（需 benchmark）|
| mcp | ❌ | ❌ | ✅（需配 authToken）|
| benchmark | ❌ | ❌ | ❌ |
| **资源消耗** | 低 | 中 | 高 |
| **是否需要 warmup** | 否 | 否 | 是 |
| **是否需要额外配置** | 否 | 否 | 是（mcp authToken）|

## 选用指南

- **新用户快速试用 / 开发环境验证连通性** → `minimal.json`
  - 仅 neo4j + llm + embedding 三项必需配置
  - 关闭所有可选增强功能，最小依赖部署
  - 验证 Neo4j 连接、LLM / Embedding 模型可用即可

- **生产环境部署（推荐起点）** → `balanced.json`
  - 开启核心召回增强功能（judge 启发式 + queryCache + temporal + staleness + graphHealth + state + causalEdges + feedback）
  - 关闭需要 warmup 或额外配置的高级功能（associationMatrix / autoTuner / mcp）
  - 关闭高级图算法（marginalUtility / evolvableEmbedding / importance / hierarchicalCommunity / conflictResolution / edgeWeights / reverseMemory）
  - 兼顾功能与资源消耗

- **评测 / 高级用户 / 全功能体验** → `full.json`
  - 开启全部功能（含 associationMatrix / autoTuner / mcp / 全部高级图算法）
  - 注意：associationMatrix 需 100 feedback warmup、autoTuner 需 benchmark 数据、mcp 需配置 authToken
  - 功能等价于 `config.example.json`（额外开启 associationMatrix / autoTuner / mcp）

## 使用方法

1. 复制对应预设为 `config.json`：

   ```bash
   cp config.presets/balanced.json config.json
   ```

2. 替换占位符：
   - `neo4j.password`：替换 `your-password-here` 为实际 Neo4j 密码
   - `llm.apiKey`：Ollama 替换为空字符串 `""`；OpenAI 替换为 `sk-xxx`
   - `embedding.apiKey`：Ollama 替换为空字符串 `""`；OpenAI 替换为 `sk-xxx`
   - （仅 full.json）`mcp.authToken`：替换 `your-mcp-auth-token-here` 为实际 MCP 认证令牌

3. 通过 `--config` 参数传给 `npm run benchmark`，或填入 `openclaw.json` 的 `plugins.entries.graph-memory-pro.config`。

## Ollama 配置约定

所有预设默认使用 Ollama 作为 LLM / Embedding 后端，方便本地试用：

| 端点 | baseURL | 说明 |
|------|---------|------|
| LLM | `http://localhost:11434/v1` | **必须含 `/v1`**（OpenAI 兼容路径）|
| Embedding | `http://localhost:11434` | **不含 `/v1`**（走原生 `/api/embed`，`embed.ts` 会自动剥离 `/v1`）|

模型选择约定：
- LLM 模型须为 chat 模型（如 `qwen2.5:7b`、`llama3.1:8b`）
- Embedding 模型须为 embedding 模型（如 `nomic-embed-text`），**不能用 LLM 模型**（如 `qwen2.5:7b`）
- 首次使用前先拉取模型：`ollama pull qwen2.5:7b && ollama pull nomic-embed-text`

切换到 OpenAI 后端时：
- `llm.baseURL` 改为 `https://api.openai.com/v1`
- `llm.apiKey` 填 `sk-xxx`
- `llm.model` 改为 `gpt-4o-mini`（或其他 OpenAI 模型）

## 备注

- `config.example.json` 是历史完整配置示例，与 `full.json` 功能等价；新用户推荐使用 `config.presets/` 下的预设文件。
- 三档预设构成渐进式配置：`minimal` ⊂ `balanced` ⊂ `full`，可按需升级。
- 所有预设的 `neo4j.password` / `llm.apiKey` / `embedding.apiKey` 均为占位符，**使用前必须替换**。
- 预设文件中字段值参考 `config.example.json` 默认值与 `openclaw.plugin.json` 的 `configSchema` 约束。
