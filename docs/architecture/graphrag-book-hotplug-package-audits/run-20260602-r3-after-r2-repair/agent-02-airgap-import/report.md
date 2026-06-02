# scenario

离线机器导入书包。接收机器只能获得
`graph_vault/books/{bookId}` 书包目录，不能访问 provider，也不能读取或
依赖原始 batch catalog。导入后必须仅凭 `BOOK_MANIFEST.json`、manifest
sidecar、publish marker 和包内文件完成校验、挂载投影、qmd 或 GraphRAG
query-ready 判定，以及必要的本地索引重建。

# reused_fixed_baseline

本轮 R3 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-02-airgap-import/baseline.yaml`

固定 10 维评估结果如下：

| id | name | R3 result |
| --- | --- | --- |
| AIG-01 | 离线闭包完整性 | 通过 |
| AIG-02 | 挂载权威唯一性 | 通过 |
| AIG-03 | 原始 batch catalog 独立性 | 通过 |
| AIG-04 | Provider 隔离 | 通过 |
| AIG-05 | 校验与失败关闭 | 通过 |
| AIG-06 | 路径可移植性 | 通过 |
| AIG-07 | 离线兼容性判定 | 通过 |
| AIG-08 | 查询就绪门槛 | 通过 |
| AIG-09 | 导入状态隔离 | 通过 |
| AIG-10 | 可实施流程与测试 | 通过 |

# baseline_integrity_check

R3 `baseline.yaml` 已按固定基线复用，未新增、删除、重排、重命名维度，
也未改变任何 `passCriteria`。本轮只写入 `report.md`，未覆盖
`baseline.yaml`。

- R3 baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-02-airgap-import/baseline.yaml`
- R2 baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-02-airgap-import/baseline.yaml`
- Original fixed baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/agent-02-airgap-import/baseline.yaml`
- Baseline SHA-256:
  `9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4`
- Baseline line count: 64
- Baseline dimension order:
  AIG-01, AIG-02, AIG-03, AIG-04, AIG-05, AIG-06, AIG-07, AIG-08,
  AIG-09, AIG-10
- R3 与 R2 airgap baseline 的 `diff -u` 结果为空。

# findings

## AIG-01 离线闭包完整性

结论：通过。

Type DD 将 `graph_vault/books/{bookId}` 定义为书包权威根目录，并通过
`packageRoot.completenessRule` 要求导入、校验、查询、导出和重挂载所需文件
全部位于包内。`targetDirectoryLayout.required` 固定
`BOOK_MANIFEST.json`、manifest checksum sidecars、`source/`、`input/`、
`qmd/`、`graphrag/output/`、`graphrag/runs/` 和脱敏后的 `state/`。

`bookManifestSchema.files` 要求每个必需文件记录 package-relative `path`、
`bytes`、`sha256`、`required`、`producerRunId` 和 `sensitivity`。qmd rebuild
输入闭包、GraphRAG 最低 artifact closure、producer lineage 与 artifact metadata
也被纳入包内校验边界。设计明确不得依赖 sibling source、global input、
provider 服务、provider payload 或原始 batch catalog。

## AIG-02 挂载权威唯一性

结论：通过。

`targetContract.packageAuthority` 明确
`graph_vault/books/{bookId}/BOOK_MANIFEST.json` 是 mounted book package 的
authoritative description。mount scanner 的 authoritative input 仅为
`graph_vault/books/*/BOOK_MANIFEST.json`，catalog、全局 qmd index 和 retrieval
index 均为 projection 或 cache。

`distributionManifestMigration.compatibilityBridge` 明确旧
`distribution_manifest.json` 只能作为 exportable legacy evidence，不能作为
hot-plug authoritative manifest。该设计满足离线导入只信任书包 manifest 的
唯一权威要求。

## AIG-03 原始 batch catalog 独立性

结论：通过。

R2 的主要缺口是 derived catalog 字段 schema 未固定。R3 Type DD 已新增
`catalogProjectionSchemas`，规定 derived catalog 只能从 `BOOK_MANIFEST.json`、
`PUBLISH_READY.json`、readiness gates 和 scan validation results 投影生成，
并将 `graph_vault/catalog/batch-runs/**`、provider roots、`graph_vault/input/**`
和 absolute source paths 列为 forbidden inputs。

`catalogProjectionSchemas` 已逐项定义 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和
`book-conflicts.yaml` 的 path、record key、字段来源、冲突索引和稳定排序规则。
其中 `document-identity-map.yaml` 从 qmd 或 GraphRAG manifest document identity、
`BOOK_MANIFEST.identity`、`BOOK_MANIFEST.input.normalizedHash` 和包内
`qmd_graph_text_unit_identity.json` 派生；`graph-capabilities.yaml` 从
readiness gate、artifact metadata、producer run ids 和 closure digest 派生。

实现者已可在无 provider、无原始 batch catalog 的空 vault 中，仅凭书包 manifest
和包内 artifact 重建 books、sources、document identity 与 graph capabilities
catalog。本维满足固定 passCriteria。

