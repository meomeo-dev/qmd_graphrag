# agent-05-version-upgrade R5 固定基准复审报告

## scenario

旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema。复审对象为：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

`graphrag-book-hotplug-package-r3-fixups.type-dd.yaml` 已在主 Type DD 中声明为
规范性补充文档（normative supplement）。本轮按两份 Type DD 的合并契约判断。

## reused_fixed_baseline

本轮复用 R5 固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-05-version-upgrade/baseline.yaml`

baseline SHA-256：

`50eea87bc68cbd3bb809e56cecb4797e9b89bc47a0c50b16396fa879b585c8f8`

固定 10 维如下，顺序、名称与 `passCriteria` 均保持不变：

1. `legacy_version_detection`
2. `migration_path_matrix`
3. `artifact_schema_conversion`
4. `identity_stability`
5. `checksum_reclosure`
6. `rollback_atomicity`
7. `compatibility_diagnostics`
8. `producer_lineage_preservation`
9. `privacy_preservation`
10. `upgrade_testability`

## baseline_integrity_check

- R5 `baseline.yaml` 在复审前已存在，本轮未新增、删除、重排、重命名任何
  baseline 维度。
- R5 `baseline.yaml` 未被覆盖或修改。
- R5 baseline 与上一轮 R4
  `run-20260602-r4-after-r3-fixups/agent-05-version-upgrade/baseline.yaml`
  SHA-256 相同。
- R5 baseline SHA-256 为
  `50eea87bc68cbd3bb809e56cecb4797e9b89bc47a0c50b16396fa879b585c8f8`。
- 复审范围限于架构 Type DD、规范性补充 Type DD、固定 baseline 与公开审计
  报告文本；未读取 provider payload、secrets、`.env`、凭据、日志 payload、
  recovery payload 或私有运行数据。

## findings

### 1. `legacy_version_detection`：通过

主文档的 `upgradePathMatrix.legacyVersionDetection` 定义
`current_hotplug_v1`、`legacy_distribution_manifest_v1`、
`legacy_book_root_without_manifest`、`legacy_partial_qmd_only`、
`legacy_partial_graphrag_only`、`residue_duplicate_source`、
`unsupported_unknown` 与 `repairable_incomplete`，并列出旧
`distribution_manifest.json`、checksum sidecar、`job.yaml`、`artifacts.yaml`、
`checkpoints.yaml`、`input/**`、qmd manifest、GraphRAG output manifest 与
runs evidence 等检测输入。

R3 补充文档的 `schemaVersionUpgradeMatrix` 进一步按
`packageSchemaVersion`、`layoutVersion`、`qmdIndexSchema`、
`graphRagArtifactSchema` 与 `producerLineageSchema` 识别 current、legacy、
qmd index v0、GraphRAG output v0、producer lineage missing 与 unsupported
legacy schema。主文档的 `legacy_schema_unknown` 与补充文档的
`unsupported_legacy_schema`、`unsupported_layout_version`、
`unsupported_qmd_index_schema`、`unsupported_graphrag_artifact_schema` 等诊断码
共同满足 unknown、unsupported、repairable 与 current 的区分要求。

### 2. `migration_path_matrix`：通过

主文档提供 shape-level `upgradePathMatrix.pathRows`，为 current hotplug、
legacy distribution manifest、partial qmd、partial GraphRAG、duplicate
residue 与 unsupported unknown 定义目标、前置条件、步骤和失败状态。R3 补充
文档将该能力扩展为 version-level `schemaVersionUpgradeMatrix`，逐行覆盖
`hotplug_v1_current`、`distribution_manifest_v1_to_hotplug_v1`、
`qmd_index_schema_v0`、`graphrag_output_schema_v0`、
`producer_lineage_missing` 与 `unsupported_legacy_schema`。

每行都有明确 outcome、requiredAction 与 failureOutcome。不可升级场景通过
`unsupported_legacy_schema`、`unsupported_layout_version`、
`unsupported_qmd_index_schema`、`unsupported_graphrag_artifact_schema`、
`artifact_schema_incompatible` 与 `package_schema_incompatible` 等稳定诊断表达。
转换细节由主文档的 migration path rows、`artifactSchemaConversionMatrix`、
`qmdRebuildTransaction` 和 rollback contract 补足。

### 3. `artifact_schema_conversion`：通过

主文档的 `artifactSchemaConversionMatrix` 明确 qmd build manifest、qmd book
index、GraphRAG output manifest、parquet tables、LanceDB、reports/stats/context
与 producer runs 在跨 schema 升级时的动作：兼容则保留，不兼容则重建、标记
visible-not-query-ready、要求 GraphRAG rebuild，或作为 redacted lineage
evidence 保留。

`graphRagArtifactMetadataContract` 要求每个 GraphRAG 必需 artifact 绑定 path、
role、bytes、sha256、schemaVersion、schemaDigest、producerRunId、
producerStage 与 validation granularity。`readinessGates.graphragReadyGate`
和 R3 qmd availability policy 定义转换后的 qmd-ready 与 query-ready gate。

### 4. `identity_stability`：通过

R3 补充文档的 `identityFieldSemantics` 固定 bookId、sourceHash、
packageVersion、packageGeneration、canonicalTitle 与 titleSlug 的稳定性、生成
来源、冲突角色和可变性。主文档继续要求 same bookId different sourceHash
fail closed，same sourceHash different bookId 进入 duplicate candidate 或人工
决策，title change 不作为身份冲突。

R3 补充文档的 `migrationEvidenceSchema` 明确记录 `sourceBookId`、
`targetBookId`、`sourceHash`、`oldNormalizedHash`、`newNormalizedHash`、
`oldProducerRunIds`、`newProducerRunIds`、old/new manifest path、old/new
manifest SHA-256、before/after package root、before/after artifact hashes、
matrix row id、conversion actions 与 producer provenance status。该组合防止
bookId、sourceHash、canonicalTitle、normalizedHash 与 producerRunIds 在升级中被
静默改变。

### 5. `checksum_reclosure`：通过

主文档要求迁移后重新生成 package-relative file entries、file bytes、sha256、
`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、checksum metadata 与
`PUBLISH_READY.json`。`atomicPackageLifecycle` 规定 manifest 与 sidecar 在所有
文件写入后提交，`checksumLastCommitRule` 要求 sidecar mismatch fail closed。

`distributionManifestMigration` 明确旧 `distribution_manifest.json` 只作为 legacy
evidence 保留到下一次成功 `BOOK_MANIFEST.json` audit，不能继续授权新包挂载。
新包挂载授权来自新的 package-relative 文件闭包（closure）与 manifestSha256。

### 6. `rollback_atomicity`：通过

主文档定义 import/build staging root、atomic rename、publish marker、
last-good projection、mount scan transaction 与 `rollbackContract`。失败发生在
publish 前时删除 staging；publish 后 projection 前可移除新 live root 并恢复旧
root；projection 后可恢复 previous projection generation。

Mount scanner 只接受通过 `BOOK_MANIFEST.json`、manifest sidecars 与
`PUBLISH_READY.json` 校验的 liveRoot。升级中目录、半迁移目录和失败 staging 不会
进入 catalog 或 qmd projection，也不会被投影为 query-ready。

### 7. `compatibility_diagnostics`：通过

R3 补充文档补齐兼容诊断稳定码：`missing_required_file`、
`missing_source_closure`、`missing_qmd_build_manifest`、
`missing_graphrag_output_manifest`、`missing_producer_lineage`、
`rebuild_failed`、`tool_version_too_old`、`unsupported_legacy_schema`、
`unsupported_layout_version`、`unsupported_qmd_index_schema`、
`unsupported_graphrag_artifact_schema`、`unsupported_producer_lineage_schema`、
`artifact_schema_incompatible`、`package_schema_incompatible` 与
`manual_decision_required`。

保存位置由主文档的 `versionAndMigrationModel.migrationEvidence.root`、
`mountScanTransactionModel.scanState`、`quarantineAndRepairStateMachine.stateRoot`
和 external runtime state 共同覆盖。qmd 侧还有 R3 补充文档的
`qmdDiagnosticsSchema`，能表达 qmd index missing、schema incompatible、freshness
mismatch 与 rebuild failure。

### 8. `producer_lineage_preservation`：通过

主文档要求 GraphRAG artifacts 与 producer run output hash 双向绑定，producer
runs 作为 redacted lineage evidence 保留，并禁止 raw provider request/response
进入包内 evidence。`artifactSchemaConversionMatrix.migrationToolEvidence` 要求
记录 migration tool version、时间、artifact class、action、input/output sha256、
rebuildRequired 与 failureCode，并明确不得伪造未实际运行 producer stage 的成功
记录。

R3 补充文档的 `migrationEvidenceSchema.producerProvenanceStatusValues` 提供
`preserved_verified`、`preserved_redacted`、`missing_marked_not_query_ready`、
`rebuilt_by_actual_producer_run` 与 `unavailable_repair_required`。旧 run
evidence、createdBy、artifact provenance、source provenance 与 migration tool
evidence 均可被保留或显式标记缺失。

### 9. `privacy_preservation`：通过

主文档的 `sensitiveMaterialTaxonomy` 与 R3 补充文档的
`providerSensitiveClassExtensions` 覆盖 provider payloads、provider caches、
reversible interactions、provider auth config、credential stores、runtime logs、
debug/trace、recovery payload 与 absolute/private local paths。

R3 补充文档的 `scannerNoReadContracts` 明确 importer、mount scanner、
compatibility checker、migration scanner 与 query gate 的 mayRead/mustNotRead
边界。升级扫描和导出不得读取或复制 provider payload、secrets、logs、recovery
payload 或本地凭据；旧包中若存在这些路径，只能排除、隔离或报告，不能进入新
manifest 文件闭包。

### 10. `upgrade_testability`：通过

主文档定义模块边界：`book-upgrade-paths.mjs`、
`book-artifact-schema-conversion.mjs`、`book-package-migration.mjs`、
`book-qmd-rebuild-transaction.mjs`、`book-graphrag-artifact-metadata.mjs`、
`book-sensitive-material-policy.mjs` 与 `book-r3-fixup-contracts.mjs`。状态机覆盖
discovered、classified、staging、files copied、manifest generated、checksums
regenerated、validated、published、mounted、repair required、migration failed 与
rolled back。

R3 补充文档的 `schemaVersionUpgradeMatrix.fixtureContracts` 明确 fixture 集合与
每个 fixture 的 input tree shape、expected matrix row id、expected outcome、
expected diagnostics、expected migration evidence 和 expected rollback behavior。
结合主文档 damaged package tests、qmd rebuild tests、GraphRAG metadata negative
tests 与 sensitive material tests，已可自动化验证 supported migration、
unsupported migration、checksum mismatch、rollback、rebuild qmd index、
GraphRAG schema incompatible 与 privacy exclusion。

## pass_fail

总体结论：通过（pass）。

R5 复用固定 10 维 baseline，未改变审计维度。两份 Type DD 的合并设计契约满足
旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema 的全部
`passCriteria`。

| baseline id | R5 结果 | 判定摘要 |
| --- | --- | --- |
| `legacy_version_detection` | 通过 | 旧 manifest、旧目录、qmd schema、GraphRAG schema 与 current/unknown/unsupported/repairable 状态已可区分。 |
| `migration_path_matrix` | 通过 | 主文档 shape rows 加 R3 version matrix 覆盖目标、动作、失败状态与不可升级诊断。 |
| `artifact_schema_conversion` | 通过 | qmd、parquet、LanceDB、reports、stats、context 与 producer runs 均有转换或失效规则。 |
| `identity_stability` | 通过 | identity semantics 与 migration evidence 覆盖 normalizedHash 和 producerRunIds old/new 审计。 |
| `checksum_reclosure` | 通过 | 新 file entries、bytes、sha256、manifestSha256 与 checksum metadata 重建闭包。 |
| `rollback_atomicity` | 通过 | staging、atomic publish、rollback 与 last-good projection 防止半迁移 query-ready。 |
| `compatibility_diagnostics` | 通过 | 缺文件、unsupported、rebuild failed、tool version too old 等稳定诊断已补齐。 |
| `producer_lineage_preservation` | 通过 | producer provenance status 显式区分 preserved、redacted、missing、rebuilt 和 unavailable。 |
| `privacy_preservation` | 通过 | provider payload、secrets、logs、recovery payload 与凭据受 no-read/no-export 契约保护。 |
| `upgrade_testability` | 通过 | fixture contracts、状态机、模块边界和负例测试足以支撑自动化验证。 |

## criteria_delta_from_previous_run

上一轮参照为
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-05-version-upgrade/report.md`。
R4 与 R5 baseline SHA-256 相同，R5 未新增、删除、重排或重命名审计维度。

| baseline id | R4 结果 | R5 结果 | delta |
| --- | --- | --- | --- |
| `legacy_version_detection` | 通过 | 通过 | 无退化；版本识别矩阵和诊断区分保持满足。 |
| `migration_path_matrix` | 通过 | 通过 | 无退化；version-level matrix 继续覆盖目标、前置条件、动作与失败状态。 |
| `artifact_schema_conversion` | 通过 | 通过 | 无退化；artifact conversion 与 query-ready gate 保持闭合。 |
| `identity_stability` | 通过 | 通过 | 无退化；identity semantics 与 old/new evidence 仍覆盖关键身份字段。 |
| `checksum_reclosure` | 通过 | 通过 | 无退化；新 checksum 闭包继续作为唯一挂载授权。 |
| `rollback_atomicity` | 通过 | 通过 | 无退化；staging、atomic publish、rollback 与 last-good projection 保持有效。 |
| `compatibility_diagnostics` | 通过 | 通过 | 无退化；稳定诊断码和保留位置继续覆盖基准要求。 |
| `producer_lineage_preservation` | 通过 | 通过 | 无退化；producer provenance status 与 no fabricated success 规则保持满足。 |
| `privacy_preservation` | 通过 | 通过 | 无退化；no-read/no-export 边界继续覆盖 provider payload、凭据和运行 payload。 |
| `upgrade_testability` | 通过 | 通过 | 无退化；fixture contracts、模块边界、状态机和负例测试契约保持满足。 |

## required_design_changes

无阻断性设计变更。

后续实现必须把 R3 补充文档作为规范性契约落入校验器、迁移工具、fixture 和
CI 测试，尤其是 `schemaVersionUpgradeMatrix`、`migrationEvidenceSchema`、
`scannerNoReadContracts`、`qmdDiagnosticsSchema` 与
`compatibilityBridgeLifecycle`。实现不得只依据主文档旧的 shape-level rows。

## residual_risks

- R5 只审查 Type DD 设计文本，未验证实现代码、真实迁移 fixture 或 CI 结果。
- 旧 schema 集合继续扩展时，`schemaVersionUpgradeMatrix.rows` 必须同步增加；
  不得把新旧版本落入泛化 fallback 后静默升级。
- `qmd_book_index_format` 仍是 open question；若 qmd SQLite 从可选投影变成默认
  包内 artifact，需要再次复审 freshness、checksum 和 repack 规则。
- 隐私边界已在设计层闭合，但实现中的 secret scan、diagnostics 和 repair 工具
  仍必须遵守 no-read policy，不能为排障读取 raw provider payload。
- Producer evidence 的 redacted summary 必须保持 hash-bound 和 package-relative；
  过度脱敏会降低 lineage 可验证性。
