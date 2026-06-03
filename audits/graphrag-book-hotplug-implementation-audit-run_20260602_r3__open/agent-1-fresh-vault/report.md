# Implementation Audit Agent 1: Fresh Vault 单书复制挂载

## Scope

审计场景为 fresh-vault / 单书复制挂载（single-book copy mount）：
用户只复制 `graph_vault/books/{bookId}` 到新的 `graph_vault` 后，
系统能否仅凭包内 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、`source/`、
`input/`、`qmd/`、`state/`、`graphrag/output/`、`graphrag/runs/`
重建 catalog projection，并在 GraphRAG 查询入口形成可用状态。

固定基准读取自：
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-1-fresh-vault/baseline.yaml`

baseline SHA-256：
`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

本审计只读实现与真实 `graph_vault`，未修改代码、真实 vault 数据或
baseline。

## Commands

```bash
shasum -a 256 \
  audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-1-fresh-vault/baseline.yaml
```

结果：baseline hash 与固定值一致。

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
```

结果：通过。

```bash
npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000
```

结果：5/5 通过。

```bash
npx vitest run \
  test/cli-graphrag-route.test.ts \
  test/unified-query.test.ts \
  test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000
```

结果：49/50 通过。失败用例为
`qmd query --graphrag non-json formats project unified evidence`，
原因是该用例自身 30000ms timeout。其余 CLI GraphRAG 入口、fresh-vault
settings projection、book-scoped output、hotplug catalog、unified-query
相关用例通过。

```bash
node --input-type=module <real-vault-package-validation>
```

结果：真实 vault 中 38/38 个 `BOOK_MANIFEST` package validator 通过；
38/38 个 `state/hotplug-quality-gate.json` 为 `status: passed` 且
`copyDistributionAllowed: true`；38/38 存在
`graphrag/output/artifact-metadata.json`；catalog 当前为 38 books、
38 identities、30 graph capabilities。

```bash
node --input-type=module <fresh-vault-single-book-copy>
```

结果：只复制 `graph_vault/books/book-00474fb29e5e-59d02d41` 到临时新
vault 后，`validateBookHotplugPackage` 通过，catalog rebuild 生成
1 book、1 identity、1 graph capability，`loadGraphQueryCapabilities`
返回 1 个该书 capability，包内未发现 `provider-requests`、
`provider-responses`、`logs` 目录。

```bash
node --input-type=module <negative-gate-scenarios>
```

结果：

- 删除 `graphrag/output/community_reports.parquet`：
  validator fail，diagnostic 为
  `missing_required_file:graphrag/output/community_reports.parquet`，
  rebuild 后 capabilityCount 为 0。
- 替换 `graphrag/output/community_reports.parquet`：
  validator fail，diagnostics 包含 `file_sha256_mismatch`、
  `file_bytes_mismatch`、`artifact_metadata_bytes_mismatch`，
  rebuild 后 capabilityCount 为 0。
- 删除 `graphrag/runs/*.yaml`：
  validator fail，catalog rebuild capabilityCount 为 0，但
  `loadGraphQueryCapabilities` 仍返回 1 个 capability。

```bash
node --input-type=module <provider-payload-stray-file-scenario>
```

结果：在复制包内额外写入
`provider-requests/payload.json` 后，`validateBookHotplugPackage`
仍返回 `validationOk: true`，diagnostics 为空。

## Baseline Results

### 1. direct_query_entrypoint: partial

正向路径通过：`resolveBookGraphRagDataDir` 能按
`BOOK_MANIFEST.json` 的 `graphrag.outputManifestPath` 定位
`books/{bookId}/graphrag/output`；CLI 用例验证了 `--graph-book-id`
只使用选定书的 book-scoped output；fresh-vault 单书复制后可重建 catalog
并查询到该书 capability。

未完全通过的原因是查询能力加载路径仍可绕过 `graphrag/runs` 证据：
删除包内全部 `graphrag/runs/*.yaml` 后，catalog rebuild 不再投影
capability，但 `loadGraphQueryCapabilities` 又从 book state 派生出
1 个 capability。直接查询入口因此尚未严格保证“缺 producer evidence
时不可查询”。

相关实现位置：

- `src/graphrag/capability-catalog.ts:661`
- `src/graphrag/capability-catalog.ts:746`

### 2. artifact_minimum_closure: pass

实现明确列出 GraphRAG 查询最低 artifact 集合，包括：
`qmd_output_manifest.json`、`qmd_graph_text_unit_identity.json`、
`artifact-metadata.json`、`context.json`、`stats.json`、核心 parquet
文件、`community_reports.parquet` 和 `lancedb`。

`validateBookHotplugPackage` 检查 manifest sidecar、publish marker、
source closure、canonical input、manifest files 的 bytes/sha256、
required artifacts 与 artifact metadata。删除或替换必需 artifact
均 fail closed，且不会生成可查询 capability。

相关实现位置：

- `scripts/graphrag/book-hotplug-package.mjs:39`
- `scripts/graphrag/book-hotplug-package.mjs:672`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs`

### 3. artifact_gate_state_machine: partial

实现具备部分状态与门禁行为：

- `mountScanBookPackages` 将 package 分为 mounted / failed。
- migration state 能标记 `already_migrated`、`legacy_only`、
  `repair_required`、`residue_quarantined`。
- creation flow 在写 `BOOK_MANIFEST` 前后执行质量门，并在失败时中断。

但固定基准要求 copied、candidate、validated、mounted、query-ready、
visible_not_query_ready、quarantined 的完整状态、转移条件、诊断输出和
禁止查询条件。当前实现未形成完整可观察状态机；更重要的是，删除
`graphrag/runs` 后 `loadGraphQueryCapabilities` 仍可派生 capability，
说明 artifact gate 通过前不得投影为可查询的约束尚未完全闭合。

相关实现位置：

- `scripts/graphrag/book-hotplug-quality-gate.mjs:15`
- `scripts/graphrag/batch-epub-workflow.mjs:10120`
- `src/graphrag/capability-catalog.ts:661`

### 4. producer_lineage_completeness: fail

当前包内 metadata 与 state 已包含 `producerRunId`、stage fingerprint、
provider fingerprint、content hash 等证据，但未达到固定基准要求的
完整 lineage（producer run、step、input hash、tool version、schema
version、生成时间、上游 artifact hash）逐 artifact 闭包。

实测删除 `graphrag/runs/*.yaml` 后，validator 能失败，catalog rebuild
也不投影 capability；但 runtime capability loader 仍从 `state` 派生
1 个 query capability。这证明 producer run evidence 不是查询能力的
硬性条件。

### 5. lineage_artifact_binding: fail

实现已通过 `artifact-metadata.json` 和 artifact set validation 绑定
artifact hash、file sha、bytes 与 producer run id；删除或篡改
`community_reports.parquet` 能被阻断。

但 manifest `producerRunIds`、`graphrag/runs` 证据与 files 闭包之间的
绑定不是运行时查询 gate 的强制前置条件。删除全部 run evidence 后，
`loadGraphQueryCapabilities` 仍返回 capability，违反“不能把孤立残留或
被替换文件声明为 queryReady”的核心要求。

相关实现位置：

- `src/graphrag/book-hotplug-catalog.ts:430`
- `src/graphrag/capability-catalog.ts:448`
- `src/graphrag/capability-catalog.ts:661`

### 6. schema_runtime_compatibility: partial

manifest 记录了 `layoutVersion`、`graphRagArtifactSchema`、
`artifactSchema`、`qmdIndexSchema` 与最低版本；catalog projection 使用
`stageFingerprints`、`providerFingerprint` 与 content hash 参与验证。

不足是实现未显式验证 GraphRAG runtime 版本、parquet schema、LanceDB
schema、embedding model/dimension、output manifest schema 与 package
layout schema 的完整兼容矩阵。当前更多是文件存在性、hash、fingerprint
级验证，schema/runtime 不兼容时的诊断与 query gate 行为仍不充分。

### 7. query_scope_isolation: pass

单书范围隔离通过。CLI 测试确认 `--graph-book-id` 使用
`books/{bookId}/graphrag/output`，并且响应中不泄漏 `graphVault` 绝对路径。
fresh-vault 单书复制只生成该书 1 个 capability。

artifact validation 要求 artifact path 属于 book-scoped graph output；
测试覆盖了 outside path 被拒绝的行为。

相关实现位置：

- `src/graphrag/book-package-layout.ts:35`
- `src/graphrag/capability-catalog.ts:532`
- `test/cli-graphrag-route.test.ts:918`

### 8. privacy_payload_exclusion: partial

manifest 生成时排除 `.env`、`provider-requests/**`、
`provider-responses/**`、logs/debug/trace 等敏感路径；真实 package
样本的 manifest files 中未发现 provider payload 路径，fresh-vault
复制样本中也未发现 provider payload 目录。

不足是 validator 只检查 manifest files 内的 forbidden path。若用户复制的
book 目录中额外存在未声明的 `provider-requests/payload.json`，
`validateBookHotplugPackage` 仍返回通过。由于目标使用方式是复制整个
`books/{bookId}` 目录，当前实现不能完全保证目录级传播不会携带未声明
provider payload。

相关实现位置：

- `scripts/graphrag/book-hotplug-package.mjs:26`
- `scripts/graphrag/book-hotplug-package.mjs:786`

### 9. recovery_diagnostics: partial

缺失 artifact、hash/bytes 不匹配、source/input 缺失、migration source
truth 不满足时，已有稳定 diagnostics 与质量门记录；migration evidence
也包含 residue/quarantine、copy map、checkpoint 和 rollback plan。

不足是 runtime query capability 被过滤时缺少面向用户的稳定诊断输出；
删除 `graphrag/runs` 后 catalog projection 能 fail closed，但
`loadGraphQueryCapabilities` 又派生 capability，未形成一致的 quarantine
行为与 projection rollback 语义。

### 10. executable_contract_tests: partial

已有自动化覆盖 fresh-vault catalog rebuild、stale catalog rebuild、
source closure fail closed、quality gate evidence 不进入 package closure、
CLI book-scoped output、fresh-vault settings projection、artifact 缺失、
artifact path 越界、query-ready checkpoint 缺失等场景。

缺口：

- hotplug package 删除 `graphrag/runs/*.yaml` 后 runtime query gate 必须
  返回 0 capability 的测试缺失。
- 未声明 provider payload 出现在 copied book directory 时应 fail closed
  或 quarantine 的测试缺失。
- schema/runtime/parquet/LanceDB/embedding dimension 不兼容的契约测试不足。
- focused suite 当前有 1 个 CLI 非 JSON 输出测试存在 30s timeout 风险。

## overall_result

fail

正向路径已经可用：真实 vault 38/38 package validator 通过，38/38 质量门
通过，单书 fresh-vault 复制可生成 1 个 query capability，book-scoped
output 与 settings projection 测试通过。

但 Agent 1 固定基准要求的是可分发包在缺 artifact、缺 lineage、schema
不兼容和 provider payload 风险下全部 fail closed。当前至少存在两个阻断
问题：

1. 删除 `graphrag/runs/*.yaml` 后，`loadGraphQueryCapabilities` 仍可从
   book state 派生 query capability。
2. copied book directory 中存在未声明 `provider-requests` payload 时，
   package validator 仍通过。

因此不能判定 fresh-vault / 单书复制挂载场景完全通过。

## 残余风险

- Query gate 需要统一使用 manifest、artifact metadata、state artifacts、
  checkpoints 与 `graphrag/runs` 的完整闭包；缺任一 producer run evidence
  时应返回 0 capability，并给出稳定 diagnostic。
- `validateBookHotplugPackage` 应扫描整个 book directory 的 forbidden
  path，而不只检查 manifest files 内声明的路径。否则用户复制目录传播时
  可能携带未声明 provider payload。
- Schema/runtime compatibility gate 仍偏弱，建议补齐 parquet schema、
  LanceDB schema、embedding dimension、GraphRAG runtime version 与 package
  layout version 的可执行检查。
- CLI focused suite 的非 JSON 输出用例有 30s timeout 风险，建议拆分或
  降低 fixture 初始化成本，避免审计和 CI 结果受性能波动影响。

## 下一步修复建议

1. 在 `projectQueryReadyLineage` 或其调用链中强制验证
   `manifest.graphrag.producerRunIds` 对应的 `graphrag/runs/{runId}.yaml`
   存在且可解析，并要求 run artifactIds 覆盖 query-ready artifact closure。
2. 禁止 `deriveCapabilitiesFromBookState` 在缺少 hotplug run evidence 时
   派生 query capability；必要时只允许返回 visible-not-query-ready 诊断，
   不返回 query capability。
3. 在 `validateBookHotplugPackage` 中增加 package directory 全量 forbidden
   path scan；发现 provider payload、logs、`.env`、recovery payload 时
   fail closed，并写入可修复诊断。
4. 增加三类契约测试：missing `graphrag/runs`、stray provider payload、
   schema/runtime mismatch。
