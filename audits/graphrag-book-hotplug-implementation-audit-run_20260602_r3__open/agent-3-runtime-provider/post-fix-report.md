# Implementation Audit Agent 3 Post-Fix Report

## Scope

审计身份：`agent-3-runtime-provider`。

审计场景：runtime/provider/settings 波动下，单书 hotplug GraphRAG 查询是否能
从包内证据恢复并 fail closed。

固定基准：
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-3-runtime-provider/baseline.yaml`。

本复审只读实现、设计合同和真实 `graph_vault` 状态；未修改代码、真实
`graph_vault` 数据或 baseline。写入范围仅限本报告与
`post-fix-summary.json`。

## Commands

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
```

结果：通过。

```bash
npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：7/7 通过。覆盖 provider payload 拒绝、缺 producer runs 不派生
query capability、stale catalog rebuild、source closure fail closed、quality
gate 不进入包闭包。

```bash
npx vitest run test/unified-query.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：36/36 通过。

```bash
npx vitest run test/integrations/python-bridge-early-stop.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：7/7 通过。

```bash
npx vitest run test/cli-graphrag-route.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：9/9 通过。前次超时的非 JSON evidence 用例本次通过。

```bash
node --import tsx --input-type=module <real-vault-readonly-and-fresh-copy-check>
```

结果：

- 真实 `graph_vault/books` 目录：72
- `BOOK_MANIFEST.json` 包：38
- `PUBLISH_READY.json`：38
- `graphrag/output/artifact-metadata.json`：38
- `state/hotplug-quality-gate.json` passed 且
  `copyDistributionAllowed=true`：38
- `validateBookHotplugPackage`：38/38 通过
- runtime query gate：30/38 通过
- `BOOK_MANIFEST.graphrag.queryReady=true`：30
- catalog：38 books、38 identities、30 graph capabilities
- stale graph capability book id：0
- 8 个 not query-ready 包均返回 `manifest_not_query_ready` 与
  `missing_producer_run:*` 诊断，不投影 query capability。

临时 fresh-vault 复制测试：

- 单独复制 `book-00474fb29e5e-59d02d41` 后 rebuild catalog：
  1 book / 1 identity / 1 graph capability。
- 删除该复制包内 `graphrag/runs` 后 runtime gate 失败，query capability
  count 变为 0。
- 在复制包内新增 `provider-requests/payload.json` 后
  `validateBookHotplugPackage` 失败，runtime gate 失败，query capability
  count 变为 0。

## Post-Fix Blocking Issues

前次 Agent 3 关注但未阻断的问题中，CLI 非 JSON 输出测试本次已通过。

前次 Agent 1 提出的两个 runtime 阻断问题在 Agent 3 视角也已复核：

- 缺 `graphrag/runs/*.yaml` 时，`loadGraphQueryCapabilities()` 不再从 book
  state 派生 query capability。
- 包目录内出现 `provider-requests/payload.json` 时，package validator 与
  runtime gate 均 fail closed。

## Baseline Results

### direct_query_entrypoint: pass

CLI `auto` 与显式 `--graphrag` 路径都会恢复 managed settings projection，
再按选中单书解析 GraphRAG `dataDir`。`resolveBookGraphRagDataDir()` 从
`BOOK_MANIFEST.graphrag.outputManifestPath` 定位
`books/{bookId}/graphrag/output`，不依赖发送方绝对路径。

fresh-vault 单书复制验证证明，只复制一本书目录即可从包内 manifest 与
artifacts 重建 query capability。

### artifact_minimum_closure: pass

实现列出 GraphRAG 查询最低 artifact 集合，包含 output manifest、identity
map、artifact metadata、context、stats、5 个 graph extract parquet、
community reports parquet 与 LanceDB。manifest `files` 记录 bytes、sha256、
role、required 与 producerRunId；validator 检查 required files、sidecars、
source closure、artifact metadata 和 producer runs。

真实 vault 38/38 package validator 通过。

### artifact_gate_state_machine: partial

设计合同已定义 copied、candidate、validating、validated、mounted、
query_ready、visible_not_query_ready、quarantined、rolled_back 状态机。

实现已具备查询前 fail-closed gate：`validateHotplugRuntimeQueryGate()` 检查
manifest、publish marker、required artifacts、producer runs 与 forbidden
payload；`projectQueryReadyLineage()` 在 producer checkpoint、artifact kind、
book scope、stage/provider/content hash 不满足时返回 `null`，不会投影为可查询。

