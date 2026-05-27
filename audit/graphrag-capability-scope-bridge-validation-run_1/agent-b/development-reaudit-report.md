# Agent B 开发复审报告

审计对象：GraphRAG capability scope bridge validation 当前实现。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1/agent-b/development-audit-criteria.md`

复审重点：上次阻断项 B-1，即 Python bridge 的 run record candidate
语义是否已与 TypeScript `projectQueryReadyLineage()` 对齐。

## 发现项

未发现新的阻断项。上一轮 FAIL 的 Python bridge 未读取
`catalog/runs.yaml` 与 per-run records 问题已修复。

证据：

- TypeScript 对照实现中，`runRecordToCheckpointCandidate()` 将 run record
  映射为 checkpoint candidate，并使用 `contentHash = expectedContentHash(book)`、
  `stageFingerprint = metadata.stageFingerprint ?? inputFingerprint`、
  `providerFingerprint = metadata.providerFingerprint ?? book.providerFingerprint`；
  见 `src/graphrag/capability-catalog.ts:159` 至 `src/graphrag/capability-catalog.ts:178`。
- TypeScript `loadCheckpointCandidates()` 合并 `checkpoints.yaml` 与
  `catalog/runs.yaml` backed run records，并按 `finishedAt ?? startedAt`
  降序选择候选；见 `src/graphrag/capability-catalog.ts:181` 至
  `src/graphrag/capability-catalog.ts:219`。
- Python 当前实现已新增 `_run_record_to_checkpoint_candidate()`、
  `_load_run_record_candidates()` 和 `_load_checkpoint_candidates()`，字段映射、
  run catalog 读取、per-run record 读取及时间排序与 TypeScript 语义一致；
  见 `python/qmd_graphrag/bridge.py:590` 至
  `python/qmd_graphrag/bridge.py:654`。
- Python `_project_query_ready_lineage()` 已改为基于合并后的 candidates
  选择 `graph_extract`、`community_report`、`embed` 和 `query_ready`
  evidence；见 `python/qmd_graphrag/bridge.py:843` 至
  `python/qmd_graphrag/bridge.py:910`。
- 新增测试覆盖 checkpoint stage 缺失但 run record candidate 可恢复的场景，以及
  run record stage fingerprint 证据陈旧时 fail closed；见
  `test/python/test_graphrag_bridge_scope.py:1148` 至
  `test/python/test_graphrag_bridge_scope.py:1223`。

## 风险

1. Python 仍未使用 Zod schema 级别的结构化解析，格式异常的 YAML 主要通过
   后续 identity、fingerprint、artifact 与文件完整性校验 fail closed。该风险
   不构成本次基准 FAIL，但后续可考虑增加更明确的 schema validation。
2. `_artifact_ids_for_producer_stage()` 保留 checkpoint artifact ids fallback；
   当前 fallback 仍要求 artifact id 存在于当前 `artifacts.yaml`，并经过
   `bookId`、stage、producerRunId、fingerprint、provider、content hash、路径和
   文件完整性校验，因此未观察到 ready 放宽。后续若修改该 helper，应继续保持
   当前 manifest 为真源。
3. `status.yaml` 记录了真实失败书 probe 已通过；本次复审未重复访问真实失败
   graph vault，仅复核了记录、实现、diff 与 capability scope 单测。

## 逐条基准结论

1. PASS：实现必须与 TypeScript `projectQueryReadyLineage()` 的 artifact
   projection 语义对齐。

   证据：TypeScript `projectQueryReadyLineage()` 从当前 manifest 读取 artifacts，
   合并 checkpoint 与 run record candidates，选择有效 producer checkpoints，
   再按 producer run id 投影当前 manifest artifacts；见
   `src/graphrag/capability-catalog.ts:397` 至
   `src/graphrag/capability-catalog.ts:465`。Python 当前实现对应新增
   `_load_run_record_candidates()`、`_load_checkpoint_candidates()`、
   `_select_producer_checkpoint()`、`_select_query_ready_checkpoint()` 和
   `_project_query_ready_lineage()`；见 `python/qmd_graphrag/bridge.py:612`
   至 `python/qmd_graphrag/bridge.py:910`。上一轮缺失的 run record candidate
   语义已补齐。

   必要修正建议：无。

   剩余风险：Python 未执行 TS 同级别 schema safeParse；当前依赖后续严格校验
   fail closed。

2. PASS：实现必须区分 checkpoint 历史 artifact ids 与当前 manifest 真源。

   证据：TypeScript `artifactIdsForProducerStage()` 只从当前 artifacts manifest
   中按 `bookId + stage + producerRunId + kind` 选择 artifact ids；见
   `src/graphrag/capability-catalog.ts:98` 至
   `src/graphrag/capability-catalog.ts:113`。Python
   `_artifact_ids_for_producer_stage()` 也优先从 `artifacts_by_id` 当前 manifest
   按相同键选择；见 `python/qmd_graphrag/bridge.py:700` 至
   `python/qmd_graphrag/bridge.py:718`。checkpoint id fallback 只在没有
   manifest selection 时触发，且仍要求 id 存在于当前 manifest 并通过
   `_validate_artifact_subset()` 校验；见 `python/qmd_graphrag/bridge.py:719`
   至 `python/qmd_graphrag/bridge.py:723` 和
   `python/qmd_graphrag/bridge.py:1477` 至
   `python/qmd_graphrag/bridge.py:1558`。

   必要修正建议：无。

   剩余风险：fallback 语义应保持只作为当前 manifest 内 artifact id 的兼容路径，
   不得退回为信任 checkpoint 历史 artifact ids。

3. PASS：实现必须保持 `graphCapabilityIds` 不得越过请求 scope 的约束。

   证据：`_load_graph_capabilities()` 只处理 `requested_ids`，并只为请求中的
   `:graph_query` capability 派生能力；见 `python/qmd_graphrag/bridge.py:1218`
   至 `python/qmd_graphrag/bridge.py:1227`。随后
   `_validate_capabilities_against_request_scope()` 明确拒绝未请求的
   `capabilityId`；见 `python/qmd_graphrag/bridge.py:1096` 至
   `python/qmd_graphrag/bridge.py:1097`。

   必要修正建议：无。

   剩余风险：无新增风险。

4. PASS：实现必须保持 `selectedBookIds` 不得被 capability 解析越界的约束。

   证据：`_validate_capabilities_against_request_scope()` 检查 capability 的
   `bookId` 必须属于 `selectedBookIds`；见
   `python/qmd_graphrag/bridge.py:1098` 至
   `python/qmd_graphrag/bridge.py:1099`。测试
   `test_capability_scope_rejects_capability_outside_selected_books` 覆盖
   `selectedBookIds=["book-1"]` 但请求 `book-2:graph_query` 时失败；见
   `test/python/test_graphrag_bridge_scope.py:1400` 至
   `test/python/test_graphrag_bridge_scope.py:1410`。

   必要修正建议：无。

   剩余风险：无新增风险。

5. PASS：实现必须保持 source、document、content hash 和 artifact ids request
   scope 上界约束。

   证据：`_validate_capabilities_against_request_scope()` 分别检查 `sourceIds`、
   `documentIds`、`contentHashes` 和 `artifactIds` 上界；见
   `python/qmd_graphrag/bridge.py:1100` 至
   `python/qmd_graphrag/bridge.py:1111`。测试
   `test_capability_scope_rejects_identity_outside_request_scope` 覆盖 document
   scope 越界失败；见 `test/python/test_graphrag_bridge_scope.py:1412`
   至 `test/python/test_graphrag_bridge_scope.py:1434`。

   必要修正建议：无。

   剩余风险：无新增风险。

6. PASS：实现必须不降低对 bootstrap、跨书、缺文件、旧 hash 和旧 provider
   产物的拒绝。

   证据：`_checkpoint_matches_book()` 继续拒绝 bootstrap、跨书、非 succeeded、
   content hash、stage fingerprint 和 provider fingerprint 不匹配的 checkpoint；
   见 `python/qmd_graphrag/bridge.py:657` 至
   `python/qmd_graphrag/bridge.py:674`。`_validate_artifact_subset()` 继续验证
   artifact book、kind、stage、producerRunId、stage fingerprint、provider
   fingerprint、corpus content hash、book-scoped path、文件存在性、content hash、
   Parquet 和 LanceDB 完整性；见 `python/qmd_graphrag/bridge.py:1477` 至
   `python/qmd_graphrag/bridge.py:1558`。非 portable path 测试继续覆盖路径拒绝；
   见 `test/python/test_graphrag_bridge_scope.py:1530` 至
   `test/python/test_graphrag_bridge_scope.py:1542`。

   必要修正建议：无。

   剩余风险：无新增风险。

7. PASS：新测试必须覆盖真实失败形态：checkpoint stale stats id 与 manifest
   current stats artifact。

   证据：测试
   `test_capability_scope_derives_from_current_manifest_when_checkpoint_stats_id_is_stale`
   将 checkpoint 中 graph_extract stats artifact id 替换为
   `stale-stats-artifact`，但保留 manifest 当前 stats artifact，并断言 capability
   解析成功且 lineage artifact ids 为当前 manifest 完整集合；见
   `test/python/test_graphrag_bridge_scope.py:1123` 至
   `test/python/test_graphrag_bridge_scope.py:1146`。

   必要修正建议：无。

   剩余风险：无新增风险。

8. PASS：新测试必须覆盖 manifest 缺失或 producer run id 错配时仍失败。

   证据：
   `test_capability_scope_rejects_manifest_missing_current_stats_artifact`
   删除当前 manifest stats artifact 后断言 not-ready；见
   `test/python/test_graphrag_bridge_scope.py:1225` 至
   `test/python/test_graphrag_bridge_scope.py:1249`。
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 将当前 stats
   artifact 的 `producerRunId` 改为旧 run 后断言 not-ready；见
   `test/python/test_graphrag_bridge_scope.py:1251` 至
   `test/python/test_graphrag_bridge_scope.py:1273`。额外测试
   `test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint`
   覆盖 stage fingerprint 错配 fail closed；见
   `test/python/test_graphrag_bridge_scope.py:1275` 至
   `test/python/test_graphrag_bridge_scope.py:1297`。

   必要修正建议：无。

   剩余风险：无新增风险。

9. PASS：实现必须通过真实失败书的 Python bridge 复现探针。

   证据：`status.yaml` 的 `verification.passed` 记录了
   `_load_graph_capabilities` 针对真实失败书
   `book-356ff4920cdf-0bbd8bdb` 和 `book-2d1d667301e9-e5c877e8`
   的 Python bridge probe 已通过；见
   `audit/graphrag-capability-scope-bridge-validation-run_1/status.yaml:63`
   至 `audit/graphrag-capability-scope-bridge-validation-run_1/status.yaml:78`。
   本次复审还执行了
   `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`，
   结果为 18 个测试通过。

   必要修正建议：无。

   剩余风险：未重复运行真实失败书 probe；以 `status.yaml` 的通过记录为证据。

10. PASS：实现和审计文档不得提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或运行
    日志。

    证据：当前 `git status --short --untracked-files=all` 仅显示
    `python/qmd_graphrag/bridge.py`、`test/python/test_graphrag_bridge_scope.py`
    和本 case `status.yaml`；`git diff --name-only` 仅显示 Python bridge 与
    Python 测试文件。针对 `graph_vault`、`.qmd`、`inbox`、`tmp`、`.tmp-tests`
    与 `.log` 的 status grep 未返回结果。`git diff --check` 通过。

    必要修正建议：无。

    剩余风险：本报告自身为新增允许写入文件，不属于受禁运行产物。

## 验证

- 已执行：
  `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`
  ，结果为 18 个测试通过。
- 已执行：`git diff --check`，结果通过。
- 已执行：`git status --short --untracked-files=all` 与受禁路径 grep，未发现
  `graph_vault`、`.qmd`、`inbox`、`tmp`、`.tmp-tests` 或运行日志进入当前状态。

verdict: development_audit_passed
