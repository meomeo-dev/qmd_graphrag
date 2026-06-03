# GraphRAG 单本书热插拔实现审计 R12 报告

## 审计元数据

- agent: `agent-1-fresh-vault`
- runId: `20260602_r12`
- scenario: fresh vault / 首次挂载 / catalog projection / copy-delete
  hotplug / 质量门
- fixedBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r12__open/agent-1-fresh-vault/fixed-baseline.yaml`
- fixedBaselineSha256:
  `94a81f0a1b22a3837b481d515d3a6f2c5a8365e2c6e007176ac6a7bdbcfe8f3c`
- baselinePolicy: 复用固定基准（fixed baseline），未新增、删除、改名、
  重排或改写基准。

## 总体结论

- overallStatus: `pass`
- baselineCount: `10`
- passed: `10`
- partial: `0`
- failed: `0`

R11 的三项剩余发现已关闭。当前实现满足 fresh-vault 复审重点：

1. `catalog` 与 `qmd` projection 只投影完整有效的 hotplug 包。
2. runtime query gate 校验 manifest sidecar 内容、publish marker sidecar
   内容，以及 `PUBLISH_READY.json.manifestSha256` 与 manifest 声明的一致性。
3. 创建期质量门（creation quality gate）保证单本书包可复制分发
   （copy-distributable），失败时不会发布可见 marker。

## R11 发现复核

### 1. catalog/qmd projection 包边界

结论：`closed`

`src/graphrag/book-hotplug-catalog.ts` 的 `loadBookManifest()` 在读取 manifest
前调用 `validatePublishedBookHotplugPackage()`，并在 query-ready 包上继续调用
`validateHotplugRuntimeQueryGate()`。因此存在 stale sidecar、缺失必需文件、
producer evidence 断裂、runtime compatibility 失败或 forbidden payload 的包，
不会进入 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
`graph-capabilities.yaml` 或 `qmd-projection.yaml`。

主要证据：

- `src/graphrag/book-hotplug-catalog.ts:170-188`
- `src/graphrag/book-hotplug-package-validator.ts:453-513`
- `src/graphrag/book-hotplug-runtime-gate.ts:484-538`
- `test/graphrag-book-hotplug-catalog.test.ts:617-724`
- `test/graphrag-book-hotplug-catalog.test.ts:862-1090`

真实 vault 只读交叉检查：

- `books/*` 目录数: `72`
- 有效已发布 hotplug 包: `38`
- invalid published candidates: `0`
- `catalog/books.yaml` items: `38`
- `catalog/qmd-projection.yaml` items: `38`
- `catalog/graph-capabilities.yaml` items: `30`
- valid package 与 books/qmd projection 集合差异: `[]`

### 2. runtime query gate sidecar 与 publish marker 校验

结论：`closed`

runtime gate 现在先执行 `validateBookHotplugPackageBoundary()`。该边界会校验：

- `BOOK_MANIFEST.json.sha256` 内容等于当前 manifest 文件 SHA-256。
- `BOOK_MANIFEST.json.sha256.meta.json` 的 `checksum` 等于当前 manifest
  文件 SHA-256。
- `PUBLISH_READY.json.sha256` 内容等于当前 publish marker 文件 SHA-256。
- `PUBLISH_READY.json.sha256.meta.json` 的 `checksum` 等于当前 marker
  文件 SHA-256。
- `PUBLISH_READY.json.bookId` 与 `packageGeneration` 匹配 manifest identity。
- `PUBLISH_READY.json.manifestSha256` 匹配
  `BOOK_MANIFEST.json.checksums.manifestSha256`。
- manifest 内嵌 checksum 与 canonical manifest 内容一致。

主要证据：

- `src/graphrag/book-hotplug-runtime-gate.ts:470-538`
- `src/graphrag/book-hotplug-package-validator.ts:182-224`
- `src/graphrag/book-hotplug-package-validator.ts:237-309`
- `src/graphrag/book-hotplug-package-validator.ts:453-504`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:221-291`

### 3. 创建期质量门与单书复制分发

结论：`closed`

创建流程先补齐 `qmd_graph_text_unit_identity.json` 及 sidecars，再执行
`pre_publish_source_truth` gate、candidate validation、live manifest write、
quality/runtime gate write、publish marker write、post-live validation。若任一
阶段失败，流程会移除或拒绝写入 `PUBLISH_READY.json`，并写入失败 gate 证据。

质量门通过时，`state/hotplug-quality-gate.json` 声明
`copyDistributionAllowed: true`，并记录 package copy contract：
`manifestValid`、`publishMarkerValid`、`directorySensitivePayloadFree`、
`requiredArtifactsPresent` 均为 `true`。gate 证据本身不进入可分发 manifest
file closure，避免本地质量报告破坏复制分发包的不可变闭包。

主要证据：

- `scripts/graphrag/book-hotplug-creation-identity.mjs:232-265`
- `scripts/graphrag/batch-epub-workflow.mjs:10188-10359`
- `scripts/graphrag/book-hotplug-quality-gate.mjs:57-179`
- `scripts/graphrag/book-hotplug-package.mjs:36-50`
- `scripts/graphrag/book-hotplug-package.mjs:376-417`
- `test/graphrag-book-hotplug-creation-gate.test.ts:21-107`

## 逐项判定

| # | baselineId | status | 判定摘要 |
|---|---|---|---|
| 1 | `direct_query_entrypoint` | pass | manifest-first direct query 可在全局 catalog 缺失时从包内 manifest、artifacts、producer evidence 推导 capability；入口仍通过 runtime gate。 |
| 2 | `artifact_minimum_closure` | pass | package builder 列出查询所需 GraphRAG artifact 最低闭包；validator 和 runtime gate 校验 bytes、sha256、required、缺失文件和目录 digest。 |
| 3 | `artifact_gate_state_machine` | pass | 创建/backfill/runtime gate 记录 copied、candidate、validated、mounted、query_ready、visible_not_query_ready、quarantined 转移；projection 前校验完整包边界。 |
| 4 | `producer_lineage_completeness` | pass | artifact metadata 要求 producer run、step、tool/schema version、stage/provider fingerprint、upstream hashes 与 createdAt；缺失时 fail closed。 |
| 5 | `lineage_artifact_binding` | pass | producer run bindings 校验 manifest producerRunIds、run records、artifactIds、stage/provider fingerprint 与 artifact metadata rows。 |
| 6 | `schema_runtime_compatibility` | pass | runtime compatibility gate 独立校验 package/layout/qmd/GraphRAG artifact schema、provider fingerprint、embedding dimension 与 schema digests。 |
| 7 | `query_scope_isolation` | pass | capability projection 只按单书 package root 与 bookId 读取包内 evidence；跨书、历史残留和 stale catalog 均不会提升为 query-ready。 |
| 8 | `privacy_payload_exclusion` | pass | forbidden roots 包括 provider requests/responses、logs、debug、trace、`.env` 等；validator 和 runtime gate 不依赖 provider payload。 |
| 9 | `recovery_diagnostics` | pass | sidecar mismatch、publish marker mismatch、artifact 缺失、lineage 断裂、schema digest mismatch 等均有稳定 diagnostics，并触发 projection rollback / fail closed。 |
| 10 | `executable_contract_tests` | pass | 当前目标测试覆盖 R11 回归面：invalid package projection rejection、stale sidecar、publish marker mismatch、creation gate、backfill 与 runtime hardening。 |

## 验证结果

已独立运行的目标测试：

- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `10/10` passed
- `npx vitest run test/graphrag-book-hotplug-qmd-projection.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `1/1` passed
- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `9/9` passed
- `npx vitest run test/graphrag-book-hotplug-creation-gate.test.ts --testTimeout 240000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `1/1` passed
- `npx vitest run test/graphrag-book-hotplug-runtime-gate-hardening.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `3/3` passed
- `npx vitest run test/graphrag-book-hotplug-backfill.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - result: `8/8` passed
- `npm exec -- tsc -p tsconfig.build.json --noEmit`
  - result: passed

合计 hotplug 目标测试：`32/32` passed。

## 剩余发现

`remainingFindings`: `[]`