不足：runtime resolver 仍未把每次 gate 失败持久化为完整状态机 transition
record 或 quarantine record。失败以 stable diagnostic 和 capability 缺失表达，
观测面尚未完全覆盖合同状态机。

### producer_lineage_completeness: partial

实现校验 producer run、stage、bookId、status、content hash、stage
fingerprint、provider fingerprint、artifactIds，并将 graph_extract、
community_report、embed、query_ready 组合为 query-ready lineage。

不足：固定基准要求每个查询必需 artifact 均可追溯到 producer run、step、
input hash、tool version、schema version、生成时间和上游 artifact hash。当前
实现足以防止缺 runs、stage 改写、provider/hash 不匹配进入 query-ready，但
tool version、schema version 与上游 artifact hash 仍不是逐 artifact 强制门。

### lineage_artifact_binding: pass

manifest、artifact metadata、run evidence 与 state artifacts 之间有可验证绑定。
artifact metadata validator 检查 required artifact row、producerRunId、
fileSha256、bytes、producerRunIds 到 run artifactIds 的绑定和 closure digest。
catalog projection 只有在 producer runs 存在且 query-ready lineage 通过时才写
graph capability。

真实 catalog 中 30 个 capabilities 没有 stale book id。

### schema_runtime_compatibility: partial

设计合同区分 package schema、layout、qmd index schema、GraphRAG artifact
schema、producer lineage schema，并规定不兼容 fail closed。实现侧 managed
settings projection 固定 Responses endpoint、stream、strict structured
output、Jina profile、embedding dimensions 与 LanceDB vector size；artifact
validation 检查 parquet magic/row count 与 LanceDB 表、row count sidecar。

不足：parquet schema digest、LanceDB schema digest、embedding
model/dimension、output manifest schema 与 package schema 的交叉兼容仍未形成
统一 runtime compatibility gate。因此本项仍为 partial。

### query_scope_isolation: pass

查询 runtime `dataDir` 使用选中 book 的 package-local
`graphrag/output`。capability scope 传入 selectedBookIds、
graphCapabilityIds、sourceIds、documentIds、contentHashes、artifactIds。
artifact validation 要求 book-scoped graph output；scope filter 校验 bookId、
documentId、sourceId 与 identity map。

CLI 测试中 selected book scoped output 用例通过；fresh-vault 单书复制只产生
该书 capability。

### privacy_payload_exclusion: pass

package validator 与 runtime gate 均拒绝 `.env`、provider request/response、
logs/debug/trace、durable recovery 与 corrupt 文件。settings projection 使用
`${OPENAI_API_KEY}`、`${JINA_API_KEY}` 等 env 占位符，不写真实 secret。
python bridge early-stop 诊断会脱敏 provider payload、secret、Bearer token、
OpenAI key、URL 与绝对路径。

新增临时负例证明：包内加入 `provider-requests/payload.json` 后 validator
失败、runtime gate 失败、query capability count 变为 0。

### recovery_diagnostics: partial

实现已给出稳定诊断，包括 `manifest_not_query_ready`、
`missing_producer_run:*`、`missing_required_file:*`、
`forbidden_sensitive_material:*`、artifact validation reason。catalog projection
能在 stale/missing 投影时重建，且失败包不会投影 query capability。

不足：诊断尚未全部映射到状态机要求的 quarantine/rollback record 与 repair
entry。not query-ready 与 quarantined 的持久状态记录仍不完整。

### executable_contract_tests: pass

已有可执行测试覆盖：

- hotplug catalog rebuild 与 fresh projection
- provider payload 不可进入可分发包
- producer runs 缺失 fail closed
- artifact 缺失、stage 改写、kind 缺失、越界 artifact path fail closed
- selected book scoped GraphRAG CLI route
- fresh vault settings projection recovery
- python bridge provider slot fencing 与敏感信息脱敏

focused suite 本轮全部通过。

## Overall Result

`overall_result: partial`

修复后的实现已满足 runtime/query recovery 主路径，并修复前序阻断缺口：
缺 producer evidence 不会 query-ready，provider payload 进入包会 fail closed。

仍未给 full pass 的原因是固定基准中的高阶合同尚未完全落地：

- artifact gate 状态机缺完整持久 transition/quarantine/rollback 记录。
- per-artifact lineage 尚未强制覆盖 tool version、schema version 与上游
  artifact hash。
- schema/runtime compatibility gate 还没有完整交叉校验 schema digest、
  embedding dimension/model 与 output manifest schema。
