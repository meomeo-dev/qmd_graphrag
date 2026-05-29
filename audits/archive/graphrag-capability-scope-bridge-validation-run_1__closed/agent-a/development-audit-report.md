# Agent A 开发审计报告

审计对象：当前实现 diff，重点文件为 `python/qmd_graphrag/bridge.py` 和
`test/python/test_graphrag_bridge_scope.py`。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-a/development-audit-criteria.md`

验证记录来源：`audit/graphrag-capability-scope-bridge-validation-run_1__closed/status.yaml`
的 `verification.passed`。本报告未重新执行验证命令。

## 阻断项

无。当前实现满足 Agent A 固定开发审计基准。

## 逐条基准结论

1. PASS

   证据：`bridge.py` 新增 `_artifact_ids_for_producer_stage()`，当存在
   `producer_run_id` 时，从当前 `artifacts.yaml` 加载出的 `artifacts_by_id` 中按
   `bookId + stage + producerRunId + kind` 选择 artifact id。该 helper 已用于
   `_load_query_ready_lineage_artifact_ids()` 的 producer lineage 计算，以及
   `_validate_query_ready_artifacts()` 的 producer stage 与 query-ready gate
   artifact 选择。

   必要修正建议：无。

   剩余风险：helper 在找不到 manifest selection 时会回退 checkpoint ids；后续
   `_validate_artifact_subset()` 仍会用当前 manifest by-id、run id、fingerprint、
   hash 和 path 完整性校验，因此未构成绕过，但该 fallback 需要保持只用于无
   producer run id 或非高成本 producer 的兼容场景。

2. PASS

   证据：`_load_graph_capabilities()` 对请求的 `:graph_query` capability 仍优先
   derive book-state capability，并在返回前要求 requested artifact ids 是当前
   lineage artifact ids 的子集，随后调用 `_validate_query_ready_artifacts()`。
   既有测试 `test_capability_scope_rejects_explicit_catalog_without_book_state`、
   `test_capability_scope_rejects_explicit_catalog_when_derivation_fails` 和
   `test_capability_scope_derives_missing_capability_with_explicit_catalog` 保持覆盖
   explicit catalog 不能绕过 book state、identity 与 artifact gate。

   必要修正建议：无。

   剩余风险：无。

3. PASS

   证据：`_validate_artifact_subset()` 仍保留 path、hash、Parquet 与 LanceDB
   完整性校验：要求 artifact bookId、kind、stage、producerRunId、
   `stageFingerprint`、`providerFingerprint`、`metadata.corpusContentHash` 匹配；
   要求 path 可规范化且位于 `books/<bookId>/output/`，`lancedb_index` 必须是
   `books/<bookId>/output/lancedb`；继续比较实际 hash 与 `contentHash`，并调用
   `_is_valid_parquet_file()` 与 `_is_complete_lancedb_directory()`。

   必要修正建议：无。

   剩余风险：Python 环境缺少 Parquet/LanceDB 校验依赖时应继续 fail closed；
   当前审计未复跑环境依赖矩阵。

4. PASS

   证据：`_validate_query_ready_artifacts()` 仍从 book state 读取
   `stageFingerprints`、`providerFingerprint` 和 corpus content hash，要求
   `graph_extract`、`community_report`、`embed`、`query_ready` checkpoint 的
   content hash、stage fingerprint、provider fingerprint 与 book state 匹配；
   `_validate_artifact_subset()` 进一步校验每个 artifact 的 stage fingerprint、
   provider fingerprint 和 `metadata.corpusContentHash`。新增测试
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint` 覆盖
   fingerprint 不匹配 fail closed。

   必要修正建议：无。

   剩余风险：新增测试覆盖 stage fingerprint，不单独覆盖 provider fingerprint
   或 corpus content hash；原 validator 代码仍保留这些校验。

5. PASS

   证据：`_artifact_ids_for_producer_stage()` manifest selection 按
   `producerRunId` 匹配；`_validate_artifact_subset()` 使用
   `expected_producer_run_ids` 再次拒绝 artifact `producerRunId` 不匹配。新增测试
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 将当前 stats
   artifact 的 `producerRunId` 改成旧 run，并确认 capability 继续
   `unknown or not-ready`。

   必要修正建议：无。

   剩余风险：无。

6. PASS

   证据：新增测试
   `test_capability_scope_derives_from_current_manifest_when_checkpoint_stats_id_is_stale`
   将 `graph_extract` checkpoint 中 stats artifact id 替换为
   `stale-stats-artifact`，但保留当前 manifest 中同一 `run-graph-extract` 的
   `artifact-1-stats`。测试确认 `_resolve_capability_scoped_book_ids()` 成功返回
   `book-1:graph_query`，且 capability artifact ids 等于当前 lineage
   `_lineage_artifact_ids("artifact-1")`。

   必要修正建议：无。

   剩余风险：无。

7. PASS

   证据：新增测试
   `test_capability_scope_rejects_manifest_missing_current_stats_artifact` 在 checkpoint
   stats id 陈旧的基础上删除当前 manifest 的 `artifact-1-stats`，并确认
   `_resolve_capability_scoped_book_ids()` 抛出 `unknown or not-ready`。实现路径中
   `_validate_artifact_subset()` 对 required kinds 执行 `required_kinds.issubset`
   检查，缺失 stats artifact 无法满足 `GRAPH_EXTRACT_CORE_ARTIFACT_KINDS`。

   必要修正建议：无。

   剩余风险：无。

8. PASS

   证据：新增测试
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint` 修改当前
   manifest stats artifact 的 `stageFingerprint`，并确认 bridge fail closed。
   `_validate_artifact_subset()` 明确比较 artifact `stageFingerprint` 与 book state
   中对应 stage fingerprint。

   必要修正建议：无。

   剩余风险：测试只改 stage fingerprint，没有分别改 provider fingerprint 和
   corpus content hash；这些属于固定基准第 4 条的剩余覆盖风险，不是本条阻断。

9. PASS

   证据：`git status --short` 和 `git diff --stat` 显示本次实现仅修改
   `python/qmd_graphrag/bridge.py` 与
   `test/python/test_graphrag_bridge_scope.py`。未修改 GraphRAG vendor、输出格式、
   research 子命令或批处理主流程。

   必要修正建议：无。

   剩余风险：无。

10. PASS

    证据：`status.yaml` 的 `verification.passed` 记录以下验证已通过：
    `python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`、
    `python -m py_compile python/qmd_graphrag/bridge.py test/python/test_graphrag_bridge_scope.py`、
    针对两个真实失败 book 的 `_load_graph_capabilities` probe、
    `npm run test:node -- test/cli.test.ts -t "reopens query-ready 'graph capability' projection gate failures"`、
    `npm run test:node -- test/book-job-state.test.ts`、`npm run typecheck` 和
    `git diff --check`。`status.yaml` 同时说明早先
    `-t "capabilityScope references unknown"` 未匹配测试，未计入验证。

    必要修正建议：无。

    剩余风险：本审计未复跑验证命令；如果工作区在验证后继续变化，应重新执行固定
    验收命令。

## 总体结论

实现满足 Agent A 固定开发审计基准。Python bridge 已将 query-ready lineage 与
validation 的 artifact 选择改为当前 manifest 优先，并保持 artifact gate、
producer run id、fingerprint、content hash、book-scoped path、Parquet 和 LanceDB
完整性校验。新增 Python 测试覆盖真实陈旧 checkpoint stats artifact id 恢复、
manifest 缺失 fail closed、producer run mismatch fail closed 和 fingerprint
mismatch fail closed。

verdict: development_audit_passed
