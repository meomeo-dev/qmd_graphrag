# Agent A 设计复审报告

审计对象：
`audit/graphrag-capability-scope-bridge-validation-run_1/revised-design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1/agent-a/audit-criteria.md`

复审结论：未发现阻断项。

## 阻断项

无。`revised-design.md` 在原设计基础上补充了 request scope 强约束和可执行
Python unittest 命令，同时保持 Agent A 固定基准要求的 artifact gate、
producer lineage、manifest 投影、fingerprint、content hash、book-scoped path、
Parquet 完整性和 LanceDB 完整性边界。

## 风险

1. TypeScript projection 与 Python bridge validation 仍是两套实现。设计要求对齐
   投影规则，但实现阶段仍需要用同一 fixture 覆盖陈旧 checkpoint artifact id
   场景，避免未来再次 validation drift。
2. 设计要求真实 EPUB 处理继续运行，但固定回归命令主要验证单元、CLI 和类型检查。
   真实批处理续跑结果应在开发审计或验收记录中补充。
3. request scope 约束已写入设计，但实现阶段需要确认
   `graphCapabilityIds`、`selectedBookIds`、`sourceIds`、`documentIds`、
   `contentHashes` 和 `artifactIds` 的上界约束没有因 manifest projection 被放宽。

## 逐条基准结论

1. PASS

   证据：Problem 明确解释 TypeScript 侧
   `projectQueryReadyLineage()` 和 `loadGraphQueryCapabilities()` 能从当前
   `artifacts.yaml`、checkpoint 和 run record 组合出有效 capability，而 Python
   bridge 的 `_load_query_ready_lineage_artifact_ids()` 只从 checkpoint
   `artifactIds` 读取产物，导致陈旧 stats artifact id 与当前 manifest 投影漂移。

2. PASS

   证据：Invariants 第 2、3 条要求不得绕过 `query_ready` producer lineage，
   capability 只能来源于当前有效的 `graph_extract`、`community_report`、`embed`
   和 `query_ready` 状态。Query-Ready Validation 继续调用
   `_validate_artifact_subset()`，只改变 artifact ids 的选择来源。

3. PASS

   证据：Invariants 第 1 条要求 Python bridge 不得接受未在当前
   `artifacts.yaml` 中存在的 artifact id。Artifact Selection 要求优先从当前
   manifest 选择 artifact ids；Tests 第 2 条要求 manifest 缺失 stats artifact
   时继续 fail closed。

4. PASS

   证据：Artifact Selection 要求 GraphRAG 高成本 producer stage 按
   `bookId + stage + producerRunId + requiredKinds` 从当前 `artifacts.yaml` 选择；
   Query-Ready gate 继续按 `community_report` 和 `embed` 的 producer run id 选择
   report 与 LanceDB artifact。这满足按 `stage + producerRunId + kind` 选择当前
   producer artifact 的固定基准。

5. PASS

   证据：Invariants 第 2 条和 Query-Ready Validation 明确保留 stage
   fingerprint、provider fingerprint 和 corpus content hash 校验。Tests 第 4 条
   要求 fingerprint、provider fingerprint 或 content hash 不匹配时继续
   fail closed。

6. PASS

   证据：Query-Ready Validation 明确保留 book-scoped path、content hash、Parquet
   文件完整性和 LanceDB 完整性校验；path 必须位于 `books/<bookId>/output/` 或
   book-scoped LanceDB 目录。

7. PASS

   证据：Non-Goals 第 2 条明确不把 GraphRAG capability catalog 作为 Python
   bridge 的唯一真源。设计要求 artifact gate 和 `_validate_artifact_subset()`
   继续执行，因此 explicit capability catalog 不能绕过 manifest 与 lineage
   validation。

8. PASS

   证据：Proposed Change 将修改面限定在 `python/qmd_graphrag/bridge.py` 的 bridge
   validation 层。Invariants 第 8 条和 Non-Goals 第 4 条明确不修改 vendor、输出
   格式、research 子命令或 EPUB 批处理主流程。

9. PASS

   证据：Tests 第 1 条要求覆盖 checkpoint 中 `graph_extract` stats artifact id
   陈旧，但当前 manifest 有同一 producer run 的有效 stats artifact 时，
   `_load_graph_capabilities()` 通过。

10. PASS

    证据：Tests 第 2、3、4 条要求当前 manifest 缺失 stats artifact、producer
    run id 不匹配、fingerprint/provider fingerprint/content hash 不匹配时继续
    fail closed，覆盖缺失或不匹配 manifest artifact 的失败路径。

## 总体结论

`revised-design.md` 满足 Agent A 固定审计基准。补充的 Request Scope Validation
和 unittest 命令解决了复审原因中提到的 graphCapabilityIds 边界和命令可执行性
问题；未发现需要阻断设计进入开发阶段的缺陷。

verdict: design_audit_passed