## AIG-04 Provider 隔离

结论：通过。

scope 已排除 provider 请求、provider 响应、密钥和日志 payload 的分发。
`securityExportPolicy` 采用 allowlist-first，并禁止
`provider-requests/**`、`provider-responses/**`、logs、debug、trace、secret、
credential、token 和 key 类路径进入包。`sensitiveMaterialTaxonomy` 进一步要求
import、mount scan、migration 和 query diagnostics 不读取 provider roots、
runtime payload roots 或 raw provider payload。

`producerEvidenceRedaction` 只允许 producer run id、stage、artifact hash、
model/embedding fingerprint、toolVersion 和 completedAt 等摘要字段。raw
prompts、provider headers、request bodies、response bodies 和 raw completions
为 forbidden fields。GraphRAG gate failure 只返回稳定诊断，不触发 provider
calls。provider 不可达不会降低已打包 GraphRAG 产物的 query-ready 判定。

## AIG-05 校验与失败关闭

结论：通过。

Type DD 定义 atomic publish、manifest-last-write、checksum-last-commit、
`PUBLISH_READY.json` 和 staging-to-live atomic rename。mount scanner 在投影
catalog 或 qmd index 前，按 validation pipeline 校验 manifest schema、
package-relative paths、required file presence、checksums、identity conflicts
和 schema compatibility。

失败策略覆盖 missing manifest、missing publish marker、missing required file、
checksum mismatch、path traversal、symlink escape、corrupt sidecar、
lineage binding missing 和 incompatible schema。失败包进入
`quarantine_mount_candidate`、`visible_not_query_ready`、`not_mounted` 或
`not_query_ready`，不会部分挂载为 query-ready。projection commit 使用 staging
root、checksum、fsync 和 current-generation pointer，失败时保留 last-good
projection。

## AIG-06 路径可移植性

结论：通过。

Type DD 要求 `BOOK_MANIFEST.json` 由 package-relative paths 生成，每个 required
package file 都必须位于 `graph_vault/books/{bookId}` 内。legacy absolute path、
外部 source path、`graph_vault/input` 和 batch run path 只能作为 provenance 或
compatibility metadata，不能参与离线定位。

`securityExportPolicy.pathSafety` 明确拒绝 absolute paths、parent traversal、
symlink escape 和 hardlink outside package。`catalogProjectionSchemas` 也禁止
absolute source paths 和旧全局 input roots 作为 projection input。该设计满足跨
机器复制、导入和重挂载的路径可移植性要求。

## AIG-07 离线兼容性判定

结论：通过。

manifest `compatibility` section 要求记录 `minQmdGraphRagVersion`、
`graphRagArtifactSchema`、`qmdIndexSchema` 和 `createdBy`。
`versionAndMigrationModel.compatibilityMatrix` 覆盖 package schema、layout
version、qmd index schema、GraphRAG artifact schema、parquet schema digest、
LanceDB schema digest 和 producer lineage schema。

`upgradePathMatrix` 和 `artifactSchemaConversionMatrix` 进一步固定 legacy package
shape、artifact class、precondition、conversion action、failure outcome 和
machine-readable diagnostics。离线 importer 可以用包内字段和本机工具链版本表
作出 `mount_as_is`、`migrate_metadata_only`、`rebuild_qmd_projection`、
`visible_not_query_ready`、`rebuild_graphrag_required` 或 `fail_closed` 决策，
无需联网或访问 provider。

## AIG-08 查询就绪门槛

结论：通过。

Type DD 区分 mounted、qmd-ready、GraphRAG-ready 和 query-ready。
`readinessGates.qmdReadyGate` 固定 included index、reindex required、
projection ready、projection failed 和 schema incompatible 等状态，并以
book identity、normalized hash、qmd build manifest、index schema、tool version、
embedding profile、chunking config hash 和 required artifacts 作为 freshness
inputs。缺少可本地重建的 qmd index 时，`qmdRebuildTransaction` 要求在
`graph_vault/catalog/qmd-book-projections/{bookId}` 外部投影并原子发布。

`readinessGates.graphragReadyGate` 与
`graphRagArtifactMetadataContract` 固定 GraphRAG 最低 artifact closure、metadata
row 必填字段、schema digest、validation granularity、producer lineage、upstream
hash binding、embedding dimension 和 query gate negative tests。query 命令必须
通过 committed mount projection 定位当前 package generation，并拒绝 stale 或
cross-book artifacts。

## AIG-09 导入状态隔离

结论：通过。

`externalRuntimeLayout` 将导入诊断、mount 状态、本地查询缓存和可写运行状态
放在 `graph_vault/.local/book-runtime/{bookId}`，将 mount scan generation 与
projection plan 放在 `graph_vault/catalog/mount-scans`，将 qmd projection 放在
`graph_vault/catalog/qmd-book-projections/{bookId}`。

