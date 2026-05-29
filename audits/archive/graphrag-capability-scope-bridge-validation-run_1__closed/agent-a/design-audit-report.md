# Agent A 设计审计报告

审计对象：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-a/audit-criteria.md`

真实失败证据：`status.yaml` 记录批处理
`epub-batch-20260526-after-sidecar-fix` 中两个已 `query_ready` 图书在查询
scope validation 阶段失败，错误为
`capabilityScope references unknown or not-ready graphCapabilityId(s)`。

## 发现项

无阻断发现。设计说明的根因与本地实现边界一致：TypeScript 侧
`projectQueryReadyLineage()` 从当前 `artifacts.yaml` 按 stage、producer run id
和 kind 投影当前 lineage；Python bridge 的
`_load_query_ready_lineage_artifact_ids()` 仍以 checkpoint artifact ids 为主要
输入，导致 checkpoint 中陈旧 stats artifact id 覆盖当前 manifest 中同 producer
run 的有效 stats artifact，形成 validation drift。

## 风险

1. 设计要求 Python bridge 与 TypeScript 投影规则一致，但没有要求抽取共享测试
   fixture 或 golden vault 状态。实现阶段需要避免两套投影逻辑再次漂移。
2. 设计要求真实 EPUB 处理在修复、审计和提交后继续运行，但回归命令主要覆盖
   单元与 CLI 阻断场景。真实批处理续跑结果应作为开发审计或验收记录补充。
3. Python bridge 仍依赖本地文件 hash、Parquet 读取和 LanceDB 目录完整性检查。
   环境依赖异常应保持 fail closed，不能被误归类为 transient 网络错误。

## 逐条基准结论

1. PASS

   证据：Problem 明确描述 TS 侧
   `projectQueryReadyLineage()`、`loadGraphQueryCapabilities()` 能从当前
   `artifacts.yaml`、checkpoint 和 run record 组合出有效 `graph_query`
   capability，而 Python bridge `_load_graph_capabilities()` 重新验证时失败。
   设计进一步指出漂移点是 Python 的
   `_load_query_ready_lineage_artifact_ids()` 只从 checkpoint `artifactIds` 读取，
   未按当前 manifest 选择同一 producer run 的当前 artifact。

   必要修正建议：无。

2. PASS

   证据：Invariants 第 2、3 条要求不得绕过 `query_ready` producer lineage，
   GraphRAG 查询 capability 只能来源于当前有效的 `graph_extract`、
   `community_report`、`embed` 和 `query_ready` 状态。Query-Ready Validation
   继续调用 `_validate_artifact_subset()`，只改变输入 artifact ids 的投影来源。

   必要修正建议：无。

3. PASS

   证据：Invariants 第 1 条要求 Python bridge 不得接受未在当前
   `artifacts.yaml` 中存在的 artifact id。Artifact Selection 要求优先从当前
   `artifacts.yaml` 中按 `bookId + stage + producerRunId + requiredKinds` 选择
   artifact ids。Tests 第 2 条要求当前 manifest 缺失 stats artifact 时继续
   fail closed。

   必要修正建议：无。

4. PASS

   证据：Artifact Selection 明确要求非 `query_ready` 高成本 producer stage
   按 `bookId + stage + producerRunId + requiredKinds` 从当前 manifest 选择；
   对 `query_ready` gate，继续按 `community_report` 和 `embed` 的 producer run id
   选择 `graphrag_community_reports_parquet` 和 `lancedb_index`。这满足按
   `stage + producerRunId + kind` 选择当前 producer artifact 的要求。

   必要修正建议：无。

5. PASS

   证据：Invariants 第 2 条要求不得绕过 stage fingerprint、provider fingerprint
   和 content hash 校验。Query-Ready Validation 明确保留 stage fingerprint、
   provider fingerprint 和 corpus content hash 匹配。Tests 第 4 条要求 stats
   artifact 的 fingerprint、provider fingerprint 或 content hash 不匹配时继续
   fail closed。

   必要修正建议：无。

6. PASS

   证据：Query-Ready Validation 明确保留 book-scoped output path、content hash、
   parquet 文件完整性和 LanceDB 完整性校验；路径必须位于
   `books/<bookId>/output/` 或 book-scoped LanceDB 目录。Invariants 第 8 条也要求
   跨书产物、缺失文件等不得通过。

   必要修正建议：无。

7. PASS

   证据：Non-Goals 第 2 条明确不把 GraphRAG capability catalog 作为 Python
   bridge 的唯一真源。设计要求 `_validate_query_ready_artifacts()` 继续执行
   artifact subset validation，capability 不能绕过当前 manifest 与 lineage gate。

   必要修正建议：无。

8. PASS

   证据：Invariants 第 7 条要求修复不得修改 GraphRAG vendor、LLM 请求参数、
   输出渲染逻辑、research 子命令或 EPUB 批处理主流程。Non-Goals 第 4 条再次
   声明不改变 qmd 查询、输出格式、research 命令、并发配置或 token 配置。
   Proposed Change 将修改面限定在 `python/qmd_graphrag/bridge.py` 的 bridge
   validation 层。

   必要修正建议：无。

9. PASS

   证据：Tests 第 1 条要求覆盖 checkpoint 中 `graph_extract` stats artifact id
   陈旧，但当前 manifest 有同一 producer run 的有效 stats artifact 时，
   `_load_graph_capabilities()` 通过。该测试要求直接覆盖真实失败形态。

   必要修正建议：无。

10. PASS

    证据：Tests 第 2、3、4 条分别要求当前 manifest 缺失 stats artifact、
    stats artifact producer run id 不匹配、stats artifact fingerprint/provider
    fingerprint/content hash 不匹配时继续 fail closed。该设计覆盖缺失或不匹配
    manifest artifact 的失败路径。

    必要修正建议：无。

## 总体结论

设计满足 Agent A 的 10 条固定审计基准。方案将修复范围限定在 Python bridge
validation 的 artifact selection 与 lineage projection，保持 artifact gate、
producer lineage、fingerprint、content hash、book-scoped path、Parquet 和
LanceDB 完整性校验不变，并要求真实陈旧 checkpoint artifact id 场景及
manifest 缺失或不匹配场景回归测试。

verdict: design_audit_passed
