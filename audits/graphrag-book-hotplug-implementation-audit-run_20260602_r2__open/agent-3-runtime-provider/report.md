# Agent 3 Runtime Provider Implementation Audit

## Scope

本报告复用固定 baseline：

`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r2__open/agent-3-runtime-provider/baseline.yaml`

审计范围限定为 runtime/provider/settings 波动下的单书 hotplug GraphRAG
查询恢复（recovery）与 fail-closed 行为。未修改 baseline，未修改实现代码。

重点结论：

- GraphRAG CLI 查询前会重建 managed `settings.yaml` projection。
- Python bridge 会从项目 `.env` 注入 provider 环境变量。
- CLI 查询 `dataDir` 已解析到
  `books/{bookId}/graphrag/output`，并有测试验证。
- provider payload、secret、绝对路径输出有脱敏路径。
- 当前实现仍不是完全 manifest-first direct query resolver，且真实 38 包
  当前复核为 34/38 通过，4 包缺 artifact metadata 或 run binding。

## Commands

```text
npm exec -- tsc -p tsconfig.build.json --noEmit
```

结果：pass。

```text
npx vitest run test/unified-query.test.ts --testTimeout 120000
```

结果：36/36 pass。

```text
npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000
```

结果：1/1 pass。

```text
npx vitest run test/integrations/python-bridge-early-stop.test.ts \
  -t "projects provider env vars from project dotenv" --testTimeout 120000
```

结果：1/1 pass，验证 `.env` overlay 覆盖 parent env 并进入 bridge child。

```text
npx vitest run test/cli-graphrag-route.test.ts test/unified-query.test.ts \
  test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000
```

结果：本次复核在 180s 命令级 timeout；CLI 文件 8/9 已完成并通过，1 个
non-json format 测试触发 30s 测试超时并伴随临时目录清理 `ENOTEMPTY`。
已知验证记录显示该文件曾 9/9 通过，本次不作为功能失败定论，但作为
测试稳定性风险记录。

```text
validateBookHotplugPackage over graph_vault/books
```

结果：38 个 manifest 包中 34 个通过、4 个失败：

- `book-dc195f79ad5f-1f958234`:
  `artifact_metadata_missing_run_binding:query_ready-20260528070014-eh7etw`
- `book-e00b0ec0b4d3-6428a7fd`: `artifact_metadata_missing`
- `book-e0ce93c175e9-b6f165b1`: `artifact_metadata_missing`
- `book-f400d4105caa-76cd81ce`: `artifact_metadata_missing`

## Baseline Results

### direct_query_entrypoint

result: partial

证据：

- `src/cli/qmd.ts` 在 `autoQuerySearch()` 与 `graphRagQuerySearch()` 中调用
  `ensureGraphRagSettingsProjectionForCli()`，随后通过
  `resolveBookGraphRagDataDir()` 生成 query `dataDir`。
- `src/graphrag/book-package-layout.ts` 优先读取
  `BOOK_MANIFEST.json.graphrag.outputManifestPath`，否则使用
  `books/{bookId}/graphrag/output`。
- `test/cli-graphrag-route.test.ts` 验证 fake bridge 收到的 `request.dataDir`
  为 `books/book-cli/graphrag/output` 与
  `books/book-cli-second/graphrag/output`。

不足：

- 查询能力解析仍经 `loadGraphQueryCapabilities()`、
  `projectQueryReadyLineage()` 和 catalog/state 投影执行，不是完全仅凭
  `BOOK_MANIFEST.json` 与包内 artifact 的 manifest-first direct resolver。
- `resolveBookGraphRagDataDir()` 仍保留 legacy `books/{bookId}/output`
  fallback，适合迁移兼容，但不满足 strict hotplug-only 入口。

### artifact_minimum_closure

result: partial