`immutablePackagePolicy` 明确 shared packages 发布后默认 readonly。runtime writes、
local query caches、repair diagnostics 和 import state 不写入 package root。
包内 `state/` 只包含脱敏 final state snapshot；接收机器产生的本机状态被排除在
distributable package 和包校验闭包之外。

## AIG-10 可实施流程与测试

结论：通过。

Type DD 已给出足够具体的模块职责：manifest builder/validator、mount scanner、
lifecycle、readiness gates、security、migration、export、import、
catalog projection schema、quarantine repair、large-library scan、upgrade paths、
artifact schema conversion、lock lease cleanup、qmd rebuild transaction、
GraphRAG artifact metadata、sensitive material policy 和 manual conflict decision。

生命周期覆盖 staged import、direct directory copy、atomic publish、mount scan、
catalog projection commit、quarantine、repair、replacement、delete unmount 和
last-good projection preservation。测试合同覆盖空 vault 导入、删除卸载、
缺 `PUBLISH_READY.json`、scanner crash、partial projection、防 provider payload、
secret/path/symlink fail closed、身份冲突、qmd rebuild、GraphRAG artifact lineage、
derived catalog rebuild without batch run state、legacy migration、large library scan
和 manual conflict decision。实现者可以在无 provider、无原始 batch catalog 的
机器上实施和验证。

# pass_fail

总体结论：通过。

R3 Type DD 已满足 airgap import 固定 10 维基线。R2 中唯一未完全通过的
AIG-03 已通过 `catalogProjectionSchemas`、`graphRagArtifactMetadataContract` 和
相关测试合同补足。离线机器可以仅凭复制进来的书包目录完成校验、挂载投影、
query-ready 判定和可本地重建索引处理，不需要 provider，也不需要原始 batch
catalog。

# criteria_delta_from_r2

| id | R2 result | R3 result | delta |
| --- | --- | --- | --- |
| AIG-01 | 通过 | 通过 | 无变化。离线闭包要求继续满足。 |
| AIG-02 | 通过 | 通过 | 无变化。`BOOK_MANIFEST.json` 权威继续成立。 |
| AIG-03 | 部分通过 | 通过 | 新增 `catalogProjectionSchemas`，固定 derived catalog 字段、来源、forbidden inputs 和冲突索引规则。 |
| AIG-04 | 通过 | 通过 | 无变化；`sensitiveMaterialTaxonomy` 进一步强化 no provider read policy。 |
| AIG-05 | 通过 | 通过 | 无变化；quarantine/repair validator 细化 checksum 和错误码。 |
| AIG-06 | 通过 | 通过 | 无变化；catalog projection 也禁止 absolute source paths。 |
| AIG-07 | 通过 | 通过 | 无变化；upgrade path 和 artifact conversion matrix 细化离线兼容决策。 |
| AIG-08 | 通过 | 通过 | 无变化；GraphRAG artifact metadata contract 细化 query-ready 负例。 |
| AIG-09 | 通过 | 通过 | 无变化。本机 runtime 和 projection state 继续隔离在包外。 |
| AIG-10 | 通过 | 通过 | 无变化；测试合同新增 derived catalog rebuild without batch run state。 |

# required_design_changes

无阻塞性设计变更。

进入实现前建议补充以下非阻塞澄清项，避免不同实现产生兼容性偏差：

1. 为 `document-identity-map.yaml` 增加 `documentId` 的稳定算法名称和版本字段，
   使 qmd document id 与 GraphRAG document id 的冲突处理更可测试。
2. 为 `queryReady` 字段固定布尔值或枚举值映射，避免不同 projection writer 从
   `readinessGates.packageStates` 推导出不同表示。
3. 为 `sourceRedactionMode` 补默认值和允许值列表，明确 normalized-input-only
   包在导入后不能 rebuild source-derived artifacts。
4. 为 `diagnosticsDigest` 固定 digest 输入排序规则，增强 scan generation 的
   可复现性。

# residual_risks

1. `catalogProjectionSchemas` 已固定字段来源，但部分字段仍引用 readiness gate 或
   artifact metadata 的派生状态；实现时必须共享同一计算库，避免 writer 与 query
   reader 对状态解释不一致。
2. `qmd_graph_text_unit_identity.json` 已纳入最低闭包，但其内部 schema 仍依赖后续
   qmd/GraphRAG artifact metadata 实现细化；schema 漂移会影响 document identity
   projection。
3. source-redacted package 可以离线查询既有 qmd/GraphRAG 产物，但无法完整 rebuild
   source-derived artifacts；该行为需要在 CLI 诊断中明确暴露。
4. direct directory copy 依赖 publish marker 与 checksum 防止半复制挂载。发布后
   若本机进程修改包目录，只能由下一次 scan 或 audit 发现并 quarantine。
5. provider evidence 已脱敏到摘要级别；这足以支持 query-ready 判定，但可能不足以
   复现质量问题。深度调试需要单独的 redacted support bundle 合同。
