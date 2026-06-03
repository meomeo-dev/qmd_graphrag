# Implementation Audit Agent 1 R4: Fresh Vault 单书复制导入

## 审计边界

场景为 fresh-vault single-book copy/import（单书复制导入）：
只复制 `graph_vault/books/{bookId}` 到新的 `graph_vault` 后，
系统是否能够仅凭包内 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
`source/`、`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/`
与必要投影（projection）完成挂载、查询门控与单书 GraphRAG 查询闭环。

本轮固定基准复用如下既有文件，未新增、删除、重命名或重排 baseline 维度：

- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/baseline.yaml`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/report.md`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/summary.json`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/post-fix-report.md`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/post-fix-summary.json`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/post-runtime-compat-rerun-20260602-report.md`
- `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/`
  `agent-1-fresh-vault/post-runtime-compat-rerun-20260602-summary.json`

`agent-1-fresh-vault/` 目录内未见独立 `criteria` 文件；本轮固定审计维度完全以
`baseline.yaml` 的 10 个维度为准，并保持原顺序不变。

baseline SHA-256：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

本轮仅执行只读检查与临时目录验证（temporary vault verification）：

- 未修改生产代码（production code）
- 未修改测试（tests）
- 未修改真实 `graph_vault`
- 未修改 baseline

## 重点复核结论

本轮重点复核的三项最近修复均已得到当前工作区证据支持：

1. runtime-compatibility semantic digest gate（语义摘要门）
   已生效。
   `test/graphrag-book-hotplug-runtime-gate.test.ts` 1/1 通过；
   对真实 backfill 样本包的临时复制副本伪造
   `runtime-compatibility.json.schemaDigests.parquetSchemaDigest`
   后，`validateBookHotplugPackage()` 与
   `validateHotplugRuntimeQueryGate()` 同时 fail closed，
   `capabilityCount` 降为 0。

2. `test/graphrag-book-hotplug-runtime-gate.test.ts`
   负例（negative case）存在且通过。
   该测试验证 forged semantic digest 不会被运行时查询门放行。

3. 真实 backfill 后 38/38 包质量门（quality gate）通过。
   当前真实 `graph_vault` 中：
   `validateBookHotplugPackage()` 为 38/38 通过，
   `state/hotplug-quality-gate.json.copyDistributionAllowed`
   为 38/38 `true`，
   `graphrag/output/runtime-compatibility.json` 为 38/38 存在。

前序 `r3` 中与 Agent 1 相关的两项阻断问题，本轮均未复现：

- 缺失 `graphrag/runs` 后派生 query capability
- copied book dir 中混入 undeclared provider payload 仍被放行

## 验证摘要

### 真实 vault 只读盘点

当前真实 `graph_vault` 状态：

- `graph_vault/books` 目录数：72
- 完整 hotplug package 数：38
- `validateBookHotplugPackage()`：38/38 通过
- `BOOK_MANIFEST.json`：38/38
- `PUBLISH_READY.json`：38/38
- `artifact-metadata.json`：38/38
- `runtime-compatibility.json`：38/38
- `state/hotplug-quality-gate.json`：38/38
- `copyDistributionAllowed: true`：38/38
- `state/hotplug-runtime-gate.json`：38/38
- manifest `graphrag.queryReady: true`：30
- manifest `graphrag.queryReady: false`：8
- runtime gate `currentState: query_ready`：30
- runtime gate `currentState: visible_not_query_ready`：8
- runtime gate `currentState: quarantined`：0

query-ready 抽样包：

`book-00474fb29e5e-59d02d41`

该样本的 `artifact-metadata.json` 已包含逐 artifact 的：

- `producerRunId`
- `producerStep`
- `producerToolVersion`
- `producerSchemaVersion`
- `upstreamArtifactHashes`
- `createdAt`

对应 `graphrag/runs/*.yaml` 已提供 `inputFingerprint` 与 `artifactIds`。

non-query-ready 抽样包：

`book-0c8dffd9585c-41a7e47b`

其 `state/hotplug-runtime-gate.json.currentState` 为
`visible_not_query_ready`。

### 临时 fresh vault 正向复制导入

