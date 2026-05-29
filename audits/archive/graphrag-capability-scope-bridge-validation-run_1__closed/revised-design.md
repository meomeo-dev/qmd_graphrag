# GraphRAG Capability Scope Bridge Validation Revised Design

## Problem

真实批处理 `epub-batch-20260526-after-sidecar-fix` 已越过
GraphRAG identity sidecar 恢复问题，但在已达到 `query_ready` 的图书查询
验证阶段失败。失败错误为：

`capabilityScope references unknown or not-ready graphCapabilityId(s):
<bookId>:graph_query`

失败图书包括：

- `book-356ff4920cdf-0bbd8bdb`
- `book-2d1d667301e9-e5c877e8`

TypeScript 侧 `projectQueryReadyLineage()` 和 `loadGraphQueryCapabilities()`
能够从当前 `artifacts.yaml`、checkpoint 和 run record 组合出有效
`graph_query` capability。Python bridge 侧 `_load_graph_capabilities()`
重新验证同一 capability 时失败，导致查询前 scope validation 拒绝请求。

本地复现实验显示 Python bridge 的 `_validate_query_ready_artifacts()` 在
`graph_extract` producer 验证中失败。原因是 Python 的
`_load_query_ready_lineage_artifact_ids()` 只从 checkpoint 的
`artifactIds` 读取产物，再按 kind 过滤；真实恢复后的 checkpoint 中仍包含
一个旧的 stats artifact id，但当前 `artifacts.yaml` 已经记录了同一
`graph_extract` run 的当前 `graphrag_stats_json` artifact。TypeScript 侧已按
`stage + producerRunId + required kind` 从 manifest 选择当前产物，因此能够
恢复该状态；Python bridge 侧没有使用同一投影规则，形成验证漂移
（validation drift）。

## Invariants

1. Python bridge 不得接受未在当前 `artifacts.yaml` 中存在的 artifact id。
2. Python bridge 不得绕过 `query_ready` producer lineage、stage fingerprint、
   provider fingerprint、content hash、book-scoped output 或 artifact hash
   校验。
3. GraphRAG 查询 capability 必须只来源于当前有效的 `graph_extract`、
   `community_report`、`embed` 和 `query_ready` 状态。
4. `checkpoint.artifactIds` 可以作为历史线索，但不能覆盖当前 manifest 中按
   `stage + producerRunId + kind` 选择出的有效 artifact。
5. TypeScript capability projection 与 Python bridge scope validation 必须对
   同一 vault 状态给出一致 ready 判定。
6. 如果当前 manifest 无法按 producer run id 和 required kind 补齐产物，
   Python bridge 必须继续 fail closed。
7. request scope 约束必须保持强制执行：解析出的 capability id 必须属于
   `capabilityScope.graphCapabilityIds`，解析出的 book 必须属于
   `capabilityScope.selectedBookIds`，且 source、document、content hash 和
   artifact id 不得越过请求边界。
8. 修复不得修改 GraphRAG vendor、LLM 请求参数、输出渲染逻辑、research
   子命令或 EPUB 批处理主流程。
9. 修复不得让 bootstrap checkpoint、跨书产物、旧 provider fingerprint、
   旧 content hash 或缺失文件通过。
10. 修复后的错误分类仍应把真正缺失或不合法的 capability 作为本地阻断，
    而不是 transient 网络错误。
11. 真实 EPUB 处理必须在修复、审计和提交后继续运行，不能只停留在单元测试。

## Proposed Change

在 `python/qmd_graphrag/bridge.py` 中补齐与 TypeScript 相同的查询能力投影
规则，保持改动窄化在 bridge validation 层。

### Artifact Selection

新增或调整 Python helper：

- producer 和 `query_ready` 的候选状态必须同时包含
  `books/<bookId>/checkpoints.yaml` 中的 checkpoints，以及
  `catalog/runs.yaml` 指向的 `books/<bookId>/runs/<runId>.yaml` run records。
