# Agent C 设计审计 R1

## 结论

Verdict: FAIL.

当前设计不能直接进入实施。它足以定位真实失败的近因
(proximate cause)，但尚未把辅助 sidecar mapping、JSONL durable sidecar
语义、以及 subprocess runtime parity 写成可测试设计边界。允许先补 Type DD；
在 Type DD 补齐并绑定测试后，才允许进入实现。

实施许可 (implementation approval): 不允许。

## 失败边界

真实失败链路为：

`appendProviderCostAccounting` -> `writeOpaqueFileDurableSync` ->
`writeJsonSidecarSync(ownerPath)`。

`src/provider/cost-accounting.ts:37` 把生产目标固定为
`graph_vault/catalog/cost-accounting.jsonl`，该 primary target 已在
Type DD 和实现 mapping 中登记为 `eventWriterLane` 与
`providerCostAccounting`。但是 `src/job-state/durable-state-store.ts:445-450`
为 primary JSONL replace 创建
`cost-accounting.jsonl.tmp-{tempId}.owner.json` 后，调用
`writeJsonSidecarSync(ownerPath, operation)`，没有传入 primary operation。
该 helper 默认对 owner sidecar 自己调用
`newOperationEvidence(path, "json-sidecar")`
(`src/job-state/durable-state-store.ts:1303-1313`)。

随后 `durableTargetMapping` 只会把 `.corrupt-*`、`.sha256`、
`.sha256.meta.json` 归约回 primary
(`src/job-state/durable-state-store.ts:2184-2231`)；它不会把
`.tmp-*.owner.json` 归约为 `cost-accounting.jsonl`。由于路径位于
`/graph_vault/` 下，`isProductionDurableTarget` 判定为生产 durable target，
于是抛出 `durable_target_mapping_missing`。

该失败不是 provider 成本记录 schema 问题，也不是 EPUB 内容问题；它是
durable engine 生成的辅助 owner sidecar 被误当作生产 primary target
重新解析 mapping。

## 设计充分性

当前 Type DD 已覆盖部分相邻规则：

