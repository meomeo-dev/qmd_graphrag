# qmd_graphrag 单本书热插拔包实现审计报告（Agent 1 / fresh vault）

## 审计范围

- 场景（scenario）：fresh vault / 新书创建闭环
- 基准（baseline）：`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-1-fresh-vault/baseline.yaml`
- 结论口径：严格复用 baseline 10 个维度，不新增、不删减、不改名、不改序。

## 总体结论

总体状态：`partial`

本次 fresh-vault 审计确认，当前实现已经形成较完整的单书包
`BOOK_MANIFEST.json` / `PUBLISH_READY.json` / GraphRAG artifact metadata /
runtime compatibility / runtime gate / catalog rebuild / fail-closed 查询闭环。
`backfill-hotplug-packages` 也能消费该闭包并完成校验与 catalog 重建。

但 fresh-vault 新书创建路径存在一个明确实现缺口：`batch-epub-workflow`
未按设计合同执行 `buildStagingRoot -> fsync -> atomic rename liveRoot` 的
staging-first publish，而是在 live root
`graph_vault/books/{bookId}` 内直接顺序写入 `BOOK_MANIFEST.json`、
`PUBLISH_READY.json`、`state/hotplug-quality-gate.json`、
`state/hotplug-runtime-gate.json`。这不满足设计中“构建中目录不可见 /
发布前不进入 liveRoot / rollback 保留 last-good generation”的原子发布合同。

同时，GraphRAG 查询入口虽然能在 catalog 缺失或陈旧时从书包重建 projection，
但 `projectQueryReadyLineage()` 仍依赖 `catalog/books.yaml` 中的
`stageFingerprints` / `providerFingerprint` 作为 lineage 解析输入，
尚未完全达到 baseline 要求的“仅凭 `BOOK_MANIFEST.json` 与包内 artifacts”
直接完成查询定位。

## 严重度排序发现

1. `high`：fresh-vault 新书发布未实现 staging-first atomic publish，live root
   先写 manifest/publish marker，再写两个 gate 文件，存在与设计合同不一致的
   可见性与 rollback 缺口。
2. `medium`：direct query 仍依赖 `catalog/books.yaml` 参与 lineage 解析，
   尚未完全满足“不依赖全局 catalog、旧 batch 状态”的 baseline。
3. `medium`：fixed baseline 合同要求的若干 fresh-vault / importer / staging
   可执行测试尚未落地，尤其是“runner build staging invisible to mount scan”。

## 逐条审计

### 1. `direct_query_entrypoint` 直接查询入口

- status：`partial`
- 证据路径：
  - [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:438)
  - [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:444)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:332)
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:136)
  - [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942)
- 发现：
  - 正向能力：
    `validateHotplugRuntimeQueryGate()` 以 `BOOK_MANIFEST.json`、publish marker、
    required artifacts、artifact metadata、runtime compatibility、producer runs
    为主进行 fail-closed 校验。
  - 正向能力：
    `loadGraphQueryCapabilities()` 在 `graph-capabilities.yaml` 缺失时，
    可由热插拔包重建 catalog projection；测试已覆盖“删除 catalog 后仍可恢复查询
    capability”。
  - 未满足点：
    `projectQueryReadyLineage()` 仍读取 `catalog/books.yaml`，并要求其中存在
    `stageFingerprints` 与 `providerFingerprint` 才能继续解析 lineage。
    因此，当前实现并非严格意义上的“只凭 manifest 与包内 artifact”
    直接查询入口。
- 修复建议：
  - 将 query-ready lineage 所需的 `stageFingerprints`、
    `providerFingerprint`、必要 content binding 下沉为包内权威证据，
    使 `projectQueryReadyLineage()` 可在 `catalog/books.yaml` 不存在时
    仍独立完成解析。

### 2. `artifact_minimum_closure` 查询 Artifact 最低闭包

- status：`pass`
- 证据路径：
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:33)
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:629)
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:713)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:163)
  - [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1586)
- 发现：
  - `RequiredGraphRagArtifacts` 明确定义了 query-ready 的最小 GraphRAG
    artifact 集。
  - `manifest.files` 为每个文件记录 `path / role / bytes / sha256 / required /
    sensitivity`。
  - `validateBookHotplugPackage()` 与
    `validateHotplugRuntimeQueryGate()` 对缺失文件、字节数、sha256、
    required artifact 缺失均 fail closed。
  - 当 `manifest.graphrag.queryReady !== true` 时，runtime gate 会输出
    `visible_not_query_ready` 而非错误投影为 ready。
- 修复建议：
  - 保持当前闭包定义；后续只需把 contract 中更细粒度的
    `schemaDigest / validationGranularity / compatibilityGroup`
    一致性继续收敛到实现。

### 3. `artifact_gate_state_machine` Artifact Gate 状态机

- status：`fail`
- 证据路径：
  - [scripts/graphrag/book-hotplug-quality-gate.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-quality-gate.mjs:114)
  - [scripts/graphrag/book-hotplug-quality-gate.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-quality-gate.mjs:120)
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:902)
  - [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990)
