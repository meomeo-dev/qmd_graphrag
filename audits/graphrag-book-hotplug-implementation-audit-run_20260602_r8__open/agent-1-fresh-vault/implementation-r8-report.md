# R8 实施审计报告：Agent 1 Fresh-Vault 场景

## 审计结论

- 审计状态：partial
- 固定基准：复用 R7
  `agent-1-fresh-vault/fixed-baseline.yaml`，未新增、删除、重命名或重排。
- 通过数：5
- 部分通过数：5
- 未通过数：0

本轮新增的 runtime gate 已明显加强。当前实现会只读读取包内
`BOOK_MANIFEST.json`、artifact metadata、runtime compatibility 和 producer
run summaries，并把 producer run 与 artifact metadata 进行语义绑定
(semantic binding)。伪造 artifactIds、伪造 provider fingerprint、缺失
metadata createdAt、伪造 runtime digest 均会 fail closed，且查询能力不会投影。

仍未完全满足 fresh-vault 生产合同的部分集中在：直接查询入口仍依赖
`catalog/books.yaml` 中间投影、目录级原子发布未实现、runtime compatibility
尚未完整校验 embedding/layout/reader 语义、rollback 与 crash visibility
测试不足。

## 基准逐项结果

| baselineId | 结果 | 说明 |
| --- | --- | --- |
| direct_query_entrypoint | partial | runtime gate 可从包内只读验证，但 `projectQueryReadyLineage()` 仍读取 `catalog/books.yaml` 构造 `BookJob`，还不是完全 package-only direct query。 |
| artifact_minimum_closure | pass | manifest 构造与运行时 gate 覆盖 GraphRAG 必需 artifact、bytes、sha256、required 标记和缺失 fail closed。 |
| artifact_gate_state_machine | partial | 质量门和 runtime gate 状态存在，但 live root 写入仍是逐文件写 manifest/gate/marker，不是设计要求的目录级 staging rename 原子发布。 |
| producer_lineage_completeness | pass | artifact metadata 行要求 producerRunId、producerStep、tool/schema version、createdAt、upstream hashes，并绑定 run record。 |
| lineage_artifact_binding | pass | 新增 producer run semantic binding，能拒绝 forged run artifactIds 和 forged provider fingerprint。 |
| schema_runtime_compatibility | partial | runtime compatibility digest 会验证 output manifest、parquet、LanceDB 与 artifact metadata digest；但未完整 fail closed 校验 embedding model/dimension、package layout、runtime reader compatibility 等语义字段。 |
| query_scope_isolation | pass | 运行时 gate 以 `graph_vault/books/{bookId}` 为根解析 package-relative artifact，查询能力按 book scope 过滤，并阻断缺失 producer runs 的包。 |
| privacy_payload_exclusion | pass | 包校验扫描 provider payload、logs、debug、lock 等禁止路径，测试覆盖 provider payload 拒绝。 |
| recovery_diagnostics | partial | 稳定诊断和 publish marker 移除存在；但缺少 last-good liveRoot generation rollback 和 crash/interrupted publish 可恢复闭环。 |
| executable_contract_tests | partial | 已有 runtime digest、metadata、producer run forged、catalog rebuild、missing runs 等测试；缺目录级崩溃发布、rollback、stage fingerprint/book mismatch/status 等负例矩阵。 |

## 关键证据

### Runtime Gate 只读验证与包内闭包

- `src/graphrag/book-hotplug-runtime-gate.ts:174` 到 `:208`：
  `validateRequiredArtifactFiles()` 逐项验证 required artifacts 的路径、存在性、
  bytes 与 sha256。
- `src/graphrag/book-hotplug-runtime-gate.ts:211` 到 `:300`：
  `validateArtifactMetadata()` 读取包内 `artifact-metadata.json`，校验
  bookId、packageGeneration、closureDigest、required artifact row、createdAt、
  file sha/bytes，并调用 producer run binding。
- `src/graphrag/book-hotplug-runtime-gate.ts:302` 到 `:361`：
  `validateRuntimeCompatibility()` 校验 runtime compatibility 文件、bookId、
  packageGeneration 与 schema digests。
- `src/graphrag/book-hotplug-runtime-gate.ts:364` 到 `:423`：
  `validateHotplugRuntimeQueryGate()` 仅基于 book root、manifest、publish marker
  和包内 artifact 执行 gate，返回稳定 diagnostics。