- `graph_vault/catalog/cost-accounting.jsonl` 已登记为
  `jsonl`、`eventWriterLane`、`providerCostAccounting`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:489`)。
- checksum sidecar 已声明继承 primary target mapping
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:250`)。
- temp owner evidence 被要求存在，并可存储在 temp sidecar
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:669`)。
- 单一 durable boundary 和 adapter 等价规则已存在
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:625`)。
- beforeClaim 扫描要求包含 `.tmp-*`、`.owner.json`、`.sha256` 与
  `.sha256.meta.json`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1324`)。

但这些规则没有明确回答本次失败的核心问题：engine-created
`*.tmp-*.owner.json` 是否是 primary target、如何继承 primary target 的
lane/owner/durableKind、是否需要 sidecarKind、是否允许自身再生成 sidecar，
以及 path-derived mapping 如何处理 owner sidecar。当前设计只能让实现者推断
"应继承 primary operation"，不能作为生产修复的完整设计依据。

因此，当前设计不足以直接实施修复。

## 必须先补 Type DD

需要先补 Type DD，范围应窄而明确。

1. `auxiliarySidecarMappingRule`

   Type DD 必须把 durable engine 生成的辅助目标定义为非 primary target。
   至少包括：

   - `{primary}.tmp-{tempId}.owner.json`
   - `{primary}.sha256.tmp-{tempId}.owner.json`
   - `{primary}.sha256.meta.json.tmp-{tempId}.owner.json`
   - `{primary}.lock`
   - `{primary}.corrupt-*` 的 temp owner sidecar

   这些路径必须继承它们描述的 primary 或 checksum sidecar 的 lane、
   targetMappingOwner、laneTimeoutMs、releaseOn、durableMode 与 preflight
   scope。owner sidecar 不能作为新的 primary target，也不能递归生成
   `.sha256`、`.sha256.meta.json` 或新的 owner sidecar。证据字段应包含
   `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind:
   temp_owner` 或等价的 `auxiliarySidecarKind`。

2. `jsonlDurableSidecarRule`

   Type DD 必须区分 JSONL append mode 与 JSONL replace/opaque mode。
   `events.jsonl` 的 append 合同不能自动套用到
   `cost-accounting.jsonl` 的 read-reconcile-replace 实现。若保留当前实现，
   设计应声明：

   - `cost-accounting.jsonl` 是 production primary JSONL target。
   - durable temp owner sidecar 继承 `providerCostAccounting` mapping。
   - corrupt-tail quarantine 仍继承 primary JSONL target mapping。
   - 不因本次修复引入 checksum sidecar，除非另开设计变更。
   - parent directory fsync 必须继承 primary JSONL target 的
     `eventWriterLane` 与 `providerCostAccounting`，不能退化为裸
     `graph_vault/catalog` 的 repository mapping。

3. `subprocessRuntimeParityRule`

   本次失败发生在 `resume-book-1` subprocess 边界。Type DD 需要把共享
   durable store (`src/job-state/durable-state-store.ts`) 与 runner 等价实现
   (`scripts/graphrag/batch-epub-workflow.mjs`) 的 mapping 归约规则列为同一
   contract。子进程内的 durable failure envelope 必须无损投影
   `localFailureClass`、`targetLocator`、`tempId`、`operationId`、`lane`、
   `targetMappingOwner` 与 `completedPublishRule`；缺失 envelope 时才走
   fail-closed incomplete evidence。

4. Acceptance matrix 增补

   增加 `cost_accounting_jsonl_temp_owner_mapping` 用例，明确
   `graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json` 不得触发
   `durable_target_mapping_missing`，并要求 shared module 与 runner-equivalent
   runtime 都覆盖。

## 推荐设计边界

推荐修复边界应在 durable store 的 mapping/evidence 层，而不是 provider
cost-accounting 业务层。

- owner sidecar 写入应复用 primary operation evidence，或在 path normalizer
  中严格识别 engine-created auxiliary sidecar 并归约回 primary target。
- 归约规则只允许匹配 durable engine 生成的固定后缀形态；不得对
  `graph_vault/**.owner.json` 做宽泛 nonProductionDefault。
- `cost-accounting.jsonl` 仍保持 `eventWriterLane` 和
  `providerCostAccounting` owner。不要新增 writer lane。
- `appendProviderCostAccounting` 的 schema 校验和 metadata sanitize 不需要变化。
- preflight 发现残留 owner sidecar 时，应按 primary target 诊断或清理策略处理，
  不应报告 target mapping missing。
- subprocess 父子进程只需要共享 durable failure schema 和 mapping 语义，不需要
  重构为一个新的 IPC durable service。

不应过度实现：

- 不要把所有 JSONL 文件迁移为 SQLite 或新 catalog。
- 不要因为本次 owner sidecar bug 给 JSONL 全量补 checksum sidecar。
- 不要放宽 production target mapping missing 的 fail-closed 行为。
- 不要扩大到多 coordinator、多机器或跨 runId 写入支持。
- 不要修改 provider auth、retry budget、EPUB scheduling 或 GraphRAG stage gate。
- 不要通过静默重开 failed checkpoint 绕过 `stop_until_fixed` 证据链。

## 必须测试

实施前后的测试必须覆盖以下最小集合：

1. Shared store regression:
   对 `graph_vault/catalog/cost-accounting.jsonl` 调用
   `writeOpaqueFileDurableSync`。断言不会抛出
   `durable_target_mapping_missing`，primary 文件成功提交，临时
   `.tmp-*` 与 `.owner.json` 被清理。

2. Owner sidecar mapping:
   对 `cost-accounting.jsonl.tmp-{tempId}.owner.json`、
   `cost-accounting.jsonl.sha256.tmp-{tempId}.owner.json`、以及
   `cost-accounting.jsonl.sha256.meta.json.tmp-{tempId}.owner.json`
   验证 mapping 继承 primary/sidecar，不产生新的 primary mapping。

3. Negative mapping:
   未登记的生产 primary target 仍必须抛出
   `durable_target_mapping_missing`。该测试防止用宽泛 fallback 掩盖真实设计缺口。

4. JSONL corrupt-tail path:
   `reconcileProviderCostAccounting` 遇到尾部坏行时，quarantine target 与其
   temp owner sidecar 均继承 `cost-accounting.jsonl` mapping，且不会误报
   auxiliary owner mapping missing。

5. Directory fsync evidence:
   对 cost-accounting JSONL 注入 parent directory fsync failure。断言 evidence
   包含 `primaryTargetLocator: graph_vault/catalog/cost-accounting.jsonl`、
   `lane: eventWriterLane`、`targetMappingOwner: providerCostAccounting`、
   `directoryDurableKind: directory` 与 `completedPublishRule: forbidden`。

6. Preflight/status-json:
   构造残留 `cost-accounting.jsonl.tmp-*.owner.json`。正常 runner preflight
   应按 temp owner evidence 做 fail-closed 或 stale cleanup；`--status-json`
   只能只读诊断，不得创建、删除或 rename owner sidecar。

7. Subprocess projection:
   在 `resume-book-*` 子进程路径触发 cost-accounting durable write。成功路径
   不得产生 `durable_target_mapping_missing`；失败注入路径必须输出
   `QMD_GRAPHRAG_DURABLE_FAILURE` envelope，并由父 runner 投影到
   commandCheck、item checkpoint、event、status-json 与 recovery summary。

8. Runtime parity:
   同一组 auxiliary sidecar locators 必须在
   `src/job-state/durable-state-store.ts` 与
   `scripts/graphrag/batch-epub-workflow.mjs` 中解析为相同 lane、owner、
   durableKind 与 sidecar identity。

9. Real-run guard:
   使用新的 runId 对包含 `A Philosophy of Software Design` 的真实 EPUB 执行
   至少一个 resume-book cost-accounting 写入闭环。断言 item 不因
   `durable_target_mapping_missing` 停止，且 completed 仍必须依赖 qmd、
   GraphRAG producer lineage 与 query-ready 证据。

## 最终裁决

PASS/FAIL: FAIL.

是否允许进入实施：不允许在当前设计下实施。下一步应先补
`graphrag-parallel-runner.type-dd.yaml`，明确 auxiliary sidecar mapping、
JSONL durable sidecar mode 和 subprocess runtime parity。Type DD 补齐后，
实现应保持窄修复：让 temp owner sidecar 继承其 primary operation/mapping，
并用上述测试证明 shared store、runner 等价实现和 subprocess 投影一致。
