# Agent A 开发复审报告

审计 case：`graphrag-capability-scope-bridge-validation-run_1`

审计对象：当前工作区实现 diff，重点为
`python/qmd_graphrag/bridge.py`、
`test/python/test_graphrag_bridge_scope.py`，以及 audit status 中记录的验证。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1/agent-a/development-audit-criteria.md`

## 结论摘要

阻断项：无。

Agent B 上轮指出的阻断项已修复：Python bridge 现在通过
`_load_run_record_candidates()` 读取 `catalog/runs.yaml` 和
`books/<bookId>/runs/<runId>.yaml`，并在 `_load_checkpoint_candidates()` 中把
run record candidates 与 `checkpoints.yaml` candidates 合并排序。新增测试覆盖
producer checkpoint stage 缺失但 run record 有效时可恢复，以及 run record 缺少
当前 stage fingerprint 证据时 fail closed。

当前实现保持 artifact gate 为信任边界（trust boundary），没有把 explicit
capability catalog 或 checkpoint artifact ids 直接作为 ready 依据。producer
artifacts 会优先从当前 `artifacts.yaml` 按
`bookId + stage + producerRunId + required kind` 选择，并继续经过路径、hash、
Parquet、LanceDB、fingerprint、content hash 和 producer run id 校验。

## 发现项与风险

未发现必须修复的开发阻断项。

剩余风险：`_project_query_ready_lineage()` 在
`books/<bookId>/checkpoints.yaml` 整个文件不存在时仍返回 `None`。本次固定基准和
已知失败证据要求的是 producer stage checkpoint 陈旧或缺失时可通过当前 manifest
和 run record candidates 恢复，不要求在完全没有 checkpoint manifest 文件时恢复；
因此该点不构成本次 FAIL，但建议后续若要完全依赖 run records 恢复，应单独设计并
测试该兼容路径。

剩余风险：run record candidate 的 `contentHash` 由当前 book 的
`normalizedContentHash` 或 `sourceHash` 合成，再与 book 状态校验。这可以避免旧
record 自带内容 hash 绕过当前 book gate，但也意味着 run record 文件本身不提供
独立 content hash 证据。该行为未违反本次基准，但若未来要求 run record 作为独立
审计证据源，需要补充 schema 字段和测试。

## 逐条基准结论

1. PASS：实现必须让 Python bridge 从当前 `artifacts.yaml` 按
   `bookId + stage + producerRunId + required kind` 选择 producer artifacts。

   证据：`python/qmd_graphrag/bridge.py:700` 的
   `_artifact_ids_for_producer_stage()` 遍历当前 `artifacts_by_id`，要求
   `artifact.bookId == book_id`、`artifact.stage == stage`、
   `artifact.producerRunId == producer_run_id`，且 `kind` 属于
   `required_kinds` 后才返回 manifest 选择结果。`_select_producer_checkpoint()`
   在 `python/qmd_graphrag/bridge.py:726` 调用该选择逻辑，并在
   `python/qmd_graphrag/bridge.py:757` 继续调用 `_validate_artifact_subset()`。
   `_project_query_ready_lineage()` 在 `python/qmd_graphrag/bridge.py:857`
   加载当前 `artifacts.yaml` 后，为 `graph_extract`、`community_report` 和
   `embed` 三个 producer stages 构建 lineage。

   测试证据：
   `test_capability_scope_derives_from_current_manifest_when_checkpoint_stats_id_is_stale`
   位于 `test/python/test_graphrag_bridge_scope.py:1123`，将 graph_extract
   checkpoint 中的 stats artifact id 替换为陈旧 id，仍期望 capability 使用当前
   manifest lineage artifact ids 恢复。

   必要修正建议：无。

   剩余风险：无超出本次基准的风险。

2. PASS：实现不得把 explicit capability catalog 当作绕过 artifact gate 的信任源。

   证据：`python/qmd_graphrag/bridge.py:1282` 对 capability item 的
   `artifactIds` 重新投影为 `_load_query_ready_lineage_artifact_ids()` 的结果；
   `python/qmd_graphrag/bridge.py:1293` 要求 `_validate_query_ready_artifacts()`
   成功后才保留 capability；`python/qmd_graphrag/bridge.py:1302` 将输出
   `artifactIds` 改写为已验证 lineage artifact ids，而不是信任 explicit catalog。

   测试证据：
   `test_capability_scope_rejects_explicit_catalog_without_book_state` 位于
   `test/python/test_graphrag_bridge_scope.py:1331`，证明 explicit catalog 缺少
   book state gate 时不能绕过；`test_capability_scope_rejects_explicit_catalog_when_derivation_fails`
   位于 `test/python/test_graphrag_bridge_scope.py:1351`，证明 derivation/identity
   gate 失败时 explicit catalog 不能放行。

   必要修正建议：无。

   剩余风险：无。

3. PASS：实现必须保留 `_validate_artifact_subset()` 对 path、hash、parquet 和
   lancedb 完整性的校验。

   证据：`python/qmd_graphrag/bridge.py:1520` 到
   `python/qmd_graphrag/bridge.py:1538` 校验 artifact path 类型、便携路径
   （portable path）、book-scoped output 前缀、root containment 和文件存在性；
   `python/qmd_graphrag/bridge.py:1539` 到
   `python/qmd_graphrag/bridge.py:1550` 校验 content hash；
   `python/qmd_graphrag/bridge.py:1551` 校验 Parquet 文件有效性；
   `python/qmd_graphrag/bridge.py:1553` 校验 LanceDB 目录完整性。

   必要修正建议：无。

   剩余风险：无。

4. PASS：实现必须保留 stage fingerprint、provider fingerprint 和 corpus content
   hash 校验。

   证据：`python/qmd_graphrag/bridge.py:657` 的 `_checkpoint_matches_book()`
   要求 checkpoint 的 `stageFingerprint`、`providerFingerprint` 和 `contentHash`
   匹配当前 book；`python/qmd_graphrag/bridge.py:1390` 到
   `python/qmd_graphrag/bridge.py:1399` 对 query_ready lineage 的各 stage
   checkpoint 重复校验 content/stage/provider fingerprints；
   `_validate_artifact_subset()` 在 `python/qmd_graphrag/bridge.py:1509` 到
   `python/qmd_graphrag/bridge.py:1518` 校验 artifact 的 stage fingerprint、
   provider fingerprint 和 `metadata.corpusContentHash`。

   测试证据：
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint`
   位于 `test/python/test_graphrag_bridge_scope.py:1275`，修改当前 stats artifact
   的 `stageFingerprint` 后期望 fail closed。

   必要修正建议：无。

   剩余风险：run record candidate 的 `contentHash` 来自当前 book 状态，而不是 run
   record 自带字段；本次 gate 仍以当前 book 和 manifest 为准，因此不构成 FAIL。

