# GraphRAG 单本书热插拔 R7 实现审计报告

## 审计范围

- Agent: `agent-1-fresh-vault`
- 场景: fresh vault / 首次挂载 / catalog projection / copy-delete hotplug /
  质量门
- 基准: R6 Agent 1 的 10 个固定审计基准
- 基准来源:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r6__open/agent-1-fresh-vault/`
- 输出目录:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r7__open/agent-1-fresh-vault/`
- 约束: 仅审计当前实现并写入审计产物，未修改实现、测试或设计文档。

## 总体结论

总体状态: `partial`

R7 当前实现维持 R6 的主要改进：fresh vault 可从当前
`BOOK_MANIFEST.json` + `PUBLISH_READY.json` 包集合重建 catalog projection；
新书创建先执行 pre-publish quality gate，再执行 staged candidate validation；
live root 发布时先删除旧 marker，最后写入 `PUBLISH_READY.json` 作为 mount
marker。失败路径会删除 marker 并写入 quality/runtime gate 诊断，使失败包不会被
投影为 query-ready capability。

剩余缺口仍是目录级原子发布（directory-level atomic publish）与完全
package-only 查询入口。实现尚未执行完整
`buildStagingRoot -> fsync -> atomic rename liveRoot`；live root 仍由多文件顺序
提交完成。查询 lineage 也仍读取 `catalog/books.yaml` 的部分 lineage 字段。

## 验证证据

本轮审计未重新运行会改写构建产物或 vault 状态的验证命令。用户提供的已通过
验证用于核对：

- `tsc`
- `build`
- hotplug catalog/backfill/runtime tests
- `unified-query`
- `cli-graphrag-route`
- real vault backfill:
  `--only-missing --rebuild-catalog --fail-fast => skipped 38, failed 0,
  catalog 38/38/30`

## 基准逐项判定

### 1. `direct_query_entrypoint` 直接查询入口

判定: `partial`

`loadGraphCapabilities()` 会先从 hotplug packages 确保 catalog projection，
缺失或陈旧时可重建 projection。CLI GraphRAG 查询会解析单书 capability，并将
runtime `dataDir` 指向选中书的 `books/{bookId}/graphrag/output`。仍为
`partial` 的原因是 `projectQueryReadyLineage()` 仍读取
`catalog/books.yaml` 的 `stageFingerprints` 与 `providerFingerprint`，不是完全
package-only entrypoint。

证据:
`src/graphrag/capability-catalog.ts:467`,
`src/graphrag/capability-catalog.ts:473`,
`src/graphrag/capability-catalog.ts:573`,
`src/graphrag/capability-catalog.ts:807`,
`src/cli/qmd.ts:3406`,
`src/cli/qmd.ts:3438`.

### 2. `artifact_minimum_closure` 查询 Artifact 最低闭包

判定: `pass`

`RequiredGraphRagArtifacts` 明确列出 output manifest、identity map、
artifact metadata、runtime compatibility、context/stats、parquet 集与 LanceDB。
manifest file entry 记录 path、role、bytes、sha256、required 与 sensitivity。
package validator 与 runtime gate 对缺失、bytes、sha256、metadata row 和 runtime
digest 均 fail closed。

证据:
`scripts/graphrag/book-hotplug-package.mjs:33`,
`scripts/graphrag/book-hotplug-package.mjs:520`,
`scripts/graphrag/book-hotplug-package.mjs:713`,
`src/graphrag/book-hotplug-runtime-gate.ts:163`.

### 3. `artifact_gate_state_machine` Artifact Gate 状态机

判定: `partial`

状态输出覆盖 `copied -> candidate -> validated -> mounted ->
query_ready|visible_not_query_ready|quarantined`。新书发布已包含 staged candidate
validation，candidate 失败不会进入 live marker。仍为 `partial` 的原因是状态机
未对应完整 live-root generation 原子切换；live root 仍是多文件顺序写入。

