# GraphRAG 单本书热插拔 R9 实施审计报告

## 审计结论

- Agent: `agent-3-runtime-provider`
- 场景: `runtime-provider`
- 总体结论: `pass`
- 固定基准数: `10`
- 判定统计: `pass=10`, `partial=0`, `fail=0`

本轮严格复用固定基准：
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-3-runtime-provider/fixed-baseline.yaml`。
R9 目录内 `fixed-baseline.yaml` 为逐字复制，未新增、删除、重排或重命名任何基准。

本轮重点复核 R8 中的三个 `partial`：

1. `producer_lineage_completeness`
2. `schema_runtime_compatibility`
3. `executable_contract_tests`

结论：三项均已闭合（closed）。当前实现已经满足主 Type DD 与最终合同对
runtime gate、provider payload exclusion、producer lineage semantic binding、
runtime compatibility fail-closed、artifact metadata stage/provider
fingerprint gate 的实现性要求。

需要单独说明的残余差异（residual modeling gap）如下：

- run-level producer tool/schema version 仍主要由
  `graphrag/output/artifact-metadata.json` 的 row 级字段承载，而不是写入
  `graphrag/runs/*.yaml` 的 run record 顶层必填字段。
- full generation time 仍以 artifact row `createdAt` 与 run record
  `startedAt`/`finishedAt` 组合表达，没有额外的独立 run-level
  `completedAt` 命名字段。
- 主 Type DD 早期段落出现的 `embeddingModel`、`graphProjectionVersion`、
  `runtimeReaderVersion` 属于更宽泛的建模词汇；最终合同的规范入口
  (`graphrag-book-hotplug-package-final-contracts.type-dd.yaml`) 对 runtime
  gate 的硬要求已经收敛为 package schema、layout、qmd schema、GraphRAG
  artifact schema、minimum runtime version、provider fingerprint、
  embedding dimension 以及 semantic digest。当前实现对这组最终合同字段均已
  fail-closed。

上述残余差异不影响本固定基准的 passCriteria，因此本轮结论为 `pass`。

## 复核命令

本轮实际执行并纳入判断的命令：

- `npm exec -- tsc -p tsconfig.build.json --noEmit`
- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --reporter=dot --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
- `npx vitest run test/graphrag-book-hotplug-runtime-gate-hardening.test.ts --reporter=dot --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --reporter=dot --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
- 多轮只读 `rg`/`nl`/`sed` 检查实现、合同、R8 产物与相关测试。

执行结果：

- `tsc` 通过。
- runtime gate tests：`5/5` 通过。
- runtime gate hardening tests：`3/3` 通过。
- catalog tests：`8/8` 通过。

## 基准逐项判定

| 序号 | 基准 id | 判定 |
|---:|---|---|
| 1 | `direct_query_entrypoint` | `pass` |
| 2 | `artifact_minimum_closure` | `pass` |
| 3 | `artifact_gate_state_machine` | `pass` |
| 4 | `producer_lineage_completeness` | `pass` |
| 5 | `lineage_artifact_binding` | `pass` |
| 6 | `schema_runtime_compatibility` | `pass` |
| 7 | `query_scope_isolation` | `pass` |
| 8 | `privacy_payload_exclusion` | `pass` |
| 9 | `recovery_diagnostics` | `pass` |
| 10 | `executable_contract_tests` | `pass` |

### 1. `direct_query_entrypoint`

判定：`pass`

manifest-first query gate 已经成立。直接查询先走 runtime gate，再由
`loadGraphCapabilities()` 触发 mount projection / capability derivation。
即使显式 capability catalog 缺失，仍可从当前 package 与书级状态重建能力，
不依赖旧的全局 catalog 作为权威输入。

主要证据：

- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:814)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:827)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:833)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:474)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:467)
- [test/python/test_graphrag_bridge_scope.py](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_bridge_scope.py:1089)

残余风险：

- `projectQueryReadyLineage()` 仍会读取当前 catalog 投影中的书与 identity
  视图，但这些视图由 package 重建，且 stale cache 不能越过 runtime gate。
  这不违反 passCriteria。

### 2. `artifact_minimum_closure`

判定：`pass`

当前实现对 GraphRAG 最低闭包有明确、可执行的 required artifact 集合，并对
manifest file entry、bytes、sha256、required 标记和 artifact metadata
closure 进行 fail-closed 验证。

主要证据：

- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:632)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:206)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:243)
- [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:582)
- [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1614)

残余风险：

- 无实质缺口。剩余风险主要在未来 schema 变更若未同步 `RequiredGraphRagArtifacts`
  常量时可能出现漂移，但本轮实现与合同一致。

### 3. `artifact_gate_state_machine`

判定：`pass`

最终合同已定义 copied、candidate、validating、validated、mounted、
query_ready、visible_not_query_ready、quarantined、rolled_back；实现侧通过
runtime gate、package validator、capability projection 三层 fail-closed
落实 query gate，失败不投影为可查询能力。

主要证据：

- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1032)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1099)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:467)
- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:716)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:478)

残余风险：

- 代码里没有把状态机显式枚举为一个统一 runtime enum；但行为上已被稳定诊断和
  query suppression 落地，不影响该基准通过。

### 4. `producer_lineage_completeness`

判定：`pass`

R8 的 `partial` 已闭合。当前实现已经满足基准要求中的核心可追溯性：

- 每个必需 artifact row 具有 `producerRunId`、`producerStep`、
  `producerToolVersion`、`producerSchemaVersion`、`upstreamArtifactHashes`、
  `createdAt`。
- runtime gate 强制 required row 必须携带 `createdAt`、
  `stageFingerprint`、`providerFingerprint`。
- producer run summary 必须存在、通过 schema 校验，并绑定 `runId`、
  `bookId`、`status`、`artifactIds`、`stageFingerprint` /
  `inputFingerprint`、`providerFingerprint`。
- 缺失上述关键证据时直接 fail-closed。

主要证据：

- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:74)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:314)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:341)
- [src/graphrag/book-hotplug-producer-run-bindings.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-producer-run-bindings.ts:104)
- [src/graphrag/book-hotplug-producer-run-bindings.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-producer-run-bindings.ts:176)
- [scripts/graphrag/book-hotplug-artifact-metadata.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-artifact-metadata.mjs:226)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:326)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:222)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:980)

关于 R8 残余点的结论：

- run-level producer tool/schema version 未写进 `BookJobRunRecordSchema`
  顶层，但已由 required artifact metadata rows 强制承载，并参与 query gate。
  固定基准要求的是“可追溯”，而不是必须由 run record 单点承载，因此不构成
  `partial`。
- “full generation time” 已由 row `createdAt` 与 run `startedAt` /
  `finishedAt` 组合表达。合同要求的是生成时间证据，不是必须叫
  `completedAt`。这不影响 passCriteria。

残余风险：

- 若后续要求“run summary 自身必须含 tool/schema/completedAt 顶层字段”，需要
  扩充 `BookJobRunRecordSchema`。这是增强项，不是当前基准缺口。

### 5. `lineage_artifact_binding`

判定：`pass`

manifest `producerRunIds`、`graphrag/runs/*.yaml`、artifact metadata rows 与
`files` 闭包之间已经形成可验证绑定。伪造 `artifactIds`、伪造
provider fingerprint、closure digest 错配、file sha 错配都能使 gate
fail-closed。

主要证据：

- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:291)
- [src/graphrag/book-hotplug-producer-run-bindings.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-producer-run-bindings.ts:168)
- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:883)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:405)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:482)

残余风险：

- durable refresh 允许共享文件按 `stage + artifactKind + checksum` 绑定，这是
  合同允许的历史兼容桥接；风险已由 checksum 约束收口。

### 6. `schema_runtime_compatibility`

判定：`pass`

R8 的 `partial` 已闭合。当前 runtime compatibility 实现已经对最终合同要求的
字段和行为 fail-closed：

- `packageSchemaVersion`
- `layoutVersion`
- `qmdIndexSchema`
- `graphRagArtifactSchema`
- `artifactSchema`
- `minQmdGraphRagVersion`
- `providerFingerprint`
- `embeddingVectorDimension`
- 四类 semantic digest：
  `outputManifestSchemaDigest`、`parquetSchemaDigest`、
  `lancedbSchemaDigest`、`artifactMetadataSchemaDigest`

同时，R9 前置说明中提到的 hardening tests 已覆盖 missing stage/provider
fingerprint 与 forged layout + embedding dimension；本轮我又复跑确认通过。

主要证据：

- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:350)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:389)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:438)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:453)
- [scripts/graphrag/book-hotplug-runtime-compatibility.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-runtime-compatibility.mjs:143)
- [scripts/graphrag/book-hotplug-runtime-compatibility.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-runtime-compatibility.mjs:170)
- [scripts/graphrag/book-hotplug-runtime-compatibility.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-runtime-compatibility.mjs:193)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:247)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:316)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:969)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1388)

关于主 Type DD 中更宽字段的结论：

- `embeddingModel`、`graphProjectionVersion`、`runtimeReaderVersion`
  在主 Type DD 中出现，但最终合同并未把它们列为 runtime gate 的稳定诊断项。
- 当前最终合同明确要求的是 minimum runtime version、provider fingerprint、
  embedding dimension 与 semantic digest；实现已覆盖这些规范字段。
- 因此这些更宽字段当前不构成本固定基准的未关闭缺口。

残余风险：

- 如果未来把 `embeddingModel` 或 `runtimeReaderVersion` 升格为最终合同的
  stable diagnostics，当前实现需要新增显式比较与负例测试。

### 7. `query_scope_isolation`

判定：`pass`

查询能力派生与校验都按书级作用域进行。book scope、document scope、
source scope 都会在 capability 过滤与 lineage 验证中收口，不能把其他书的
残留 run record 或 artifact 混入当前书的查询上下文。

主要证据：

- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:628)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:655)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:717)
- [test/graphrag-capability-scope.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-capability-scope.test.ts:91)
- [test/python/test_graphrag_bridge_scope.py](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_bridge_scope.py:1225)
- [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:918)

残余风险：

- 当前隔离还依赖 identity/projection 文件正确重建；但这些文件本身已在
  runtime gate 与 capability derivation 里被反向约束。

### 8. `privacy_payload_exclusion`

判定：`pass`

实现明确禁止读取、要求、分发 provider request/response、secrets、logs
payload、recovery payload。只读 reader 仅解析 YAML/JSON 包内元数据；发现
provider payload roots 直接 fail-closed。

主要证据：

- [src/graphrag/book-hotplug-package-readonly.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-package-readonly.ts:1)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:104)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:481)
- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:643)
- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:721)
- [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:573)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1015)

残余风险：

- 无当前缺口。只要未来新增 provider-related 文件类型同步更新 forbidden path
  模式即可。

### 9. `recovery_diagnostics`

判定：`pass`

artifact 缺失、sha mismatch、lineage 断裂、schema/runtime mismatch、
fingerprint 缺失或 forged，都有稳定诊断码。package validator、runtime gate、
capability projection 三层对同类问题保持一致的 fail-closed 行为。

主要证据：

- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:223)
- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:363)
- [src/graphrag/book-hotplug-producer-run-bindings.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-producer-run-bindings.ts:118)
- [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:909)
- [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1389)

残余风险：

- 诊断分层仍分散在多个模块中；但 diagnostic string 已稳定，满足本基准。

### 10. `executable_contract_tests`

判定：`pass`

R8 的 `partial` 已闭合。当前测试矩阵已经覆盖合同要求的 runtime/provider
关键负例：

- runtime compatibility digest forged
- artifact metadata createdAt missing
- producer run artifactIds forged
- producer run provider fingerprint forged
- readonly package root 不写 `.lock`
- artifact metadata stage fingerprint missing
- artifact metadata provider fingerprint missing
- runtime compatibility layout mismatch
- runtime compatibility embedding dimension mismatch
- undeclared provider payload fail-closed
- missing artifact metadata row 不导出 query capability
- capability scope / 跨书污染拒绝

主要证据：

- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:221)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:247)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:326)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:405)
- [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:482)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:222)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:269)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:316)
- [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:573)
- [test/graphrag-book-hotplug-catalog.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-catalog.test.ts:732)
- [test/graphrag-capability-scope.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-capability-scope.test.ts:125)
- [test/python/test_graphrag_bridge_scope.py](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_bridge_scope.py:1188)

残余风险：

- `lancedb embedding dimension mismatch` 与通用 `embedding dimension mismatch`
  当前共用同一运行时字段与测试模式，没有单独命名一个专门面向 LanceDB 目录的
  JS 测试用例；但合同所需的 fail-closed 行为已被现有 gate 覆盖。

## R8 partial 关闭结论

### `producer_lineage_completeness`

R8 关注点已经关闭。缺失 `stageFingerprint` /
`providerFingerprint` 现在有稳定诊断并已测试覆盖：

- [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:317)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:222)
- [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:269)

### `schema_runtime_compatibility`

R8 关注点已经关闭。layout mismatch、embedding dimension mismatch、
provider fingerprint mismatch、minimum runtime mismatch 以及 semantic digest
mismatch 都会 fail-closed，且已有实现与测试。

### `executable_contract_tests`

R8 关注点已经关闭。runtime gate hardening 三个新增测试已经把“缺失
stage/provider fingerprint、forged layout+embedding dimension”补齐；本轮复跑通过。

## 总结

当前实现满足本固定基准下的 runtime-provider 场景要求。R8 中的三个
`partial` 已全部关闭，本轮结论为 `pass`。
