# GraphRAG Provider Requests Preflight Quarantine R1 设计审计

判定：FAIL

固定审计问题聚焦于：runner-start preflight 在 batch manifest 创建前，对
`graph_vault/catalog/provider-requests/*.json` 的大量
`durable_checksum_mismatch` quarantine 是否被 Type DD 正确约束。结论是：
Type DD 已把 provider request target 纳入 durable targetMapping，但没有定义其
历史观测（historical observation）与关键目录状态（critical catalog state）的
边界，也没有限制启动期写入式恢复的规模，因此不能正确约束本次真实失败。

## 发现

1. FAIL - provider-requests 被无条件纳入 runner-start 阻断性 preflight，但
   Type DD 未给出 critical/cache-like 分类。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241` 规定
   runner_start 从 targetMapping 派生全局扫描范围；
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:472` 将
   `graph_vault/catalog/provider-requests/*.json` 注册为 catalogWriterLane
   durable JSON target；`scripts/graphrag/batch-epub-workflow.mjs:378` 同步把该
   目录加入实现侧 preflightScopes；`scripts/graphrag/batch-epub-workflow.mjs:11696`
   在 manifest 创建前执行 runner_start preflight。

   影响：历史 provider request 被等同于启动关键 catalog state，任何历史
   checksum mismatch 都可阻断新批次，且可发生在 manifest 创建前。

   设计操作建议：修正完善设计。明确 provider request durable target 的类别：
   若属于 cache-like historical observation，应从 runner-start 阻断性扫描中
   移出，或降级为 read-only diagnostic/显式 repair；若属于 critical catalog
   state，则必须说明其启动阻断条件和恢复边界。

2. FAIL - Type DD 允许 normal resume 的 repairWriter 执行 quarantine，导致
   runner-start 可以在发现第一个 blocker 前持续隔离大量历史 provider request。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:755` 允许
   normal resume 在持锁时执行 quarantine；
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:790` 规定
   target_valid_checksum_mismatch 可 quarantine primary bundle；
   `scripts/graphrag/batch-epub-workflow.mjs:5515` 的 preflight JSON decision
   调用 writable reconcile；`scripts/graphrag/batch-epub-workflow.mjs:5594`
   遍历目录并持续收集 blockers；`scripts/graphrag/batch-epub-workflow.mjs:5915`
   将 checksum mismatch 转入异常路径；
   `scripts/graphrag/batch-epub-workflow.mjs:5994` 执行 target quarantine。

   影响：preflight 本应先判定是否可启动，却实际执行了批量破坏性恢复
   （destructive recovery）。本次 731 个 JSON quarantine 与该设计许可一致，
   因此不是单纯实现偏差。

   设计操作建议：修剪错误设计。runner-start 应先做只读或限量探测；
   对 provider-requests 的 primary quarantine 必须转为 explicit repair command
   或人工确认，不应作为普通启动路径的默认动作。

3. FAIL - Type DD 没有为启动前恢复设置数量、scope、时间或事件上限。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241` 要求
   runner_start 扫描全局 scope；
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1240` 只规定任一
   无法收敛的 target 必须 stop_until_fixed，未规定 quarantine 上限；
   `scripts/graphrag/batch-epub-workflow.mjs:5594` 的目录扫描仅有递归深度控制；
   `scripts/graphrag/batch-epub-workflow.mjs:5716` 汇总 blockers 后才抛错。

   影响：单次真实 runner 启动可在同一目录内写入数百个 quarantine 事件和
   `.corrupt-*` 文件，扩大历史状态损伤（blast radius）。

   设计操作建议：补充设计。为 runner-start writable recovery 定义硬上限：
   每目录 target 数、quarantine 数、事件数、耗时、总 scope 数；超过上限时停止
   并要求显式 repair。

4. FAIL - manifest 创建前的大规模 recovery/quarantine 缺少启动期可观测合同。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1288` 将
   manifest/status 定义为派生缓存；
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1293` 规定
   observability 由 manifest、status、recovery-summary 与 event/checkpoint
   承载；`scripts/graphrag/batch-epub-workflow.mjs:11696` 在
   `loadManifest` 前执行 durablePreflight；
   `scripts/graphrag/batch-epub-workflow.mjs:11717` 才创建或加载 manifest。

   影响：当 preflight 失败时，runner 可写出大量 recovery/quarantine 事件，却没有
   已创建的 batch manifest 或 startup recovery manifest 来概括本次启动期变更。

   设计操作建议：补充设计。定义 manifest-before-work 例外的 startup recovery
   manifest，或规定 manifest 必须先以 startup_recovery 状态创建，再允许任何
   写入式 preflight recovery。

5. FAIL - status-json read-only 与 normal runner-start 对 provider request
   mismatch 的处理不一致，且 Type DD 未要求二者覆盖同一 provider-requests scope。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1608` 规定
   status-json 严格只读；`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1630`
   将 checksum_mismatch 投影为 fail_closed_projection；
   `scripts/graphrag/batch-epub-workflow.mjs:5716` 在 statusJson 时直接跳过
   durablePreflight；`scripts/graphrag/batch-epub-workflow.mjs:4860` 的只读
   checksum 检查只覆盖被读取的 serialized target。

   影响：status-json 可不暴露 provider-requests 目录中的历史 mismatch，而 normal
   runner-start 会对同一问题执行写入式 quarantine，观测入口不能提前揭示真实风险。

   设计操作建议：修正完善设计。规定 status-json 必须以只读方式覆盖与
   runner-start 相同的 provider-requests 诊断 scope，或明确 provider-requests
   不属于 runner-start scope；二者不能维持当前分叉。

6. FAIL - 共享 durable store 也把 provider-requests 建模为普通关键 JSON target，
   Type DD 未要求 adapter 层区分历史 provider observation。

   证据：`src/job-state/durable-state-store.ts:163` 将
   `graph_vault/catalog/provider-requests/*.json` 映射到 catalogWriterLane；
   `src/job-state/durable-state-store.ts:697` 对 checksum mismatch 执行
   quarantineTarget；`src/job-state/durable-state-store.ts:1500` 的 quarantineTarget
   直接 rename primary target 并 fsync 目录。

   影响：即使 runner 侧修正扫描策略，共享 store 仍缺少 provider request 的
   cache-like 恢复语义，未来调用该 store 的路径可能继续把历史请求观测当作关键
   catalog corruption 处理。

   设计操作建议：修正完善设计。在 Type DD 中补充 shared durable adapter 对
   providerRequestFingerprint 的恢复策略，要求 adapter 支持按 target family 选择
   read-only、bounded repair、sidecar-only repair 或 explicit repair。

7. FAIL - 现有验收点未覆盖 provider-requests 的 runner-start 大规模 quarantine
   防回归场景。

   证据：`test/graphrag-runner-durable-preflight.test.ts:114` 只覆盖 book run YAML
   checksum fault 的 runner-start 阻断；
   `test/cli.test.ts:3296` 只覆盖 manifest checksum sidecar crash window；
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1967` 仅要求
   provider-requests parent directory fsync 映射正确，没有验收 runner-start
   provider-requests mismatch 的限量、只读或显式 repair 行为。

   影响：当前测试与 acceptance matrix 不能防止再次出现 manifest 创建前的无界
   provider request quarantine。

   设计操作建议：补平。为本固定失败补充验收点：构造多个历史
   provider-requests checksum mismatch，验证 runner-start 不会无界 quarantine，
   并产生规定的 read-only diagnostic、bounded repair 停止或 explicit repair 提示。