- 对 GraphRAG 高成本 producer stage，优先从当前 `artifacts.yaml` 中按
  `bookId + stage + producerRunId + requiredKinds` 选择 artifact ids。
- 对 `query_ready` gate，继续按 `community_report` 和 `embed` 的 producer
  run id 从当前 manifest 选择 `graphrag_community_reports_parquet` 和
  `lancedb_index`。
- 仅当 stage 没有 producer run id 或不属于高成本 GraphRAG producer 时，
  才回退到 checkpoint 的 `artifactIds`。

### Lineage Projection

`_load_query_ready_lineage_artifact_ids()` 应从已验证 producer checkpoints 和
当前 manifest 计算 lineage，而不是直接相信 checkpoint artifact ids。
它应返回：

- 当前 `graph_extract` run 的所有 core artifact kinds，包括
  `graphrag_stats_json`。
- 当前 `community_report` run 的 `graphrag_community_reports_parquet`。
- 当前 `embed` run 的 `lancedb_index`。
- `query_ready` gate 所需的当前 report 和 lancedb artifacts。

### Query-Ready Validation

`_validate_query_ready_artifacts()` 继续调用 `_validate_artifact_subset()`。
区别只是输入 artifact ids 改为当前 manifest 投影结果。校验边界保持不变：

- kind 必须属于 allowed kinds。
- artifact stage 必须匹配 producer stage。
- producer run id 必须匹配有效 checkpoint。
- stage fingerprint、provider fingerprint 和 corpus content hash 必须匹配。
- path 必须位于 `books/<bookId>/output/` 或 book-scoped lancedb 目录。
- content hash、parquet 文件完整性和 lancedb 完整性必须通过。

### Request Scope Validation

`_resolve_capability_scoped_book_ids()` 和
`_validate_capabilities_against_request_scope()` 的既有边界必须保留：

- 请求未列入 `graphCapabilityIds` 的 capability 不得被解析或使用。
- capability 解析出的 book 不得超出 `selectedBookIds`。
- `sourceIds`、`documentIds`、`contentHashes`、`artifactIds` 非空时必须作为
  上界约束。
- manifest projection 只决定 artifact ids 的当前有效集合，不改变请求 scope。

## Tests

新增 Python bridge 测试，覆盖：

1. checkpoint 中 `graph_extract` stats artifact id 陈旧，但当前 manifest 有同一
   producer run 的有效 stats artifact 时，`_load_graph_capabilities()` 通过。
2. 当前 manifest 缺失 stats artifact 时，同一 capability 继续 fail closed。
3. 当前 manifest 中 stats artifact producer run id 不匹配时，继续 fail closed。
4. 当前 manifest 中 stats artifact fingerprint、provider fingerprint 或 content
   hash 不匹配时，继续 fail closed。
5. checkpoint 缺失某个 producer stage 但同一 book 的 run record 能提供有效
   producer candidate 时，`_load_graph_capabilities()` 通过。
6. run record 缺失有效 stage fingerprint 证据时，同一 capability 继续
   fail closed。
7. 既有 capability scope 测试保持通过，证明没有放宽 selectedBookIds、
   graphCapabilityIds、sourceIds、documentIds、contentHashes 和 artifactIds
   边界。

回归验证命令：

- `python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`
- `npm run test:node -- test/cli.test.ts -t "capabilityScope references unknown"`
- `npm run test:node -- test/book-job-state.test.ts`
- `npm run typecheck`
- `git diff --check`

## Non-Goals

1. 不修复或重写历史运行产物。
2. 不把 GraphRAG capability catalog 作为 Python bridge 的唯一真源。
3. 不降低 artifact gate，只修复 artifact 选择来源与 TypeScript 投影一致性。
4. 不改变 qmd 查询、输出格式、research 命令、并发配置或 token 配置。
5. 不提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或 `.tmp-tests` 运行产物。
