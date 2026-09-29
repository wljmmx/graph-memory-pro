/**
 * v2.8.x — 图修订号（graph revision）
 *
 * 用途：让「派生自图的缓存」在**图内容变化**时自动失效，而不必让 store 层反向依赖
 * recaller 层（分层：store 不知道 QueryCache 的存在）。
 *
 * 背景（本轮审计发现）：`QueryCache` 只在手动 `/api/ops/cache` 时清空，节点/边写入路径
 * 从不失效 —— 用户写入或更新记忆后，同一 query 最长 30 分钟仍返回旧召回结果
 * （看不到新节点、仍含已改节点）。对照：pagerank 投影缓存**有**在 `store/edges.ts`
 * 写入后调用 `invalidateProjectionCache()`，此处补齐同等的失效语义。
 *
 * 设计：
 *   - 单调递增计数器，进程内有效（与本缓存的进程内生命周期一致）
 *   - 只在「可能改变召回输出」的写入上递增（新建/内容变化/删除/合并/边变化），
 *     纯重复抽取（内容未变）不递增 —— 否则每次抽取都会清空缓存，使缓存失去意义
 *   - 缓存条目记录写入时的修订号，读取时比对；不一致即视为 miss
 */

let _revision = 0;

/** 标记图内容已变化（供 store 写入路径调用） */
export function bumpGraphRevision(): void {
  _revision++;
}

/** 当前修订号（供缓存读取时比对） */
export function getGraphRevision(): number {
  return _revision;
}

/** 仅测试用：重置计数 */
export function __resetGraphRevision(): void {
  _revision = 0;
}