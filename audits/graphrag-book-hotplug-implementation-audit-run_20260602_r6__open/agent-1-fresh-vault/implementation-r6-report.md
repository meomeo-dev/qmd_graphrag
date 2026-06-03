# GraphRAG 单本书热插拔 R6 实现审计报告

## 审计范围

- Agent: `agent-1-fresh-vault`
- 场景: fresh vault / package lifecycle
- 基准:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-1-fresh-vault/baseline.yaml`
- 口径: 严格复用 r5 的 10 个固定基准，不新增、不重命名、不重排。
- 代码范围: 只审计实现、测试和证据；未修改生产代码、测试或 docs。

## 总体结论

总体状态: `partial`

R6 已修复 r5 的主要可见性缺口。新书创建流程现在先执行
pre-publish quality gate，再在 `.staging/hotplug-publish-gate/**` 构造
candidate package 并校验。live root 发布时先移除旧
`PUBLISH_READY.json`，再写 manifest 与 quality/runtime gate，最后写
`PUBLISH_READY.json` 作为 mount marker。candidate 或 post-live 校验失败时，
marker 不会保留，因此失败包不会成为 query-ready capability。

剩余缺口是发布仍非目录级原子发布（directory-level atomic publish）。实现尚未
执行完整 `buildStagingRoot -> fsync -> atomic rename liveRoot`；live root 内仍是
多文件顺序提交。当前安全性主要依赖最后 marker、runtime gate、catalog rebuild
和 fail-closed 查询路径，而非 last-good liveRoot generation 原子切换。

## 重点核对

### 核对项 1: 新书创建流程质量门

判定: 已具备，仍非完整目录级事务。

`writeBookHotplugPackage()` 先调用 `prePublishHotplugQualityGate()`。失败时只写
`state/hotplug-quality-gate.json` 并抛错。通过后调用
`validateHotplugPackagePublishCandidate()`，在 staging root 写 candidate
`BOOK_MANIFEST.json` 和 `PUBLISH_READY.json`，再运行 package validator。

证据:
`scripts/graphrag/batch-epub-workflow.mjs:10161`,
`scripts/graphrag/batch-epub-workflow.mjs:10188`,
`scripts/graphrag/book-hotplug-publish-gate.mjs:27`.

### 核对项 2: `PUBLISH_READY.json` 最后 mount marker

判定: 已修复为最后 marker。

live root 发布顺序为删除旧 marker、写 `BOOK_MANIFEST.json`、写
`hotplug-quality-gate.json`、写 `hotplug-runtime-gate.json`、最后写
`PUBLISH_READY.json`。catalog loader 要求 manifest 和 marker 同时存在；
runtime query gate 缺少 marker 时诊断为 `missing_publish_marker`。

证据:
`scripts/graphrag/batch-epub-workflow.mjs:10219`,
`scripts/graphrag/batch-epub-workflow.mjs:10258`,
`src/graphrag/book-hotplug-catalog.ts:119`,
`src/graphrag/book-hotplug-runtime-gate.ts:354`.

### 核对项 3: 失败时不可见

判定: package/query 可见性层面成立；目录级半成品仍可能短暂存在。

candidate 失败时不写 live marker。post-live validation 失败时立即删除
`PUBLISH_READY.json` 及 sidecars，再写失败 gate 并抛错。catalog projection 只加载
同时存在 manifest 与 marker 的包；runtime gate 对缺少 marker、forbidden path、
runtime compatibility、artifact metadata 和 producer runs 均 fail closed。

证据:
`scripts/graphrag/batch-epub-workflow.mjs:10194`,
`scripts/graphrag/batch-epub-workflow.mjs:10260`,
`scripts/graphrag/book-hotplug-publish-marker.mjs:17`,
`src/graphrag/book-hotplug-runtime-gate.ts:342`.

### 核对项 4: catalog projection stale 修复

判定: 通过。

`ensureCatalogProjectionFromBookHotplugPackages()` 会加载当前 manifest+marker
可发布包集合，比较各 projection 的 observed bookId 与 expected bookId。缺失、
额外或数量不一致都会触发 `rebuildCatalogFromBookHotplugPackages()`。这解决了
跨测试和真实挂载中旧 catalog 文件存在但内容过期的问题。

证据:
`src/graphrag/book-hotplug-catalog.ts:169`,
`src/graphrag/book-hotplug-catalog.ts:185`,
`src/graphrag/book-hotplug-catalog.ts:456`,
`test/graphrag-book-hotplug-catalog.test.ts:370`.

### 核对项 5: 验证证据

本轮复核:

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`: 通过。
- `node scripts/build.mjs`: 通过。
- hotplug 3 文件:
  `test/graphrag-book-hotplug-catalog.test.ts`,
  `test/graphrag-book-hotplug-runtime-gate.test.ts`,
  `test/graphrag-book-hotplug-backfill.test.ts`: `12 tests passed`。
- `test/cli-graphrag-route.test.ts`: `9 tests passed`。
- `test/unified-query.test.ts`: `37 tests passed`。

相关 5 文件串行复核合计 `58 tests passed`。一次并行复核曾因 CLI 单测硬编码
30 秒超时而失败；串行复核全部通过。

真实 backfill / vault 证据:

- 用户提供已执行命令结果: real backfill `exit 0`, `discovered=38`,
  `skipped=38`, `failed=0`, `catalogRebuild=38/38/30`。
- 最新 evidence:
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602211359498/commit-record.yaml`
- 当前 live package: `BOOK_MANIFEST.json=38`, `PUBLISH_READY.json=38`,
  `hotplug-quality-gate.json=38`, `hotplug-runtime-gate.json=38`。
- 当前 catalog: `books=38`, `document-identity-map=38`,
  `graph-capabilities=30`。
- `graph_vault/books/*` package 闭包口径 forbidden scan 输出为空。

## 基准逐项判定

### 1. `direct_query_entrypoint` 直接查询入口

判定: `partial`

`loadGraphCapabilities()` 会先从当前 hotplug packages 修复 catalog projection。
CLI GraphRAG 查询按单书 scope 解析 capability，并将 runtime `dataDir` 指向
`books/{bookId}/graphrag/output`。仍为 partial 的原因是
`projectQueryReadyLineage()` 仍读取 `catalog/books.yaml` 的
`stageFingerprints` 与 `providerFingerprint`，不是完全 package-only entrypoint。

证据:
`src/graphrag/capability-catalog.ts:438`,
`src/graphrag/capability-catalog.ts:739`,
`src/cli/qmd.ts:3406`, `src/cli/qmd.ts:3438`.

### 2. `artifact_minimum_closure` 查询 Artifact 最低闭包

判定: `pass`

`RequiredGraphRagArtifacts` 明确列出 output manifest、identity map、
artifact metadata、runtime compatibility、context/stats、parquet 集和 LanceDB。
manifest file entry 记录 path、role、bytes、sha256、required 和 sensitivity。
validator 与 runtime gate 对缺失、bytes、sha256、metadata row 和 runtime digest
均 fail closed。

证据:
`scripts/graphrag/book-hotplug-package.mjs:33`,
`scripts/graphrag/book-hotplug-package.mjs:834`,
`src/graphrag/book-hotplug-runtime-gate.ts:163`.

### 3. `artifact_gate_state_machine` Artifact Gate 状态机

判定: `partial`

状态输出覆盖 `copied -> candidate -> validated -> mounted ->
query_ready|visible_not_query_ready|quarantined`。新书发布已新增 staged candidate
validation，candidate 失败不会进入 live marker。仍为 partial 的原因是状态机未
对应完整 live-root generation 原子切换；`copied/candidate` 主要是 gate 证据和
candidate validation。

证据:
`scripts/graphrag/book-hotplug-quality-gate.mjs:114`,
`scripts/graphrag/batch-epub-workflow.mjs:10188`,
`scripts/graphrag/batch-epub-workflow.mjs:10258`.

### 4. `producer_lineage_completeness` Producer Lineage 完整性

判定: `pass`

artifact metadata rows 记录 producerRunId、producerStep、producerToolVersion、
producerSchemaVersion、upstreamArtifactHashes 和 createdAt。runtime gate 对缺失
producer run、metadata row、createdAt、fileSha256、bytes、closureDigest 失败闭合。
capability projection 还校验 state artifacts/checkpoints、stage fingerprint、
provider fingerprint 和 artifact set。

证据:
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:117`,
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:193`,
`src/graphrag/capability-catalog.ts:488`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:285`.

### 5. `lineage_artifact_binding` Lineage 与 Artifact 绑定

判定: `pass`

manifest files、artifact metadata、producerRunIds、`graphrag/runs/*.yaml`、
state artifacts 与 checkpoints 已形成多层绑定。缺失 producer runs 或 metadata
row 会使 package validation 失败，并阻止 capability 派生。

证据:
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:264`,
`scripts/graphrag/book-hotplug-package.mjs:870`,
`src/graphrag/book-hotplug-runtime-gate.ts:378`,
`test/graphrag-book-hotplug-catalog.test.ts:623`.

### 6. `schema_runtime_compatibility` Schema 与运行时兼容

判定: `pass`

包生成会写 `runtime-compatibility.json`，记录 package schema/layout、
GraphRAG artifact schema、runtime tool version、provider fingerprint、
embedding dimension 和四类 schema digest。runtime gate 重新计算并比较
`outputManifestSchemaDigest`、`parquetSchemaDigest`、`lancedbSchemaDigest`、
`artifactMetadataSchemaDigest`。伪造 digest 测试确认 fail closed。

证据:
`scripts/graphrag/book-hotplug-runtime-compatibility.mjs:55`,
`src/graphrag/book-hotplug-runtime-gate.ts:270`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:206`.

### 7. `query_scope_isolation` 单书查询范围隔离

判定: `pass`

artifact path 被要求位于 book-scoped GraphRAG output；CLI GraphRAG 多书匹配时
要求显式 `--graph-book-id`，并把 runtime `dataDir` 指向选中书的
`books/{bookId}/graphrag/output`。测试覆盖多书歧义拒绝和选中书 scoped output。

证据:
`src/graphrag/capability-catalog.ts:535`,
`src/cli/qmd.ts:3421`,
`test/cli-graphrag-route.test.ts:892`,
`test/cli-graphrag-route.test.ts:918`.

### 8. `privacy_payload_exclusion` Provider Payload 排除

判定: `pass`

package validator 和 runtime gate 扫描 forbidden path。`provider-requests/**`、
`provider-responses/**`、logs/debug/trace、`.env`、`.durable-recovery.jsonl`、
lock 和 corrupt 文件不会进入可发布包闭包。复制包中出现
`provider-requests/payload.json` 时 fail closed。

证据:
`scripts/graphrag/book-hotplug-package.mjs:640`,
`scripts/graphrag/book-hotplug-package.mjs:718`,
`src/graphrag/book-hotplug-runtime-gate.ts:69`,
`test/graphrag-book-hotplug-catalog.test.ts:573`.

### 9. `recovery_diagnostics` 失败恢复与诊断

判定: `partial`

pre-publish gate、candidate validation、post-live validation、quality gate、
runtime gate、quarantine、catalog rebuild 和 migration evidence 均有稳定输出。
post-live validation 失败会删除 publish marker。仍为 partial 的原因是 rollback
尚未覆盖完整 live root generation；恢复主要依赖 marker 删除、gate 诊断和
projection rebuild。

证据:
`scripts/graphrag/book-hotplug-quality-gate.mjs:57`,
`scripts/graphrag/book-hotplug-quality-gate.mjs:171`,
`scripts/graphrag/batch-epub-workflow.mjs:10260`,
`graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602211359498/commit-record.yaml`.

### 10. `executable_contract_tests` 可执行契约测试

判定: `partial`

相关 5 文件串行复核为 `58 tests passed`，覆盖 catalog 缺失/陈旧重建、provider
payload 排除、producer runs 缺失、artifact metadata 缺失、runtime compatibility
forged、backfill duplicate conflict、verify-only idempotency、CLI 多书 scope 和
selected book output。仍为 partial 的原因是缺少目录级 atomic publish / crash
visibility 专门测试。

证据:
`test/graphrag-book-hotplug-catalog.test.ts:370`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:206`,
`test/graphrag-book-hotplug-backfill.test.ts:128`,
`test/cli-graphrag-route.test.ts:892`,
`test/unified-query.test.ts:1271`.

## 发现清单

1. `medium` / `artifact_gate_state_machine`:
   已有 candidate validation 和最后 marker，但 live root 仍是多文件顺序提交，
   未实现目录级 atomic rename liveRoot。
2. `medium` / `direct_query_entrypoint`:
   catalog stale 可重建，但 `projectQueryReadyLineage()` 仍依赖
   `catalog/books.yaml` lineage 字段。
3. `medium` / `recovery_diagnostics`:
   失败恢复以 marker 删除、gate 诊断和 projection rebuild 为主，缺少完整
   last-good liveRoot generation rollback。
4. `low` / `executable_contract_tests`:
   相关 5 文件 58 tests 已通过，但缺少目录级 atomic publish / crash
   visibility 的专门测试。