5. PASS：实现必须保留 producer run id 校验，并拒绝 run id 不匹配的 manifest
   artifact。

   证据：`python/qmd_graphrag/bridge.py:714` 在当前 manifest 选择 producer
   artifacts 时要求 `artifact.producerRunId == producer_run_id`；
   `_validate_artifact_subset()` 在 `python/qmd_graphrag/bridge.py:1506` 到
   `python/qmd_graphrag/bridge.py:1508` 再次按 stage 的 expected producer run id
   拒绝 run id 不匹配 artifact。

   测试证据：
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 位于
   `test/python/test_graphrag_bridge_scope.py:1251`，将当前 stats artifact 的
   `producerRunId` 改为旧 run id 后期望 `unknown or not-ready`。

   必要修正建议：无。

   剩余风险：无。

6. PASS：实现必须让 checkpoint stats artifact id 陈旧但 manifest 当前有效时恢复。

   证据：`_artifact_ids_for_producer_stage()` 在
   `python/qmd_graphrag/bridge.py:708` 到 `python/qmd_graphrag/bridge.py:718`
   优先从当前 manifest 按 producer run id 与 required kind 选择 artifacts；
   只有没有 manifest selected ids 时，才在 `python/qmd_graphrag/bridge.py:719`
   回退到 checkpoint artifact ids 的 kind 过滤。这样 graph_extract checkpoint 中
   的 stale stats id 不再阻断当前 manifest 中有效 stats artifact 的恢复。

   测试证据：
   `test_capability_scope_derives_from_current_manifest_when_checkpoint_stats_id_is_stale`
   位于 `test/python/test_graphrag_bridge_scope.py:1123`，明确覆盖该恢复路径。

   必要修正建议：无。

   剩余风险：无。

