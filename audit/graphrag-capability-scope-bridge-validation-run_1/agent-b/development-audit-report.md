# Agent B 开发审计报告

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1/agent-b/development-audit-criteria.md`

重点审计范围：

- `python/qmd_graphrag/bridge.py`
- `test/python/test_graphrag_bridge_scope.py`
- TypeScript 对照实现 `src/graphrag/capability-catalog.ts`
- `status.yaml` 中记录的验证命令与真实失败书 probe

## 发现项

### B-1：Python lineage projection 未读取 run records，仍未完全等价于 TypeScript
`projectQueryReadyLineage()`

严重级别：高

证据：

- TypeScript `projectQueryReadyLineage()` 通过 `loadCheckpointCandidates()` 获取
 候选状态；该函数合并当前 `checkpoints.yaml` 与 `catalog/runs.yaml` 指向的
  per-run records，并按时间排序后选择有效 producer checkpoint。
- 当前 Python bridge 的 `_succeeded_checkpoint_by_stage()` 只读取
  `books/<bookId>/checkpoints.yaml` 中 `status == succeeded` 的 checkpoint，并按
  stage 建 map；实现中没有读取 `catalog/runs.yaml` 或 `books/<bookId>/runs/*.yaml`
  的逻辑。
- 本次实现新增的 `_artifact_ids_for_producer_stage()` 已把 artifact 选择从
  checkpoint artifact ids 改为当前 `artifacts.yaml` 的
  `bookId + stage + producerRunId + kind` 选择，但 producer run id 的来源仍只
  是 checkpoint，不包括 TypeScript 侧可用的 run record 候选。

影响：

当 checkpoint 缺失、被旧状态覆盖、或不能代表最新有效 producer lineage，而
run record 中仍存在 TypeScript 可接受的有效 stage evidence 时，TypeScript
`projectQueryReadyLineage()` 可能判定 ready，Python bridge 仍会判定 not-ready。
这会保留一类 TypeScript/Python ready 判定漂移，违反固定开发基准第 1 条。

必要修正建议：

在 Python bridge 中补齐与 TypeScript `loadCheckpointCandidates()` 等价的候选
加载逻辑：读取 `catalog/runs.yaml` 与 `books/<bookId>/runs/<runId>.yaml`，将有效
run record 转换为 checkpoint candidate，按 `finishedAt ?? startedAt` 与
checkpoint 一起排序，再为 `graph_extract`、`community_report`、`embed` 和
`query_ready` 选择满足 book identity、stage fingerprint、provider fingerprint、
content hash、非 bootstrap 与 artifact validator 的候选。新增测试应覆盖
checkpoint 不可用但 run record 与当前 manifest 可证明 ready 的场景，并断言
Python 与 TypeScript projection 一致。

## 风险

1. 当前修复覆盖了真实失败的 stale stats artifact id 形态，但未覆盖 run record
   candidate 形态。后续恢复流程若依赖 run records 补全 producer lineage，Python
   bridge 仍可能拒绝 TypeScript 已投影为 ready 的 capability。
2. `_artifact_ids_for_producer_stage()` 在找到同一 run 的部分 artifact 时会返回
   partial selection，再由 `_validate_artifact_subset()` fail closed。该行为安全，
   但错误仍统一表现为 unknown/not-ready，定位时需要结合 validator 细节。
3. request scope 约束目前保持强制执行；后续若为解决 B-1 引入 run record-derived
   capability，必须继续只解析请求中的 `graphCapabilityIds`，不得自动扩展 scope。

## 逐条基准结论

1. FAIL：实现必须与 TypeScript `projectQueryReadyLineage()` 的 artifact
   projection 语义对齐。

   证据：当前 Python artifact selection 已按当前 manifest 的
   `bookId + stage + producerRunId + kind` 选择，和 TypeScript
   `artifactIdsForProducerStage()` / `artifactIdsForQueryReadyGate()` 的核心
   artifact 选择规则一致。但 Python producer run id 只来自 succeeded
   checkpoints；TypeScript `projectQueryReadyLineage()` 会合并 checkpoint 和 run
   record candidates 后选择有效 producer checkpoint。因此实现仍不完整等价。

   必要修正建议：见发现项 B-1。

2. PASS：实现必须区分 checkpoint 历史 artifact ids 与当前 manifest 真源。

   证据：新增 `_artifact_ids_for_producer_stage()` 优先从当前 `artifacts.yaml`
   加载出的 `artifacts_by_id` 中按 `bookId`、`stage`、`producerRunId` 和
   `required_kinds` 选择 artifact ids；只有无 producer run id 或无当前 manifest
   selection 时才回退 checkpoint artifact ids。`_load_query_ready_lineage_artifact_ids()`
   和 `_validate_query_ready_artifacts()` 均改用该 helper。

   必要修正建议：无。

3. PASS：实现必须保持 `graphCapabilityIds` 不得越过请求 scope 的约束。

   证据：`_load_graph_capabilities()` 只处理并返回 `requested_ids` 中的 capability；
   `_validate_capabilities_against_request_scope()` 明确检查解析出的
   `capabilityId` 必须在 `capabilityScope.graphCapabilityIds` 中，否则抛出
   `unrequested graphCapabilityId resolved`。

   必要修正建议：无。

4. PASS：实现必须保持 `selectedBookIds` 不得被 capability 解析越界的约束。

   证据：`_validate_capabilities_against_request_scope()` 检查 capability book id
   必须属于 `selectedBookIds`；`_resolve_capability_scoped_book_ids()` 也在解析后
   检查 `graphCapabilityIds resolve outside selectedBookIds`。既有测试
   `test_capability_scope_rejects_capability_outside_selected_books` 覆盖该边界。

   必要修正建议：无。

5. PASS：实现必须保持 source、document、content hash 和 artifact ids request
   scope 上界约束。

   证据：`_validate_capabilities_against_request_scope()` 对非空 `sourceIds`、
   `documentIds`、`contentHashes` 和 `artifactIds` 分别执行上界检查；artifact ids
   要求 capability artifact set 是请求 artifact set 的子集。既有 request scope
   测试继续覆盖 document/content/artifact 边界。

   必要修正建议：无。

6. PASS：实现必须不降低对 bootstrap、跨书、缺文件、旧 hash 和旧 provider
   产物的拒绝。

   证据：`_validate_query_ready_artifacts()` 继续要求 checkpoint content hash、
   stage fingerprint 和 provider fingerprint 匹配 book state；
   `_validate_artifact_subset()` 继续检查 artifact `bookId`、kind、stage、
   producerRunId、stage fingerprint、provider fingerprint、`corpusContentHash`、
   book-scoped path、文件存在性、content hash、Parquet 完整性和 LanceDB 完整性。
   这些校验未被本次 diff 放宽。

   必要修正建议：无。

7. PASS：新测试必须覆盖真实失败形态：checkpoint stale stats id 与 manifest
   current stats artifact。

   证据：新增
   `test_capability_scope_derives_from_current_manifest_when_checkpoint_stats_id_is_stale`
   将 `graph_extract` checkpoint 中的 stats artifact id 替换为
   `stale-stats-artifact`，保留 manifest 中同一 producer run 的
   `artifact-1-stats`，并断言 capability 可解析且 lineage artifact ids 使用当前
   manifest 的完整集合。

   必要修正建议：无。

8. PASS：新测试必须覆盖 manifest 缺失或 producer run id 错配时仍失败。

   证据：新增
   `test_capability_scope_rejects_manifest_missing_current_stats_artifact` 覆盖 manifest
   缺失 current stats artifact；
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 覆盖 producer run
   id 错配；`test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint`
   还覆盖 stage fingerprint 错配 fail closed。

   必要修正建议：无。

9. PASS：实现必须通过真实失败书的 Python bridge 复现探针。

   证据：`status.yaml` 的 `verification.passed` 记录真实失败书 Python bridge probe：
   `_load_graph_capabilities` 针对 `book-356ff4920cdf-0bbd8bdb` 和
   `book-2d1d667301e9-e5c877e8` 已通过。该记录直接覆盖本 case 的两个触发书。

   必要修正建议：无。

10. PASS：实现和审计文档不得提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或运行
    日志。

    证据：当前 `git status --short --untracked-files=all` 只显示
    `python/qmd_graphrag/bridge.py`、`test/python/test_graphrag_bridge_scope.py` 和
    本 case `status.yaml`；`git diff --name-only` 只显示 Python bridge 与 Python
    测试文件。未看到 `graph_vault`、`.qmd`、`inbox`、`tmp`、运行日志或
    `.tmp-tests` 进入当前 diff。

    必要修正建议：无。

## 总体结论

本次实现正确修复了真实失败的核心 stale checkpoint artifact id 问题，并保持了
request scope、producer run id、fingerprint/provider/content hash、book-scoped
path 和文件完整性校验。但它尚未实现 TypeScript `projectQueryReadyLineage()` 的
run record candidate 语义，因此 Python bridge 与 TypeScript artifact projection
仍不完全一致。固定开发审计基准第 1 条未通过。

verdict: development_audit_failed
