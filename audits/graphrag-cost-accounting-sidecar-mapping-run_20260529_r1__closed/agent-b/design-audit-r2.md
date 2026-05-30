# GraphRAG Cost Accounting Sidecar Mapping Design Audit R2

## Verdict: PASS

当前 Type DD 规则已充分解决 R1 指出的 cost-accounting JSONL durable
temp owner sidecar mapping 设计缺口。允许进入实施。

## 依据

1. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224` 的
   `targetMappingContract` 已扩展到 `durable YAML/JSON/JSONL/SQLite primary
   target`。同一规则明确 durable engine 为已登记 primary target 生成的
   temp、owner、lock、checksum、checksum meta 与 corrupt quarantine 辅助路径
   必须先归一回 primary target，再继承 primary mapping，且不得被当作新的
   primary target。

2. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:263` 新增
   `auxiliarySidecarMappingRule`，明确 production durable primary target 包括
   YAML、JSON、JSONL 与 SQLite lock family；在使用 durable write protocol 时，
   `{target}.tmp-*`、`{target}.tmp-*.owner.json`、`{target}.lock`、
   `{target}.corrupt-*` 以及 checksum policy 相关 sidecars 都是 primary 的
   auxiliary durable paths。该规则明确要求这些路径通过 primary target locator
   解析，并继承 lane、owner、durableKind、laneTimeoutMs、releaseOn、
   durableMode 与 preflight scope。

3. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:275` 明确辅助路径
   失败证据必须包含 target locator、primary 或 auxiliary locator、sidecar kind
   或 auxiliary sidecar kind、tempId、operationId、lane、targetMappingOwner、
   primaryDurableKind 与 completedPublishRule。这覆盖了 R1 要求的
   `.tmp-*.owner.json` failure evidence 可诊断性。

4. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:512` 的
   `graph_vault/catalog/cost-accounting.jsonl` target entry 已明确：
   `lane: eventWriterLane`、`durableKind: jsonl`、
   `owner: providerCostAccounting`、`durableWriteMode:
   jsonl_read_reconcile_replace`、`checksumPolicy:
   none_for_current_jsonl_replace`、`auxiliarySidecars:
   inherit_primary_mapping`。

5. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:521` 的
   cost-accounting sidecar policy 明确该 JSONL ledger 通过 temp file、owner
   sidecar、atomic rename 与 parent directory fsync 提交；其
   `{target}.tmp-*`、`{target}.tmp-*.owner.json`、`{target}.corrupt-*` 与
   parent directory fsync 必须继承 `providerCostAccounting` 的
   `eventWriterLane` mapping，不得触发 `durable_target_mapping_missing`。

6. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:608` 的
   `jsonlReadReconcileReplace` 规则明确 JSONL 读取、合并、截断坏尾或重写
   ledger 时使用与 durable replace 等价的 temp、owner sidecar、exclusive
   create、atomic rename 与 parent directory fsync；temp、owner、corrupt
   quarantine 与 directory fsync 映射必须遵守
   `auxiliarySidecarMappingRule`。

7. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:690` 的
   `mappingParityRule` 要求 durableStateStore、runner 内嵌 adapter 与
   resume-book-* 子进程边界使用同一 primary target locator 归一化规则，并对
   primary、temp、temp owner、checksum、checksum meta、lock、corrupt
   quarantine 与 parent directory fsync locator 解析到相同 lane、owner、
   primaryDurableKind、releaseOn、durableMode 与 completedPublishRule。
   这消除了实现层多套映射语义导致的剩余设计空白。

8. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:2157` 新增
   `cost_accounting_jsonl_auxiliary_sidecar_mapping` 测试案例，覆盖
   `cost-accounting.jsonl.tmp-*.owner.json` 继承同一 primary mapping、corrupt
   quarantine 继承同一 mapping、未知 production JSONL 与其 temp owner sidecar
   fail closed、共享 store 与 runner adapter 映射一致，以及 resume-book failure
   envelope 保留必要字段。

## 若 FAIL 的最小剩余设计缺口

无。本轮判定为 PASS。

## 是否允许进入实施

允许进入实施。

实施边界应保持在 R1 已定义的问题内：实现 production durable primary auxiliary
path 到 primary target locator 的归一化，确保
`graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json` 继承
`cost-accounting.jsonl` 的 `eventWriterLane` 与 `providerCostAccounting`
mapping，并补齐对应测试。不得扩大到 provider cost accounting 业务语义、费用
计算、provider auth 策略或 unrelated durable target 重构。