### Producer Run Semantic Binding

- `src/graphrag/book-hotplug-producer-run-bindings.ts:104` 到 `:139`：
  加载 `graphrag/runs/{runId}.yaml`，使用 `BookJobRunRecordSchema` 解析，
  校验 runId、bookId 和 succeeded 状态。
- `src/graphrag/book-hotplug-producer-run-bindings.ts:142` 到 `:205`：
  校验 metadata rows 的 artifactIds 被 run.artifactIds 覆盖，或者由 durable
  output refresh 以 stage、artifact kind、checksum 绑定；同时校验 producerStep、
  stageFingerprint 和 providerFingerprint。
- `test/graphrag-book-hotplug-runtime-gate.test.ts:400` 到 `:471`：
  forged artifactIds 会触发
  `producer_run_artifact_binding_mismatch:run-graph-extract`，且
  `loadGraphQueryCapabilities()` 返回空。
- `test/graphrag-book-hotplug-runtime-gate.test.ts:477` 到 `:556`：
  forged provider fingerprint 会触发
  `producer_run_provider_fingerprint_mismatch:run-graph-extract`，且查询能力为空。

### Fresh-Vault Projection 与 Scope

- `src/graphrag/book-hotplug-catalog.ts:459` 到 `:488`：
  `ensureCatalogProjectionFromBookHotplugPackages()` 会根据当前 book package
  重建 stale catalog projection。
- `src/graphrag/capability-catalog.ts:807` 到 `:823`：
  `loadGraphCapabilities()` 先确保 hotplug projection；当投影为空且存在
  query-ready package 时，触发 rebuild 并使用 rebuild 返回的 capabilities。
- `test/graphrag-book-hotplug-catalog.test.ts:136` 到 `:272`：
  删除 catalog 后，fresh vault 能从 `BOOK_MANIFEST` package 重建查询能力。
- `test/graphrag-book-hotplug-catalog.test.ts:623` 到 `:727`：
  缺失 producer runs 时，包校验 fail closed 且查询能力为空。

### 质量门与 Backfill 可复制分发

- `scripts/graphrag/batch-epub-workflow.mjs:10161` 到 `:10287`：
  创建流程接入 pre-publish quality gate、publish candidate validation、
  post-publish validation、runtime gate state，并在 live validation 失败时移除
  publish marker。
- `scripts/graphrag/backfill-hotplug-packages.mjs:167` 到 `:190`：
  backfill 生成 package 前进行 publish candidate validation，并先移除旧
  publish marker。
- `scripts/graphrag/backfill-hotplug-packages.mjs:339` 到 `:363`：
  backfill 写入 quality/runtime gate；新包写 publish marker 后再次 live
  validation，失败则移除 marker。
- `test/graphrag-book-hotplug-catalog.test.ts:491` 到 `:568`：
  quality/runtime gate evidence 不进入 package file closure，避免复制分发时
  把本地 gate 状态当成包权威文件。

## 开放问题

1. `direct_query_entrypoint`：`projectQueryReadyLineage()` 在 runtime gate 之后仍
   读取 `catalog/books.yaml`。这保证了投影一致性，但不满足设计里的
   package-only direct query resolver。
2. `artifact_gate_state_machine`：当前发布流程使用 candidate validation 和
   publish marker 顺序保护，但 live root 中仍是逐文件写入，不是完整
   staging-root to live-root atomic rename。
3. `schema_runtime_compatibility`：runtime compatibility digest 尚未把
   embedding model/dimension、package layout、runtime reader version 等字段
   作为独立 fail-closed 条件验证。
4. `recovery_diagnostics`：缺少 last-good package generation 的显式 rollback
   与 interrupted publish 恢复证据。
5. `executable_contract_tests`：缺 crash visibility、directory publish rollback、
   run book mismatch、run status、stage fingerprint mismatch 等固定负例矩阵。

## 已运行验证

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：

- TypeScript noEmit：通过。
- `test/graphrag-book-hotplug-runtime-gate.test.ts`：5 tests passed。
- `test/graphrag-book-hotplug-catalog.test.ts`：8 tests passed。

未运行 `npm run build`，因为本审计角色为只读审计，build 会改写构建产物。
