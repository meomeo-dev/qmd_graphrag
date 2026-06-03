# Implementation Audit Agent 3 Report

## Scope

审计身份：`agent-3-runtime-provider`。

审计场景：runtime/provider/settings 波动下，单书 hotplug GraphRAG
查询是否能从包内证据恢复并 fail closed。

固定基准：
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-3-runtime-provider/baseline.yaml`。

本报告只读实现、设计合同和真实 vault 状态；未修改代码、真实
`graph_vault` 数据或 baseline。

重点文件：

- `src/cli/qmd.ts`
- `src/graphrag/book-package-layout.ts`
- `src/graphrag/capability-catalog.ts`
- `src/graphrag/book-hotplug-catalog.ts`
- `src/graphrag/settings-projection.ts`
- `scripts/graphrag/book-hotplug-package.mjs`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs`
- `scripts/graphrag/book-hotplug-quality-gate.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/integrations/python-bridge.ts`
- `src/query/unified-router.ts`
- `test/cli-graphrag-route.test.ts`
- `test/unified-query.test.ts`
- `test/graphrag-book-hotplug-catalog.test.ts`
- `test/integrations/python-bridge-early-stop.test.ts`

## Commands

```bash
sed -n '1,220p' \
  audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-3-runtime-provider/baseline.yaml
```

结果：读取固定 10 维 baseline，未修改。

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
```

结果：通过。

```bash
npx vitest run \
  test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000
```

结果：5/5 通过。覆盖 stale catalog rebuild、residue quarantine、
source-closure fail closed、quality gate 不进入 package closure 等场景。

```bash
npx vitest run \
  test/unified-query.test.ts \
  --testTimeout 120000
```

结果：36/36 通过。覆盖 query-ready capability 推导、artifact 缺失、
producer stage 被改写、越界 artifact path、identity mismatch 等场景。

```bash
npx vitest run \
  test/integrations/python-bridge-early-stop.test.ts \
  --testTimeout 120000
```

结果：7/7 通过。覆盖 provider slot fencing、dotenv provider env
projection、early-stop、日志证据脱敏、绝对路径和 provider payload 脱敏。

```bash
npx vitest run \
  test/cli-graphrag-route.test.ts \
  --testTimeout 120000
```

结果：8/9 通过；`qmd query --graphrag non-json formats project unified
evidence` 在测试自身 30000ms 上限超时。其余 CLI 用例通过，包括 JSON
GraphRAG 查询、auto upgrade、artifact missing 降级、multiple books fail
closed、selected book scoped output、fresh vault settings projection recovery。

```bash
node --input-type=module <real-vault-package-validation>
```

结果：真实 vault 中 `BOOK_MANIFEST` 包 `38/38` 通过
`validateBookHotplugPackage`。

```bash
node --input-type=module <real-vault-readonly-status-check>
```

结果：

- `graph_vault/books` 目录：72
- `BOOK_MANIFEST.json`：38
- `PUBLISH_READY.json`：38
- `graphrag/output/artifact-metadata.json`：38
- `state/hotplug-quality-gate.json` passed 且
  `copyDistributionAllowed=true`：38
- manifest `graphrag.queryReady=true`：30
- catalog：38 books、38 identities、30 graph capabilities
- stale capability book id：0

```bash
node --input-type=module <fresh-vault-copy-one-book-check>
```

结果：复制单本
`book-00474fb29e5e-59d02d41` 到临时 fresh vault 后重建 catalog，
得到 `bookCount=1`、`identityCount=1`、`capabilityCount=1`。
该 capability 为
`book-00474fb29e5e-59d02d41:graph_query`，`ready=true`，
artifact id 数为 9。

## Baseline Results

### direct_query_entrypoint: pass

CLI GraphRAG 查询入口在 `auto` 与显式 `--graphrag` 路径都会先恢复
settings projection，再通过选中的单本书解析 `dataDir`：
`src/cli/qmd.ts:3275-3335`、`src/cli/qmd.ts:3365-3445`。
`resolveBookGraphRagDataDir` 优先读取
`BOOK_MANIFEST.graphrag.outputManifestPath`，解析到
`books/{bookId}/graphrag/output`：
`src/graphrag/book-package-layout.ts:34-49`。

fresh vault 单书复制验证证明：只有一本书目录被复制时，系统可从
manifest/package-local artifacts 重建 1 个可查询 capability。全局 catalog
是可重建投影，不是单书包权威状态。

### artifact_minimum_closure: pass

实现列出了 GraphRAG 查询最低 artifact 集合：
`scripts/graphrag/book-hotplug-package.mjs:39-52`，包含
`qmd_output_manifest.json`、`qmd_graph_text_unit_identity.json`、
`artifact-metadata.json`、`context.json`、`stats.json`、5 个 parquet 文件、
`community_reports.parquet` 与 `lancedb`。

manifest 生成包含 `files` 闭包、bytes、sha256、required、role 与
producerRunId：
`scripts/graphrag/book-hotplug-package.mjs:360-390`、
`scripts/graphrag/book-hotplug-package.mjs:588-597`。
package validator 检查 manifest sidecar、publish marker、source closure、
required files 和 artifact metadata：
`scripts/graphrag/book-hotplug-package.mjs:672-735`。

真实 vault 验证结果为 `38/38` package validator 通过。

### artifact_gate_state_machine: partial

设计合同完整定义了 copied、candidate、validating、validated、mounted、
query_ready、visible_not_query_ready、quarantined、rolled_back 状态及转移：
`docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990-1097`。

实现层面已有核心 gate：`projectQueryReadyLineage` 在 producer checkpoint、
artifact kind、book scope、provider fingerprint、stage fingerprint、content
hash 不满足时返回 `null`，不会投影 query-ready：
`src/graphrag/capability-catalog.ts:437-545`。quality gate 也接入书籍创建：
`scripts/graphrag/batch-epub-workflow.mjs:10120-10163`。

不足：runtime resolver 尚未把每个查询 gate 失败显式记录为上述状态机的
稳定 transition/diagnostic/quarantine record。多数失败通过 capability
缺失或 projection 过滤 fail closed，但状态机观测面仍不完整。

### producer_lineage_completeness: partial

实现校验 producer lineage 的关键字段：bookId、stage、status、runId、
contentHash、stageFingerprint、providerFingerprint、artifactIds，并按
graph_extract、community_report、embed、query_ready 组合验证：
`src/graphrag/capability-catalog.ts:262-329`、
`src/graphrag/capability-catalog.ts:485-545`。

artifact metadata 也记录 artifactId、stage、kind、path、contentHash、
fileSha256、bytes、producerRunId、stageFingerprint、providerFingerprint、
corpusContentHash、createdAt：
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:94-147`。

