# Implementation Audit Agent 1 Post-Fix Review

## Scope

审计场景为 fresh-vault / 单书复制挂载
（fresh-vault single-book copy mount）。固定基准读取自：

`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-1-fresh-vault/baseline.yaml`

baseline SHA-256：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

本次复审未修改代码、未修改真实 `graph_vault`、未修改 baseline。只写入：

- `post-fix-report.md`
- `post-fix-summary.json`

重点复核前序阻断项：

1. 缺失包内 `graphrag/runs` producer evidence 后，
   `loadGraphQueryCapabilities()` 不得派生 query capability。
2. copied book dir 中未声明的 provider payload / forbidden residue
   必须被 validator fail closed。
3. fresh-vault 单书复制后仍可重建 catalog 并得到 query-ready 书。

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

结果：7/7 通过。新增覆盖包括：

- 未声明 `provider-requests/payload.json` 被
  `validateBookHotplugPackage()` 拒绝。
- 删除 `graphrag/runs` 后 `loadGraphQueryCapabilities()` 返回 0。

```bash
npx vitest run test/unified-query.test.ts --testTimeout 120000
```

结果：36/36 通过。

```bash
npx vitest run test/cli-graphrag-route.test.ts \
  --testTimeout 120000 \
  --pool forks \
  --poolOptions.forks.singleFork=true
```

结果：9/9 通过。前序超时的非 JSON evidence 用例本次通过，
耗时约 25.6s，仍接近用例自身 30s 上限。

## Real Vault Read-Only State

真实 `graph_vault` 只读统计：

- `graph_vault/books` 目录数：72
- hotplug package 数量：38
- `validateBookHotplugPackage()`：38/38 通过
- `state/hotplug-quality-gate.json`：38/38 存在
- `copyDistributionAllowed: true`：38/38
- catalog `books.yaml`：38
- catalog `sources.yaml`：38
- catalog `document-identity-map.yaml`：38
- catalog `graph-capabilities.yaml`：30
- manifest `graphrag.queryReady: true`：30
- manifest `graphrag.queryReady: false`：8

抽样 query-ready 书：

`book-00474fb29e5e-59d02d41`

该书 manifest 声明：

- `graphrag.requiredArtifacts`：12
- `graphrag.producerRunIds`：
  `graph_extract-20260526223809-86vlf0`,
  `community_report-20260601023049-katk61`,
  `embed-20260601025030-65qs6n`,
  `query_ready-20260601025627-hplusm`
- `graphRagArtifactSchema`：`graphrag-output-v1`
- `artifactSchema`：`graphrag-output-v1`

`artifact-metadata.json` 含 11 行 artifact metadata，记录了
`path`、`fileSha256`、`bytes`、`required`、`producerRunId`、
`stageFingerprint`、`providerFingerprint`、`corpusContentHash` 和
`createdAt`。

## Fresh Vault Copy Scenarios

所有场景均在 `/tmp` 下建立临时 vault，只复制真实样本书目录，不修改真实
`graph_vault`。

### Positive Copy

只复制：

`graph_vault/books/book-00474fb29e5e-59d02d41`

到新的临时 `graph_vault/books/` 后：

- `validateBookHotplugPackage()`：通过
- catalog rebuild：`bookCount=1`, `identityCount=1`,
  `capabilityCount=1`
- `loadGraphQueryCapabilities()`：返回 1 个 query capability
- capability bookId：
  `book-00474fb29e5e-59d02d41`

结论：fresh-vault 单书复制挂载正向路径通过。

### Missing Producer Runs

在临时副本中删除：

`books/book-00474fb29e5e-59d02d41/graphrag/runs`

结果：

- 删除前 `.yaml` run evidence 数量：26
- `validateBookHotplugPackage()`：失败
- diagnostics 包含 `missing_required_file:graphrag/runs/...`
  和 `missing_producer_run:...`
- catalog rebuild：`bookCount=1`, `identityCount=1`,
  `capabilityCount=0`
- `loadGraphQueryCapabilities()`：返回 0

结论：前序阻断项 1 已修复。缺 producer evidence 时 runtime query
capability 不再从 book state 绕过派生。

### Stray Provider Payload

在临时副本中额外写入：

`provider-requests/payload.json`

结果：

- `validateBookHotplugPackage()`：失败
- diagnostics 包含：
  `forbidden_sensitive_material:provider-requests/payload.json`
- catalog rebuild：`bookCount=1`, `identityCount=1`,
  `capabilityCount=0`
- `loadGraphQueryCapabilities()`：返回 0

结论：前序阻断项 2 已修复。复制整个 book dir 时，未声明 provider
payload / forbidden residue 会被目录级 validator fail closed。

## Baseline Results

### 1. direct_query_entrypoint: pass

fresh-vault 单书复制后，系统可从包内 manifest、publish marker、source、
input、qmd、state、GraphRAG output 和 producer runs 重建 projection，
并在查询入口得到该书 query capability。缺 run evidence 或出现 forbidden
payload 时，runtime gate 会阻断查询 capability。

