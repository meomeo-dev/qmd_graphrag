# GraphRAG 阶段门控与每书构建状态审计报告

审计对象：当前未提交工作区。

审计基准：
`audit/graphrag-artifact-gate-recovery-run_1/agent-a/baseline.md`
中的 10 条固定标准。

审计结论：PASS。

说明：本审计未运行测试。任务约束只允许写入本报告，测试执行可能写入
临时目录、缓存或状态文件。本报告基于当前代码、测试和文档静态证据。

## 逐条结论

### 1. `query_ready` 不得单独视为充分

结论：PASS。

证据：

- `src/graphrag/capability-catalog.ts:129` 定义
  `validateQueryReadyArtifacts`，在发布 capability 前重查 book、checkpoint
  与 artifact lineage。
- `src/graphrag/capability-catalog.ts:173` 到 `188` 要求
  `graph_extract`、`community_report`、`embed`、`query_ready` 四个 checkpoint
  均匹配 content hash、stage fingerprint 与 provider fingerprint。
- `src/graphrag/capability-catalog.ts:206` 到 `260` 分别验证 producer
  stage artifacts、`query_ready` artifacts 与完整 lineage artifact set。
- `src/job-state/repository.ts:2359` 到 `2390` 在写入 succeeded
  `query_ready` checkpoint 前强制验证 producer stages、查询 artifacts 与
  graph identity。

阻断真实 EPUB 闭环：否。该标准已满足。

### 2. Graph extract readiness 必须要求全部核心 GraphRAG artifacts

结论：PASS。

证据：

- `src/job-state/artifact-validation.ts:22` 到 `30` 将 documents、text units、
  entities、relationships、communities、context JSON、stats JSON 定义为
  `GRAPH_EXTRACT_CORE_ARTIFACT_KINDS`。
- `src/job-state/graphrag-book.ts:60` 到 `66` 将 `graph_extract` 的阶段要求
  绑定到 `GRAPH_EXTRACT_CORE_ARTIFACT_KINDS`。
- `src/job-state/graphrag-book.ts:913` 到 `989` 收集 book-scoped output 时
  逐项记录 documents、text units、entities、relationships、communities、
  context JSON 与 stats JSON。
- `test/book-job-state.test.ts:2096` 到 `2177` 覆盖缺失 graph stats artifact
  时拒绝 `query_ready` 的负例。

阻断真实 EPUB 闭环：否。该标准已满足。

### 3. Community report readiness 必须绑定相同书籍身份与 lineage

结论：PASS。

证据：

- `src/job-state/artifact-validation.ts:510` 到 `556` 校验 artifact 的 bookId、
  producerRunId、stageFingerprint、providerFingerprint 与 corpus content hash。
- `src/job-state/artifact-validation.ts:583` 到 `596` 要求 GraphRAG 输出为
  `books/<bookId>/output` 下的 book-scoped artifact。
- `src/graphrag/capability-catalog.ts:206` 到 `226` 对 `community_report`
  producer checkpoint 使用同一 book、producer run、stage fingerprint、
  provider fingerprint 和 content hash 校验。
- `src/job-state/graphrag-book.ts:1047` 到 `1068` 校验输出 producer manifest
  的 bookId、sourceHash、documentId、contentHash、providerFingerprint、
  outputDir 与全部 stage fingerprints。

阻断真实 EPUB 闭环：否。该标准已满足。

### 4. Embed readiness 必须要求 validated LanceDB artifact 与稳定 hash

结论：PASS。

证据：

- `src/job-state/artifact-validation.ts:16` 到 `20` 定义必需 LanceDB tables。
- `src/job-state/artifact-validation.ts:111` 到 `127` 只用 required table 的
  `data/*.lance` 与 `qmd_row_count.json` 计算稳定目录 hash。
- `src/job-state/artifact-validation.ts:193` 到 `216` 校验 LanceDB 路径必须是
  完整目录，并逐表校验数据与正行数 sidecar。
- `src/job-state/artifact-validation.ts:432` 到 `450` 对 `lancedb_index`
  执行 LanceDB 校验并比对 content hash，不接受任意目录。
- `test/book-job-state.test.ts:1554` 到 `1599` 覆盖缺失 row-count sidecar 时
  embed 不可恢复的负例。

阻断真实 EPUB 闭环：否。该标准已满足。

### 5. Graph capability 只能在 checkpoint 与 manifest 均验证时 ready

结论：PASS。

证据：

- `src/contracts/graph-enhancement.ts:53` 到 `64` 要求 `GraphCapability`
  的 `readinessSource` 固定为
  `validated_checkpoint_plus_validated_manifest`。
- `src/graphrag/capability-catalog.ts:322` 到 `362` 过滤显式 capability：
  必须 ready、身份匹配、artifactIds 被 query-ready lineage 覆盖，且
  `validateQueryReadyArtifacts` 通过。
- `src/graphrag/capability-catalog.ts:397` 到 `444` 派生 capability 前先验证
  query-ready lineage，再写入 `ready: true`。
- `src/job-state/repository.ts:2442` 到 `2548` 仅在 succeeded `query_ready`
  checkpoint 通过前置校验后发布 graph capabilities。

阻断真实 EPUB 闭环：否。该标准已满足。

### 6. QMD-only 候选不得因 hash 相同但身份不匹配而升级为 GraphRAG

结论：PASS。

证据：

- `src/query/qmd-candidates.ts:136` 到 `145` 只有 contentHash 唯一匹配
  document identity 时才绑定 graph identity；歧义时保持 QMD 投影。