不足：baseline 要求每个查询必需 artifact 追溯到 producer run、step、
input hash、tool version、schema version、生成时间和上游 artifact hash。
当前实现足以验证 producer/stage/hash/provider 绑定并 fail closed，但
tool version 与上游 artifact hash 并未对每个 required artifact 形成统一
强制校验。

### lineage_artifact_binding: pass

manifest 生成会从 graph output manifest 与 distribution manifest 收集
producerRunIds，并把 GraphRAG output 文件绑定到对应 producer run：
`scripts/graphrag/book-hotplug-package.mjs:393-418`、
`scripts/graphrag/book-hotplug-package.mjs:588-595`。

artifact metadata validator 检查 required artifact row、producerRunId、
fileSha256、bytes、producerRunIds 到 run artifactIds 的绑定，以及
closureDigest：
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:158-225`。

catalog projection 只在 producer runs 存在且 `projectQueryReadyLineage`
通过时生成 graph capability：
`src/graphrag/book-hotplug-catalog.ts:320-354`。真实 vault 38 个包均通过
package validator；catalog 中 30 个 query-ready capability 无 stale book id。

### schema_runtime_compatibility: partial

设计合同区分 package schema、layout、qmdIndexSchema、GraphRAG artifact
schema、producer lineage schema，并要求不兼容时 fail closed：
`docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:76-176`。

实现包含 runtime settings projection，固定 Responses endpoint、stream、
strict structured output、Jina profile、embedding dimensions 与 LanceDB
vector size：
`src/graphrag/settings-projection.ts:82-210`。artifact validation 检查
parquet magic/row count 与 LanceDB 必需表、row count sidecar：
`src/job-state/artifact-validation.ts:23-46`、
`src/job-state/artifact-validation.ts:122-239`、
`src/job-state/artifact-validation.ts:246-273`。

不足：实现主要验证 artifact 可读性、row count、stage/provider/content hash。
对完整 parquet schema digest、LanceDB schema digest、embedding model/dimension
与 output manifest schema 的交叉兼容校验仍不够显式。

### query_scope_isolation: pass

查询 runtime `dataDir` 使用选中 book 的 package-local
`graphrag/output`：
`src/cli/qmd.ts:3327-3345`、`src/cli/qmd.ts:3437-3455`。
capability scope 同时传入 selectedBookIds、graphCapabilityIds、sourceIds、
documentIds、contentHashes、artifactIds。

artifact validation 要求 book-scoped graph output：
`src/graphrag/capability-catalog.ts:532-544`。scope filter 校验 bookId、
documentId、sourceId 与 identity map：
`src/graphrag/capability-catalog.ts:589-658`。

CLI 测试 `qmd query --graphrag uses the selected book scoped output` 通过，
fresh vault 单书复制验证也只产生该书 capability。

### privacy_payload_exclusion: pass

包构建排除 `.env`、provider request/response、logs、debug、trace、
durable recovery 与 corrupt 文件：
`scripts/graphrag/book-hotplug-package.mjs:26-37`。
manifest exclusions 同步声明这些模式：
`scripts/graphrag/book-hotplug-package.mjs:599-609`。

settings projection 只写 `${OPENAI_API_KEY}`、`${JINA_API_KEY}` 等 env
占位符，不写真实 secret：
`src/graphrag/settings-projection.ts:135-187`。

python bridge early-stop 诊断会脱敏 provider payload、secret、Bearer token、
OpenAI key、URL 和绝对路径：
`src/integrations/python-bridge.ts:198-235`。对应测试 7/7 通过。

### recovery_diagnostics: partial

实现已有多类 fail-closed 与诊断：

- ambiguous graph scope 返回 typed query error：
  `src/cli/qmd.ts:3311-3326`、`src/cli/qmd.ts:3420-3435`。
- capability catalog 读取失败会转 typed query error：
  `src/query/unified-router.ts:402-420`。
- provider transient error 分类存在：
  `src/query/unified-router.ts:311-364`。
- quality gate 在 pre-publish 与 post-publish 失败时写入诊断并阻止发布：
  `scripts/graphrag/batch-epub-workflow.mjs:10120-10163`。

不足：artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容在 runtime
query path 中主要表现为 capability 被过滤或通用 capability missing，
还未统一暴露稳定 per-book/per-artifact 诊断、repair entry、quarantine
record 与 projection rollback record。

### executable_contract_tests: partial

已验证的测试覆盖面较强：

- `test/unified-query.test.ts`：36/36 通过，覆盖 query-ready capability、
  artifact 缺失、artifact stage 改写、artifact path 越界、identity mismatch。
- `test/graphrag-book-hotplug-catalog.test.ts`：5/5 通过，覆盖 stale catalog
  rebuild、residue quarantine、source closure fail closed、quality gate closure。
- `test/integrations/python-bridge-early-stop.test.ts`：7/7 通过，覆盖
  provider env projection、subprocess fencing、payload/secret/path 脱敏。
- `test/cli-graphrag-route.test.ts`：8/9 通过，覆盖 JSON GraphRAG 查询、
  auto upgrade、artifact missing 降级、ambiguous multi-book fail closed、
  selected book scoped output、fresh vault settings projection recovery。

不足：本次复核中 `test/cli-graphrag-route.test.ts` 的非 JSON 输出投影用例
仍在 30000ms 内置上限超时。另有部分 final contract 要求的测试场景尚未
完全自动化为独立断言，例如 catalog projection deleted 的 CLI 级直接查询、
artifact metadata row 缺失的稳定诊断、schema incompatibility 的显式
visible_not_query_ready 诊断、query gate 不读取 provider roots 的专门断言。

## Overall Result

`overall_result: partial`

核心 runtime/provider/query recovery 主路径已经成立：

- GraphRAG CLI 查询使用 package-local `graphrag/output`。
- fresh vault 复制单书后可重建 capability。
- settings projection 可恢复。
- provider payload、secret、日志 payload 与绝对路径不进入可分发包或用户输出。
- artifact/producer lineage gate 能阻止坏包或坏 projection 被误投影为
  query-ready。
- 真实 vault 38 个 package validator 与 38 个 quality gate 均通过。

未判定为 full pass 的原因：

- runtime 查询失败诊断和显式 artifact gate state-machine 观测面仍不完整。
- producer lineage 与 schema/runtime compatibility 的强制字段还未达到
  final contract 的最细粒度。
- 本次复核中 CLI 非 JSON evidence 投影测试仍有 30000ms 超时，说明
  executable contract tests 稳定性不足。

## Residual Risks

1. CLI 非 JSON 输出测试超时可能掩盖格式化路径中的性能退化或资源释放问题。
   建议拆分 markdown/csv/xml/files 子用例，降低单测试内多次 CLI 启动的
   资源竞争，并保留对绝对路径泄漏的断言。

2. 对 schema/runtime compatibility 的实现仍偏 artifact 可读性检查。建议补充
   output manifest schema、parquet schema digest、LanceDB schema digest、
   embedding model/dimension 与 package layout schema 的统一兼容 gate。

3. runtime query gate 失败时建议写入或返回稳定 diagnostics code，包括
   `artifact_missing`、`artifact_checksum_failed`、`lineage_missing`、
   `schema_incompatible`、`producer_evidence_missing`，并映射到
   `visible_not_query_ready` 或 `quarantined`。

4. producer lineage 建议补齐每个 required artifact 的 tool version、
   input hash 与 upstream artifact hash 强制校验，避免只凭 runId 和
   fingerprint 通过。

5. 建议增加 CLI 级 fresh-vault 测试：删除 catalog projection 后直接查询
   单书包，并确认不会读取 provider payload roots。
