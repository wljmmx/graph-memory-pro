/**
 * graph-memory-pro — Doctor contract（state migrations）
 *
 * 宿主（openclaw）按 basename 从**插件根目录**或 `dist/` 解析本文件
 * （见 openclaw 的 doctor-contract-artifact：`paths = [filename, dist/filename]`，
 *  根目录优先）。因此这里放在根目录 —— 不进入 `dist/`，从而不破坏本插件
 * 「dist 产物必须单文件自包含」的构建不变式（由 scripts/verify-dist-selfcontained.mjs 门禁）。
 *
 * 为什么需要这个文件：
 *   v2.4.4 及之前的 openclaw.plugin.json 声明了 `doctorContract.stateMigrations: true`，
 *   但本插件从未提供 doctor contract 实现。宿主据此把插件判为「有未完成的迁移义务」
 *   （requiredPluginIds → requiresStateMigration），而该标记一旦落库就**只增不减**
 *   （deferred-plugin-migrations 的 mergeDeferredPluginMigration），且没有任何 CLI 能清；
 *   唯一能覆盖它的路径是插件真的报告一次"迁移已完成"（completedPluginIds 优先于该标记）。
 *   后果表现为每次启动的永久降级告警：
 *     [state-migrations] Plugin "graph-memory-pro" data/settings upgrade is unfinished ...
 *   且 `openclaw doctor --fix` 修不好（无法完成一个并不存在的迁移）。
 *
 * 本文件的作用：以真实实现取代假声明，把这条伪义务结清。
 *
 * 安全约束（刻意保持最小权限）：
 *   - 零 import：不依赖任何模块，可被宿主独立加载，不会因依赖缺失而"加载失败但静默"。
 *   - 不读写任何文件、数据库、插件状态；`migrateLegacyState` 永不产生变更。
 *   - `detectLegacyState` 恒定返回 null（= 无遗留状态需要迁移），因此宿主不会生成
 *     迁移计划、更不会调用 `migrateLegacyState` 去改数据。属于 fail-closed。
 *
 * 后续如需真正的状态迁移：在此数组追加新条目（id 必须同步写入
 * openclaw.plugin.json 的 doctorContract.stateMigrations，且顺序、doctorOnly、phase
 * 必须逐项一致，否则宿主会抛 PluginDoctorStateMigrationDeclarationError 拒绝执行），
 * 并在该条目的 detectLegacyState 中真实探测旧格式。新增条目前务必先读
 * openclaw 的 state-migrations 契约文档，评估数据回滚路径与影响面。
 *
 * 与 manifest 的一致性由 test/doctor-contract.test.ts 守护。
 */

/** 与 openclaw.plugin.json 中 doctorContract.stateMigrations[0].id 必须逐字一致 */
const MIGRATION_ID = "graph-memory-pro-plugin-state-v1";

/** @type {Array<{ id: string, label: string, detectLegacyState: () => Promise<null>, migrateLegacyState: () => Promise<{ changes: string[], warnings: string[] }> }>} */
const stateMigrations = [
  {
    id: MIGRATION_ID,
    label: "Graph Memory Pro plugin state",
    /**
     * 探测是否存在需要迁移的遗留状态。
     *
     * 恒定返回 null：本插件的持久化产物（association-matrix.json /
     * extract-queue.jsonl / auto-tuner-state.json 等）当前不存在需要改写的旧格式，
     * 因此没有任何迁移计划。返回值语义见宿主契约：
     *   返回 null 或 { preview: [] } → 不生成计划 → 宿主把插件计入 completedPluginIds。
     *
     * 注意：这里**不做任何探测性 IO**，避免在宿主 Doctor 只读阶段产生副作用；
     * 若将来引入旧格式，应在此真实探测并返回 { preview: [...] }。
     *
     * @returns {Promise<null>}
     */
    async detectLegacyState() {
      return null;
    },
    /**
     * 执行迁移。
     *
     * 保留实现是为了满足宿主对迁移条目的形状要求（缺 detect/migrate 任一函数会被
     * coercePluginDoctorStateMigrations 过滤掉，等价于没有该条目）。
     * 由于 detectLegacyState 恒为 null，宿主不会调用本函数；即便被调用也返回零变更。
     *
     * @returns {Promise<{ changes: string[], warnings: string[] }>}
     */
    async migrateLegacyState() {
      return { changes: [], warnings: [] };
    },
  },
];

export { stateMigrations };