- 发现：
  - `buildRuntimeGateState()` 已将 `copied -> candidate -> validated -> mounted ->
    query_ready|visible_not_query_ready|quarantined` 编码到状态输出。
  - 失败路径包含 stable diagnostics，并在 gate 失败时阻止查询 capability。
  - 但实现层没有真正的 staging-first copied candidate 生命周期。
    当前 fresh-vault 写包发生在 live root；`copied` 与 `candidate`
    更接近诊断状态，而非真正的不可见 staged 实体。
  - 合同要求的 `rolled_back` / “validation crash preserves last-good generation”
    在 fresh-vault 新书创建路径中未形成真实发布事务边界。
- 修复建议：
  - 将 state machine 对应到真实 staging root 生命周期，而非 live root
    直写后的诊断投影。
  - 为发布崩溃 / 校验失败补充 `rolled_back` 或 retained-staging 证据。

### 4. `producer_lineage_completeness` Producer Lineage 完整性

- status：`pass`
- 证据路径：
  - [scripts/graphrag/book-hotplug-artifact-metadata.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-artifact-metadata.mjs:117)
  - [scripts/graphrag/book-hotplug-artifact-metadata.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-artifact-metadata.mjs:193)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:200)
  - [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:285)
- 发现：
  - `artifact-metadata.json` 为每个 artifact row 写入
    `producerRunId / producerStep / producerToolVersion /
    producerSchemaVersion / upstreamArtifactHashes / createdAt`。
  - `validateArtifactMetadata()` 对缺失 producer、缺失 producerStep、
    缺失 tool version、缺失 schema version、缺失 upstream hash、
    缺失 createdAt 均 fail closed。
  - 运行时测试已覆盖 `artifact_metadata_missing_created_at` 失败闭合。
- 修复建议：
  - 后续可补充对 `input hash` 与 `outputArtifactHash` 的显式验证，使其更贴近
    final contract 的字段命名。

### 5. `lineage_artifact_binding` Lineage 与 Artifact 绑定

- status：`pass`
- 证据路径：
  - [scripts/graphrag/book-hotplug-artifact-metadata.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-artifact-metadata.mjs:131)
  - [scripts/graphrag/book-hotplug-artifact-metadata.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-artifact-metadata.mjs:264)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:243)
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:623)
- 发现：
  - artifact metadata row 绑定 `path / artifactId / fileSha256 / bytes /
    producerRunId`，并回查 `graphrag/runs/{runId}.yaml`。
  - 若 manifest 宣告的 `producerRunIds` 在 runs 中不存在，或 runs 的
    `artifactIds` 未被 metadata 覆盖，则验证失败。
  - 缺失 producer runs 的测试已覆盖，且 capability 不会被派生。
- 修复建议：
  - 保持当前绑定策略；可增加“artifact 替换但沿用旧 artifactId”负例测试，
    进一步加固闭包。

### 6. `schema_runtime_compatibility` Schema 与运行时兼容

- status：`pass`
- 证据路径：
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:539)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:270)
  - [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:206)
  - [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1648)
- 发现：
  - 包生成时会写出 `runtime-compatibility.json`。
  - runtime gate 会比对
    `outputManifestSchemaDigest / parquetSchemaDigest / lancedbSchemaDigest /
    artifactMetadataSchemaDigest`。
  - forged semantic digest 的测试已覆盖，并确认 capability fail closed。
- 修复建议：
  - 可继续补充 embedding model / dimension 的显式诊断与测试，以完全贴合合同。

### 7. `query_scope_isolation` 单书查询范围隔离

- status：`pass`
- 证据路径：
  - [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:9750)
  - [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:535)
  - [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3421)
  - [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:728)
- 发现：
  - artifact 校验要求 `requireBookScopedGraphOutput`，并验证 artifact path
    必须位于 `books/{bookId}/graphrag/output`。
  - CLI GraphRAG 路由在多个 graph-ready 书同时匹配时，要求显式
    `--graph-book-id`，否则拒绝路由，防止跨书混入。
  - 测试确认 GraphRAG runtime 请求的 `dataDir` 指向单书
    `books/{bookId}/graphrag/output`。
- 修复建议：
  - 可再补充“sibling roots / historical residue 不能被 selected capability
    吸入”的显式负例测试。

### 8. `privacy_payload_exclusion` Provider Payload 排除

- status：`pass`
- 证据路径：
  - [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:640)
  - [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:69)
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:573)
  - [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:491)
- 发现：
  - 包层面禁止 `provider-requests/**`、`provider-responses/**`、`.env`、
    logs、corrupt files 等进入 distributable closure。
  - runtime gate 会扫描 forbidden path patterns，并以
    `forbidden_sensitive_material:*` fail closed。
  - 测试已覆盖复制书包后额外放入 `provider-requests/payload.json` 时的拒绝行为。
- 修复建议：
  - 后续可把 manifest unknown-field sensitivity fail-closed 的自动化测试补全到
   固定基准要求的粒度。

### 9. `recovery_diagnostics` 失败恢复与诊断