将真实样本包
`graph_vault/books/book-00474fb29e5e-59d02d41`
复制到临时 fresh vault 后：

- `validateBookHotplugPackage()`：通过
- `validateHotplugRuntimeQueryGate()`：`ok: true`
- catalog rebuild：
  `bookCount=1`, `identityCount=1`, `capabilityCount=1`
- `loadGraphQueryCapabilities()`：返回 1 个 capability
- capability id：
  `book-00474fb29e5e-59d02d41:graph_query`

结论：fresh-vault 单书复制导入正向路径通过。

### 真实样本包的 semantic digest 负向验证

对同一真实样本包的临时复制副本，按 durable sidecar 规则重写
`runtime-compatibility.json`，仅伪造
`schemaDigests.parquetSchemaDigest="forged"`，
并同步刷新该文件 sidecar、manifest 文件条目与 publish marker 后：

- `validateBookHotplugPackage()`：失败
- diagnostics 包含：
  `runtime_compatibility_digest_mismatch:parquetSchemaDigest`
- 同时还出现：
  `artifact_metadata_file_sha_mismatch:graphrag/output/runtime-compatibility.json`
  与
  `artifact_metadata_bytes_mismatch:graphrag/output/runtime-compatibility.json`
- `validateHotplugRuntimeQueryGate()`：失败
- catalog rebuild：
  `bookCount=1`, `identityCount=1`, `capabilityCount=0`
- `loadGraphQueryCapabilities()`：返回 0

结论：runtime-compatibility semantic digest gate 已接入真实单书导入路径，
并与 artifact metadata 绑定形成双重 fail-closed 行为。

## 固定 10 维度判定

### 1. `direct_query_entrypoint`: pass

真实 query-ready 样本包复制到临时 fresh vault 后，
仅凭包内 manifest、publish marker、artifacts、runs 与重建投影即可得到
1 个 `graph_query` capability。运行时 gate 为 `ok: true`，未依赖旧 catalog、
发送方绝对路径或 provider payload。

### 2. `artifact_minimum_closure`: pass

真实 backfill 产物中，38/38 包同时具备 manifest、publish marker、
artifact metadata、runtime compatibility 与必需 GraphRAG outputs。
伪造 `runtime-compatibility.json` 语义摘要后，
validator、runtime gate 与 capability projection 同时 fail closed。

### 3. `artifact_gate_state_machine`: partial

实现已具备显式 runtime gate state 文件，并在真实样本中观察到：

- `query_ready`
- `visible_not_query_ready`

`scripts/graphrag/book-hotplug-quality-gate.mjs`
也定义了 `copied -> candidate -> validated -> mounted -> final state`
转移记录。

但本轮未观察到 receiver-side（接收端）在失败导入时自动持久化新的
`quarantined` 状态；真实 38 包中 `runtimeGateQuarantined=0`，
因此仍不足以给出完整状态机通过判定。

### 4. `producer_lineage_completeness`: partial

真实样本的 `artifact-metadata.json` 已补齐逐 artifact 的
`producerRunId`、`producerStep`、`producerToolVersion`、
`producerSchemaVersion`、`upstreamArtifactHashes` 与 `createdAt`，
且 `graphrag/runs/*.yaml` 提供 `inputFingerprint`。

但当前 runtime gate 主要校验：

- 引用的 `producerRunIds` 是否存在
- metadata row 是否存在并与 manifest/file hash 对齐

尚未执行逐 artifact 的完整 join 验证，以证明每个 query-required artifact
都已在运行时被核对到对应 run 的 `inputFingerprint`、tool/schema 约束与
上游闭包（upstream closure）。因此维持 `partial`。

### 5. `lineage_artifact_binding`: pass

`manifest.producerRunIds`、`graphrag/runs`、
`artifact-metadata.json` 与 capability projection 已形成运行时硬绑定。
`test/graphrag-book-hotplug-catalog.test.ts`
中“缺失 producer runs 不得派生 capability”用例通过；
真实样本包伪造 `runtime-compatibility.json` 后 capability 也归零。

### 6. `schema_runtime_compatibility`: partial

`runtime-compatibility.json` 已成为真实 38/38 包的 required gate artifact。
其内容已记录：