- `src/graphrag/capability-catalog.ts:532` 到 `550` 仅按 documentId、
  sourceId，或唯一 contentHash 匹配 capability。
- `test/unified-query.test.ts:879` 到 `940` 覆盖不按 qmd collection path
  匹配 graph capability 的负例。
- `test/unified-query.test.ts:1356` 到 `1446` 覆盖 content-hash-only 且
  graph hash 歧义时不匹配 capability 的负例。

阻断真实 EPUB 闭环：否。该标准已满足。

### 7. 每本书必须暴露可检查的 QMD state 与 GraphRAG state

结论：PASS。

证据：

- `src/contracts/book-job.ts:219` 到 `247` 定义 `BookResumeStageState` 与
  `BookResumePlan`，暴露 stageStates、completedStages、staleStages 与 canQuery。
- `src/job-state/repository.ts:669` 到 `805` 将 missing、failed、pending、
  stale、artifact_missing、ready 明确投影到每阶段状态。
- `src/job-state/repository.ts:1510` 到 `1576` 暴露
  `GraphEnhancementState`，包含 status、checkpointIds、artifactIds 与
  capabilityIds。
- `scripts/graphrag/batch-epub-workflow.mjs:1168` 到 `1174` 在 batch item
  checkpoint 中持久化 `qmdBuildStatus`、`graphBuildStatus` 与
  `graphQueryStatus`。
- `scripts/graphrag/batch-epub-workflow.mjs:1975` 到 `2023` 定义 QMD build
  状态证据；`scripts/graphrag/batch-epub-workflow.mjs:1817` 到 `1931`
  定义 GraphRAG build 状态证据。

阻断真实 EPUB 闭环：否。该标准已满足。

### 8. 默认 batch 路径必须真实运行 QMD 与 GraphRAG

结论：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3300` 到 `3307` 默认 `runItem`
  先 normalize EPUB，再执行 GraphRAG resume，再执行 CLI/QMD 检查。
- `scripts/graphrag/batch-epub-workflow.mjs:3261` 到 `3297` 的默认
  `runCliChecks` 包含 `qmd embed`、search、vsearch、query、auto query 与
  `qmd query --graphrag`。
- `scripts/graphrag/resume-book-workspace.mjs:615` 到 `669` 仅当
  `resumePlan.nextStage == null` 时直接进入 ready/query。
- `scripts/graphrag/resume-book-workspace.mjs:671` 到 `763` 对
  `query_ready` 执行真实 readiness stage 校验并写 checkpoint。
- `scripts/graphrag/resume-book-workspace.mjs:778` 到 `819` 对
  `graph_extract`、`community_report`、`embed` 调用 GraphRAG `graphIndex`
  工作流。
- `test/cli.test.ts:1565` 覆盖 completed-manifest 只标注默认工作、不跳过
  真实构建的用例。

阻断真实 EPUB 闭环：否。该标准已满足。

### 9. 失败、不完整或 stale stage 不得静默解锁下游 graph query

结论：PASS。

证据：

- `src/job-state/repository.ts:698` 到 `760` 将 failed、pending、stale 与
  artifact_missing 阶段设为未满足。
- `src/job-state/repository.ts:797` 到 `805` 只有 `nextStage === null` 时
  `canQuery` 才为 true。
- `src/query/unified-router.ts:481` 到 `495` 对显式 `--graphrag` 且无
  capability 的请求返回 typed capability error，不回退为普通 QMD。
- `scripts/graphrag/batch-epub-workflow.mjs:2151` 到 `2212` 对已 completed
  item 的闭环状态重新校验；缺失 command、QMD、GraphRAG build 或 graph query
  证据时重新打开为 pending。
- `test/cli-graphrag-route.test.ts:750` 到 `799` 覆盖 stats artifact 缺失时
  auto route 不升级到 GraphRAG。
- `test/book-job-state.test.ts:2403` 到 `2524` 覆盖单书失败不回滚其他书，
  且失败书 `canQuery` 为 false。

阻断真实 EPUB 闭环：否。该标准已满足。

### 10. 审计用测试或 fixture 必须覆盖四类负例

结论：PASS。

证据：

- 缺失 stats：`test/book-job-state.test.ts:2096` 到 `2177` 覆盖缺失
  graph stats artifact 时拒绝 `query_ready`；`test/cli-graphrag-route.test.ts:750`
  到 `799` 覆盖 auto route 不升级。
- 缺失 lineage stages：`test/book-job-state.test.ts:1999` 到 `2089` 覆盖
  `query_ready` 在 producer stages 未 succeeded 时被拒绝。
- mixed identities：`test/unified-query.test.ts:1001` 到 `1033` 覆盖
  graph identity 与 book state 不匹配时不派生 capability；同文件
  `1356` 到 `1446` 覆盖 content hash 歧义时不匹配 capability。
- incomplete manifests：`test/book-job-state.test.ts:1932` 到 `1993` 覆盖
  checkpoint 引用缺失 artifactId 的负例；`src/job-state/artifact-validation.ts:510`
  到 `515` 将 artifact manifest 中不存在或 bookId 不匹配的 artifactId
  判为 missing。

阻断真实 EPUB 闭环：否。该标准已满足。

## 总体结论

总体结论：PASS。

当前实现以 validated checkpoint、validated artifact manifest、producer
run lineage、stage/provider fingerprint、book-scoped output、qmd corpus
registration 与 graph identity 共同构成 GraphRAG 查询门控。未发现会阻断真实
EPUB 闭环的 FAIL 项。