7. PASS：实现必须让 manifest 缺失 stats artifact 时继续 fail closed。

   证据：`_select_producer_checkpoint()` 在
   `python/qmd_graphrag/bridge.py:757` 调用 `_validate_artifact_subset()`，并传入
   `required_kinds`；`_validate_artifact_subset()` 在
   `python/qmd_graphrag/bridge.py:1558` 要求 required kinds 全部存在。若当前
   manifest 缺失 `graphrag_stats_json`，graph_extract required kinds 不完整，
   lineage projection 无法通过。

   测试证据：
   `test_capability_scope_rejects_manifest_missing_current_stats_artifact` 位于
   `test/python/test_graphrag_bridge_scope.py:1225`，删除当前 manifest 中 stats
   artifact 后期望 fail closed。

   必要修正建议：无。

   剩余风险：无。

8. PASS：实现必须让 manifest stats artifact fingerprint 不匹配时继续 fail
   closed。

   证据：`_validate_artifact_subset()` 在
   `python/qmd_graphrag/bridge.py:1509` 到
   `python/qmd_graphrag/bridge.py:1518` 对 manifest artifact 的
   `stageFingerprint`、`providerFingerprint` 和 `metadata.corpusContentHash`
   执行 fail-closed 校验。

   测试证据：
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint`
   位于 `test/python/test_graphrag_bridge_scope.py:1275`，覆盖 stats artifact
   fingerprint mismatch 的 fail-closed 行为。

   必要修正建议：无。

   剩余风险：无。

9. PASS：实现不得修改 GraphRAG vendor、输出格式、research 子命令或批处理主流程。

   证据：`git diff --name-only` 仅列出
   `python/qmd_graphrag/bridge.py` 和
   `test/python/test_graphrag_bridge_scope.py`。当前 diff 未触碰 vendor 目录、
   output schema/format 文件、research 子命令或 batch 主流程文件。

   必要修正建议：无。

   剩余风险：本结论基于当前工作区 diff；若其他代理后续新增相关文件修改，需要重新
   审计。

10. PASS：相关 Python、CLI、book-state、typecheck 和 diff hygiene 验证必须通过或
    记录明确阻断原因。

    证据：`audit/graphrag-capability-scope-bridge-validation-run_1/status.yaml`
    的 `verification.passed` 记录了以下已通过命令：
    `python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`、
    `python -m py_compile python/qmd_graphrag/bridge.py test/python/test_graphrag_bridge_scope.py`、
    真实失败 book 的 `_load_graph_capabilities` probe、
    `npm run test:node -- test/cli.test.ts -t "reopens query-ready 'graph capability' projection gate failures"`、
    `npm run test:node -- test/book-job-state.test.ts`、`npm run typecheck` 和
    `git diff --check`。同一状态文件 notes 说明早前未匹配测试的 CLI 命令未被计入
    验证。

    必要修正建议：无。

    剩余风险：本次复审未重新运行验证命令，结论依赖 status 中已记录的通过结果与
    当前 diff 内容一致。

verdict: development_audit_passed