该结论限定为“从 copied package 重建当前 projection”。实现不依赖旧
catalog、发送方绝对路径或 provider payload。

### 2. artifact_minimum_closure: pass

实现声明并验证 GraphRAG 查询最低 artifact 集合，包括 output manifest、
text-unit identity、artifact metadata、context、stats、核心 parquet 文件和
LanceDB。缺失或替换 required artifact 会 fail closed。

真实包 38/38 validator 通过，抽样包的 artifact metadata 记录了文件路径、
bytes、sha256、required、producer run 与 fingerprint。

### 3. artifact_gate_state_machine: partial

实现已具备可执行 gate：

- package validator
- runtime query gate
- catalog projection rebuild gate
- quality gate evidence
- missing runs / forbidden payload fail closed

但固定基准要求 copied、candidate、validated、mounted、query-ready、
visible_not_query_ready、quarantined 的完整状态、转移条件、诊断输出和
禁止查询条件。当前实现仍以函数级 gate 与 catalog projection 行为表达，
未形成完整、持久化、可观察的状态机。

### 4. producer_lineage_completeness: partial

前序核心漏洞已修复：缺失 `graphrag/runs` 时 validator、catalog rebuild 和
runtime query capability 均 fail closed。

当前 evidence 已覆盖 producer run id、stage、input fingerprint、
artifact id、file hash、stage fingerprint、provider fingerprint、内容 hash
和生成时间。固定基准还要求每个查询必需 artifact 均可追溯到 producer
run、step、input hash、tool version、schema version、生成时间和上游
artifact hash。真实样本 run evidence 未显示逐 artifact 的完整 step、
tool version 与 upstream artifact hash 闭包，因此仍为 partial。

### 5. lineage_artifact_binding: pass

manifest `producerRunIds`、`graphrag/runs`、state artifacts、
`artifact-metadata.json` 与 files 闭包现在形成运行时硬门：

- 删除 run evidence 后 validator 失败。
- 删除 run evidence 后 catalog 不投影 capability。
- 删除 run evidence 后 `loadGraphQueryCapabilities()` 返回 0。
- 替换 required artifact 的既有测试能触发 hash / bytes mismatch。

该基准在 Agent 1 的 fresh-vault 查询入口场景中通过。

### 6. schema_runtime_compatibility: partial

manifest 和 metadata 记录了 package layout、GraphRAG artifact schema、
output manifest schema、stage fingerprint、provider fingerprint 和内容 hash。

不足是实现仍未提供完整兼容矩阵：GraphRAG runtime、parquet schema、
LanceDB schema、embedding model/dimension、output manifest schema 与
package layout schema 的组合验证和诊断仍不充分。

### 7. query_scope_isolation: pass

CLI 测试确认 `--graph-book-id` 使用所选书的
`books/{bookId}/graphrag/output`，不会混入 sibling roots。fresh-vault 单书
复制只生成该书的 1 个 query capability。

### 8. privacy_payload_exclusion: pass

前序漏洞已修复。validator 现在目录级扫描 forbidden path，临时副本中额外
放入 `provider-requests/payload.json` 会得到：

`forbidden_sensitive_material:provider-requests/payload.json`

runtime query gate 也会阻断 capability。真实样本包未需要 provider request、
response、secret 或 payload 才能查询。

### 9. recovery_diagnostics: partial

缺 artifact、缺 producer runs、forbidden payload、hash / bytes 不匹配均有
稳定 diagnostics，且可通过 backfill / package rebuild 路径修复。

不足是 runtime 查询入口返回 0 capability 时，面向用户的诊断暴露仍不完整；
quarantine 行为、projection rollback 语义和状态恢复记录未完全统一到固定
状态机。

### 10. executable_contract_tests: partial

新增测试覆盖了前序两个阻断项，相关聚焦测试通过：

- hotplug catalog：7/7
- unified query：36/36
- CLI GraphRAG route：9/9

仍缺完整 schema/runtime/parquet/LanceDB/embedding dimension 不兼容测试，
以及完整状态机、quarantine、diagnostic exposure 的契约测试。CLI 非 JSON
evidence 用例本次通过，但耗时接近自身 30s 上限，存在性能边界风险。

## Final Assessment

`overall_result: partial`

前序 Agent 1 的两个阻断 fail 项已修复：

- 缺失 `graphrag/runs` producer evidence 后不再派生 query capability。
- copied book dir 中未声明 provider payload 会被 fail closed。

fresh-vault 单书复制正向挂载仍通过。

未给 full pass 的原因是固定 10 项基准中仍有部分高阶合同未完全满足：
完整 artifact gate 状态机、逐 artifact producer lineage 完整性、
schema/runtime 兼容矩阵、诊断暴露和 quarantine/rollback 行为仍为 partial。