证据：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml` 列出
  `graphrag/output/qmd_output_manifest.json`、identity、context、stats、
  parquet 表与 `lancedb` 等最低 artifact。
- `src/job-state/artifact-validation.ts` 校验 required kind、path containment、
  content hash、parquet header/footer、LanceDB row count、provider fingerprint、
  producer run id 和 corpus content hash。
- `scripts/graphrag/book-hotplug-package.mjs` 校验 manifest files、bytes、
  sha256、required artifact 和 `artifact-metadata.json`。

不足：

- 当前真实包复核 34/38 通过，4 包缺 `artifact-metadata.json` 或 run binding，
  说明实际 vault 中最低闭包尚未完全闭合。
- runtime capability gate 主要依赖 `state/artifacts.yaml` 与 checkpoints；
  `BOOK_MANIFEST.files` 和 `artifact-metadata.json` 尚未成为查询入口的唯一
  运行时闭包依据。

### artifact_gate_state_machine

result: partial

证据：

- 设计文档定义 copied、candidate、validated、mounted、query_ready、
  visible_not_query_ready、quarantined、rolled_back 等状态。
- `scripts/graphrag/book-hotplug-package.mjs` 的 `mountScanBookPackages()`
  对失败包输出 diagnostics 并不加入 mounted。
- `src/graphrag/book-hotplug-catalog.ts` 只有在 `PUBLISH_READY.json` 存在、
  manifest 可读、producer run evidence 完整、`projectQueryReadyLineage()`
  通过时才投影 capability。
- `test/cli-graphrag-route.test.ts` 的 missing stats 场景验证自动路由
  fail closed 到 qmd，不升级 GraphRAG。

不足：

- 当前实现没有完整持久化 state machine 记录，例如 copied/candidate/
  quarantined 的独立状态文件、稳定 quarantine 目录或 projection rollback
  记录。
- CLI 合并测试本次出现超时和临时目录清理 `ENOTEMPTY`，测试稳定性仍需修复。

### producer_lineage_completeness

result: partial

证据：

- `src/graphrag/capability-catalog.ts` 要求 graph_extract、
  community_report、embed 三类 producer checkpoint，并匹配 runId、
  stageFingerprint、providerFingerprint 与 corpus content hash。
- `src/graphrag/book-hotplug-catalog.ts` 读取 `graphrag/runs/*.yaml`，
  unreadable run evidence 会阻止 query-ready capability projection。
- `test/unified-query.test.ts` 覆盖缺 artifact kind、path outside vault、
  rewrite producer stage 等 fail-closed 场景。

不足：

- 真实包中存在 `artifact_metadata_missing_run_binding`，说明当前产物层
  producer lineage 对 required artifact 的绑定仍未完全一致。
- baseline 要求每个查询必需 artifact 可追溯到 producer run、step、
  input hash、tool version、schema version、生成时间和上游 artifact hash；
  当前运行时主要验证 run/stage/provider/content hash，未完整执行所有字段。

### lineage_artifact_binding

result: partial

证据：

- `src/job-state/artifact-validation.ts` 对 artifactId、bookId、kind、
  producerRunId、stageFingerprint、providerFingerprint、content hash 与
  vault-relative path 做绑定校验。
- `scripts/graphrag/book-hotplug-package.mjs` 生成并校验
  `graphrag/output/artifact-metadata.json`，要求 metadata row 与 producer
  run binding。
- `src/graphrag/book-hotplug-catalog.ts` 在 `graphrag/runs` 不可读或缺 runId
  时不投影 query-ready capability。

不足：

- 当前 4 个真实包未通过 package validator，直接证明 package file closure、
  producer evidence 和 artifact metadata 之间仍有缺口。
- runtime 查询 gate 尚未直接以 `BOOK_MANIFEST.files` 与
  `artifact-metadata.json` 的 cross-reference 作为唯一绑定依据。

### schema_runtime_compatibility

result: partial

证据：

- 设计文档区分 package layout、qmd index schema、GraphRAG artifact schema、
  producer lineage schema 和 compatibility matrix。
- `src/contracts/graphrag.ts` 明确 GraphRAG query request/response schema，
  且 `GraphRagEvidenceSchema.quote` 支持 nullable/optional，避免 provider
  evidence 缺 quote 导致误失败。
- `src/graphrag/settings-projection.ts` 投影 Jina embedding profile、
  dimensions、model、OpenAI Responses 参数和 LanceDB vector size。
- `test/unified-query.test.ts` 验证 malformed provider response 被转为 typed
  error。

不足：

- runtime gate 当前没有完整比较 `BOOK_MANIFEST.compatibility`、
  `artifact-metadata.schemaDigest`、LanceDB schema、embedding dimension 与
  parquet schema version 的统一兼容矩阵。
- package validator 能检查 artifact metadata 缺失，但真实 vault 中仍有
  4 个不兼容包未修复。

### query_scope_isolation

result: pass

证据：

- `src/cli/qmd.ts` 对多个 GraphRAG-ready book 的无 scope 查询返回
  `ambiguous_graph_book_scope`，需要 `--graph-book-id`。
- `test/cli-graphrag-route.test.ts` 覆盖多书未指定 book id 拒绝、指定
  `book-cli-second` 时 fake bridge `dataDir` 指向
  `books/book-cli-second/graphrag/output`。
- `src/graphrag/capability-catalog.ts` 的 artifact validation 要求 artifact
  `bookId` 匹配、路径在 vault 内，且 graph artifact 在
  `books/{bookId}/graphrag/output` 或 legacy-compatible base 下。
- `test/unified-query.test.ts` 验证不按 qmd collection path 混配 capability，
  且 path outside vault 被拒绝。

### privacy_payload_exclusion

result: partial

证据：

- `docs/architecture/graphrag-book-hotplug-package.README.md` 明确不得把
  provider payload、密钥、日志 payload、`.env` 或私人路径写入可分发书包。
- `scripts/graphrag/book-hotplug-package.mjs` 排除 `.env`、
  `provider-requests/**`、`provider-responses/**`、logs 与 recovery payload。
- `src/integrations/python-bridge.ts` 对 early-stop log evidence 做 provider
  payload、secret 和 absolute path 脱敏。
- `src/query/unified-answer.ts` 使用 `sanitizeVaultMetadata()` 清洗 GraphRAG
  evidence metadata。
- `test/cli-graphrag-route.test.ts` 验证 JSON 与多种非 JSON 输出不包含
  `workspace.graphVault`，且 fake bridge 的 `requestDataDir` 不出现在 answer
  metadata。

不足：

- Python bridge 子进程 registry record 会保存 provider slot id、provider
  name 和 fencing token；它不在书包 allowlist 中，但属于 runtime state，
  后续应确保 import/export scanner 永不包含该目录。
- 本轮未执行完整 secret scan/export package 测试；只能依据代码和 package
  validator 进行审计。

### recovery_diagnostics

result: partial

证据：

- `src/graphrag/settings-projection.ts` 对缺失 managed `settings.yaml` 会创建，
  对 stale managed projection 会重写；非 managed settings 会抛
  `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`。
- `test/cli-graphrag-route.test.ts` 验证 fresh vault 缺 `settings.yaml` 时
  `qmd query --graphrag` 会重建 settings sidecar。
- `src/graphrag/book-hotplug-catalog.ts` 对 unreadable producer run evidence
  采取不投影 query-ready capability 的 fail-closed 行为。
- `scripts/graphrag/book-hotplug-package.mjs` 输出稳定 diagnostics，如
  `missing_manifest_sidecar`、`file_sha256_mismatch:*`、
  `artifact_metadata_missing`。

不足：

- 当前没有把所有 gate failure 统一投影到稳定用户可见 mount/quarantine
  report；真实 4 包失败只能通过 validator 命令发现。
- CLI 合并测试本次 timeout 暴露测试恢复和临时目录清理不稳定。

### executable_contract_tests

result: partial

证据：

- 已有可执行测试覆盖：
  - `test/cli-graphrag-route.test.ts`：GraphRAG CLI route、`dataDir`、
    settings projection、多书 scope、输出脱敏。
  - `test/unified-query.test.ts`：capability derivation、artifact 缺失、
    outside vault、provider response invalid、runtime failure typed error。
  - `test/graphrag-book-hotplug-catalog.test.ts`：从 `BOOK_MANIFEST` package
    重建 graph capability catalog。
  - `test/integrations/python-bridge-early-stop.test.ts`：project `.env`
    overlay 进入 Python bridge child。

不足：

- 缺少完整 fresh-vault 单书 copy 后删除全局 catalog 仍可直接 GraphRAG 查询的
  manifest-first 测试。
- 缺少 artifact 替换、artifact metadata schemaDigest 不兼容、provider root
  在书包内被 scanner 拒绝、export secret scan 失败等端到端测试。
- 当前 CLI 聚合复核存在 30s timeout 风险。

## Overall Result

overall_result: partial

runtime/provider/settings 恢复主路径已具备可执行证据：CLI 查询前重建
managed settings，Python bridge 能读取项目 `.env` overlay，query `dataDir`
指向 `books/{bookId}/graphrag/output`，GraphRAG answer 输出经过 vault
metadata 脱敏，GraphRAG provider 异常转为 typed error。

未达到完全通过的原因：

1. 直接查询入口仍依赖 catalog/state 投影，不是完全 manifest-first。
2. 当前真实 `graph_vault/books` 包校验为 34/38，不是全部通过。
3. producer lineage 与 artifact metadata 的字段完整性尚未完全覆盖
   baseline 要求。
4. CLI 聚合测试本轮复核存在超时和临时目录清理不稳定。

## Recommended Next Actions

1. 修复 4 个真实包的 `artifact-metadata.json` 与 run binding，再重新执行
   38 包 validator，目标 38/38。
2. 增加 manifest-first direct query resolver，使缺失或 stale global catalog
   时仍由 `BOOK_MANIFEST.json`、`artifact-metadata.json`、`graphrag/runs`
   和包内 artifact 决定 query readiness。
3. 将 `BOOK_MANIFEST.files`、`artifact-metadata.json`、producer run evidence
   的 cross-reference 纳入 runtime query gate，而不仅是 packaging validator。
4. 增补 fresh-vault 单书复制、catalog 删除、artifact 替换、schemaDigest
   不兼容、provider root 拒绝、secret scan fail-closed 的端到端测试。
5. 调查 `test/cli-graphrag-route.test.ts` non-json format 测试超时和
   `ENOTEMPTY` 清理问题，避免审计复核受环境波动影响。