- status：`partial`
- 证据路径：
  - [scripts/graphrag/book-hotplug-quality-gate.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-quality-gate.mjs:57)
  - [scripts/graphrag/book-hotplug-quality-gate.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-quality-gate.mjs:171)
  - [scripts/graphrag/book-hotplug-residue-quarantine.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-residue-quarantine.mjs:96)
  - [src/job-state/durable-state-store.ts](/Users/jin/projects/qmd_graphrag/src/job-state/durable-state-store.ts:1724)
  - [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:196)
- 发现：
  - 诊断与修复入口较完整：质量门、runtime gate、durable checksum quarantine、
    residue quarantine、catalog rebuild 均有稳定诊断输出。
  - gate 失败时会输出 rollback 信息，指出
    `projectionRollbackRequired` 与 recovery action。
  - 但 fresh-vault 新书创建没有真实 staging publish 事务，因此
    “validation crash / publish crash preserves last-good liveRoot generation”
    的 rollback 语义只部分成立。
  - 对新书场景虽不存在旧 generation 被覆盖的问题，但 baseline 明确要求检查
    staging-first publish/rollback 缺口；该缺口当前仍在。
- 修复建议：
  - 将新书发布和重发版统一到 staged publish pipeline，失败时保留 staging /
    quarantine record，成功时才原子切换 live root。

### 10. `executable_contract_tests` 可执行契约测试

- status：`partial`
- 证据路径：
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:136)
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:370)
  - [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:623)
  - [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:205)
  - [test/graphrag-book-hotplug-backfill.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-backfill.test.ts:127)
  - [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1305)
- 发现：
  - 现有测试已覆盖：
    catalog 缺失重建、stale catalog 重建、producer runs 缺失、
    artifact metadata 缺失、runtime compatibility digest forged、
    provider payload 目录拒绝、backfill verify-only idempotency。
  - 未见对应 fixed-baseline 合同的实现测试：
    `runner build staging invisible to mount scan`、
    `staged importer compatibility validation before publish`、
    `artifact gate covers copied to query_ready transitions` 的真实 staged runner
    场景。
  - 因此测试体系较强，但尚未完全把设计合同中 fresh-vault 的关键事务边界变成
    可执行断言。
- 修复建议：
  - 新增 fresh-vault publish tests，至少覆盖：
    1. build staging 期间 mount scan 不可见；
    2. publish 崩溃后 live root 不出现半成品；
    3. 新书完成前四个文件未齐时 capability 不可见；
    4. staged publish 成功后一次性变为 mounted / query-ready 或
       visible_not_query_ready。

## fresh-vault 重点结论

### 1. 新书完成前是否写入四个关键文件

结论：`部分满足（partial）`

`runItem()` 在标记 item `completed` 之前会执行：

1. `writeBookDistributionManifest()`
2. `writeBookHotplugPackage()`
3. `saveCheckpoint(...status: "completed")`

其中 `writeBookHotplugPackage()` 会在成功路径中写出：

- `BOOK_MANIFEST.json`
- `PUBLISH_READY.json`
- `state/hotplug-quality-gate.json`
- `state/hotplug-runtime-gate.json`

对应证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:10158)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:10216)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:10243)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:12655)

但写入顺序发生在 live root，且 `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json`
先于两个 gate 文件提交；因此“完成前已写齐四个文件”对于成功路径成立，
但“不存在 live-root 半成品窗口”不成立。

### 2. 失败是否 fail closed

结论：`满足（pass）`

- pre-publish source truth gate 不通过时，不生成 manifest，直接写失败质量门并抛错。
- candidate validation / package validation 不通过时，写失败 gate 与 runtime gate，
  然后抛错。
- 查询侧对 required artifact、producer run、artifact metadata、runtime
  compatibility 任一失败均 fail closed，不派生 capability。

### 3. 是否满足 `backfill-hotplug-packages` 的可分发包要求

结论：`满足（pass）`

- `backfill-hotplug-packages.mjs` 使用同一套
  `buildBookHotplugPackage()`、`validateHotplugPackagePublishCandidate()`、
  `validateBookHotplugPackage()`。
- 现有验证与已提供事实都表明 backfill 能消费这套闭包并重建 catalog。

### 4. 是否仍有 staging-first publish / rollback 缺口

结论：`有，且为本次最高优先级缺口（fail）`

设计合同要求：

- 仅在 `buildStagingRoot` / `importStagingRoot` 写包
- fsync 完整 staged package
- 原子 rename 到 live root
- mount scan 只观察提交后的 live generation

当前 fresh-vault 新书创建实现未满足上述要求。

## 建议修复顺序

1. 先修 fresh-vault staged publish：把 `writeBookHotplugPackage()` 从 live root
   直写改为 staged package publish，并将完成切换收束为原子 rename。
2. 再修 manifest-first direct query：把 `projectQueryReadyLineage()` 对
   `catalog/books.yaml` 的依赖下沉到包内权威证据。
3. 最后补齐 fixed-baseline 契约测试，特别是 fresh-vault / staging /
   mount invisibility / crash rollback。