- `toolVersion`
- `minQmdGraphRagVersion`
- `embeddingVectorDimension`
- output manifest / parquet / LanceDB / artifact metadata digests

并且 forged digest 负例已在单测与真实样本临时复制场景下通过。

不足是当前 gate 仍主要校验：

- `compatibilityStatus === "compatible"`
- digest 是否与包内文件闭包匹配

尚未把“当前运行时（current runtime）与包声明 runtime/parquet/LanceDB/
embedding”的实值兼容矩阵做成完整比较，因此仍为 `partial`。

### 7. `query_scope_isolation`: pass

临时 fresh vault 单书复制仅得到该书 1 个 capability。
`unified-query` 与 CLI GraphRAG 测试继续覆盖 book-scoped output 与
fresh-vault settings projection，没有观察到 sibling roots 混入。

### 8. `privacy_payload_exclusion`: pass

`test/graphrag-book-hotplug-catalog.test.ts`
中“undeclared provider payload”负例通过。
运行时 gate 与 package validator 都会扫描 forbidden path。
当前查询闭环不读取、要求或传播 provider request/response payload。

### 9. `recovery_diagnostics`: partial

本轮已观察到稳定 diagnostics，包括：

- `missing_producer_run:*`
- `forbidden_sensitive_material:*`
- `runtime_compatibility_digest_mismatch:*`
- `artifact_metadata_file_sha_mismatch:*`
- `artifact_metadata_bytes_mismatch:*`

`state/hotplug-runtime-gate.json` 也保留
`projectionRollbackRequired` 与 `recoveryAction` 字段。
但 receiver-side 持久化 quarantine 与统一回滚可观测性仍不足，
因此维持 `partial`。

### 10. `executable_contract_tests`: partial

与本轮重点修复直接相关的自动化测试现状：

- `test/graphrag-book-hotplug-runtime-gate.test.ts`：1/1 通过
- `test/graphrag-book-hotplug-catalog.test.ts`：8/8 通过
- `test/unified-query.test.ts`：36/36 通过
- `test/cli-graphrag-route.test.ts`：8/9 通过

剩余失败仍是既有非 JSON CLI evidence 格式用例 30s timeout，
并伴随临时目录清理 `ENOTEMPTY`。
此外，完整状态机与完整 runtime compatibility matrix 的契约测试仍未闭环，
因此该维度提升到 `partial`，但不达 `pass`。

## 结论

本轮结论为 `partial`（部分满足 / partial compliance）。

与用户点名的最近修复相关的实现审计结果如下：

- runtime-compatibility semantic digest gate：通过复核
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 负例：通过复核
- 真实 backfill 后 38/38 包质量门：通过复核

相较 `r3` 的 post-runtime-compat 复跑状态，本轮未复现当时的
`executable_contract_tests: fail`。当前 `hotplug-catalog` 已恢复为 8/8 通过，
因此此前 Agent 1 的阻断项可视为已清除。

仍未给出 full pass 的原因是：

- 完整持久化 artifact gate 状态机仍不充分
- 逐 artifact lineage 完整运行时核验仍不充分
- schema/runtime 兼容矩阵仍不完整
- CLI GraphRAG 非 JSON 输出路径仍有 1 个已知 timeout

## Commands

```bash
shasum -a 256 \
  audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/\
agent-1-fresh-vault/baseline.yaml

npm exec -- tsc -p tsconfig.build.json --noEmit

npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts \
  --testTimeout 120000

npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000

node --import tsx --input-type=module <<'EOF'
# real vault inventory / validator / quality-gate / runtime-gate scan
EOF

node --import tsx --input-type=module <<'EOF'
# positive fresh-vault single-book copy/import verification
EOF

node --import tsx --input-type=module <<'EOF'
# forged runtime-compatibility semantic digest on copied real package,
# with sidecars + manifest/publish marker refreshed
EOF

npx vitest run test/unified-query.test.ts --testTimeout 120000

npx vitest run test/cli-graphrag-route.test.ts \
  --testTimeout 120000 \
  --pool forks \
  --poolOptions.forks.singleFork=true
```