证据:
`scripts/graphrag/book-hotplug-quality-gate.mjs:114`,
`scripts/graphrag/batch-epub-workflow.mjs:10188`,
`scripts/graphrag/batch-epub-workflow.mjs:10219`,
`scripts/graphrag/batch-epub-workflow.mjs:10258`,
`scripts/graphrag/book-hotplug-publish-gate.mjs:27`.

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

manifest files、artifact metadata、producerRunIds、`graphrag/runs/*.yaml`、state
artifacts 与 checkpoints 形成多层绑定。缺失 producer runs 或 metadata row 会使
package validation 失败，并阻止 capability 派生。

证据:
`scripts/graphrag/book-hotplug-package.mjs:862`,
`scripts/graphrag/book-hotplug-package.mjs:870`,
`src/graphrag/book-hotplug-runtime-gate.ts:378`,
`test/graphrag-book-hotplug-catalog.test.ts:623`,
`test/graphrag-book-hotplug-catalog.test.ts:732`.

### 6. `schema_runtime_compatibility` Schema 与运行时兼容

判定: `pass`

包生成会写 `runtime-compatibility.json`，记录 package schema/layout、GraphRAG
artifact schema、runtime tool version、provider fingerprint、embedding dimension
和 schema digest。runtime gate 重新计算并比较
`outputManifestSchemaDigest`、`parquetSchemaDigest`、`lancedbSchemaDigest`、
`artifactMetadataSchemaDigest`。伪造 digest 测试确认 fail closed。

证据:
`scripts/graphrag/book-hotplug-package.mjs:539`,
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
`src/cli/qmd.ts:3438`,
`test/cli-graphrag-route.test.ts:892`,
`test/cli-graphrag-route.test.ts:918`.

### 8. `privacy_payload_exclusion` Provider Payload 排除

判定: `pass`

package validator 和 runtime gate 扫描 forbidden path。`provider-requests/**`、
`provider-responses/**`、logs/debug/trace、`.env`、`.durable-recovery.jsonl`、lock
和 corrupt 文件不会进入可发布包闭包。复制包中出现
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
post-live validation 失败会删除 publish marker。仍为 `partial` 的原因是 rollback
尚未覆盖完整 live root generation；恢复主要依赖 marker 删除、gate 诊断和
projection rebuild。

证据:
`scripts/graphrag/book-hotplug-quality-gate.mjs:57`,
`scripts/graphrag/book-hotplug-quality-gate.mjs:171`,
`scripts/graphrag/batch-epub-workflow.mjs:10260`,
`scripts/graphrag/book-hotplug-publish-marker.mjs:17`,
`test/graphrag-book-hotplug-backfill.test.ts:220`.

### 10. `executable_contract_tests` 可执行契约测试

判定: `partial`

现有测试覆盖 catalog 缺失/陈旧重建、provider payload 排除、producer runs 缺失、
artifact metadata 缺失、runtime compatibility forged、backfill duplicate
conflict、verify-only idempotency、CLI 多书 scope 和 selected book output。仍为
`partial` 的原因是缺少目录级 atomic publish / crash visibility 专门测试。

证据:
`test/graphrag-book-hotplug-catalog.test.ts:370`,
`test/graphrag-book-hotplug-catalog.test.ts:573`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:206`,
`test/graphrag-book-hotplug-backfill.test.ts:128`,
`test/cli-graphrag-route.test.ts:892`,
`test/unified-query.test.ts:1224`.

## 发现清单

1. `medium` / `artifact_gate_state_machine`:
   live root 发布仍是多文件顺序提交，未实现目录级 atomic rename liveRoot。
2. `medium` / `direct_query_entrypoint`:
   catalog projection 可从当前包集合重建，但 `projectQueryReadyLineage()` 仍依赖
   `catalog/books.yaml` 的 lineage 字段。
3. `medium` / `recovery_diagnostics`:
   失败恢复以 marker 删除、gate 诊断和 projection rebuild 为主，缺少完整
   last-good liveRoot generation rollback。
4. `low` / `executable_contract_tests`:
   现有测试覆盖主要 gate 和查询路径，但缺少目录级 atomic publish / crash
   visibility 专项测试。
