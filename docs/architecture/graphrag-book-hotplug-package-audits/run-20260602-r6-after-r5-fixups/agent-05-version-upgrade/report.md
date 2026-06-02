# agent-05-version-upgrade R6 固定基准设计审计报告

## scenario

旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema。审计对象为：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

主 Type DD 声明 R3 与 R5 fixup 文档均为规范性补充文档（normative
supplements）。本轮按三份 Type DD 的合并契约评估固定 10 维
`passCriteria`。

## reused_fixed_baseline

本轮复用固定 R6 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-05-version-upgrade/baseline.yaml`

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

- R6 `baseline.yaml` 在审计前已存在，本轮未新增、删除、重排、重命名任何
  baseline 维度。
- R6 `baseline.yaml` 未被覆盖或修改。
- R6 baseline 与 R5
  `run-20260602-r5-fixed-baseline-rerun/agent-05-version-upgrade/baseline.yaml`
  SHA-256 相同。
- R6 baseline 与 R4
  `run-20260602-r4-after-r3-fixups/agent-05-version-upgrade/baseline.yaml`
  SHA-256 相同。
- 复审范围限于三份 Type DD、固定 baseline 与公开审计报告文本；未读取
  provider payload、secrets、`.env`、凭据、日志 payload、recovery payload
  或私有运行数据。

## findings

### 1. `legacy_version_detection`：通过

主文档的 `upgradePathMatrix.legacyVersionDetection` 定义
`current_hotplug_v1`、`legacy_distribution_manifest_v1`、
`legacy_book_root_without_manifest`、`legacy_partial_qmd_only`、
`legacy_partial_graphrag_only`、`residue_duplicate_source`、
`unsupported_unknown` 与 `repairable_incomplete`，检测输入覆盖旧
`distribution_manifest.json`、checksum sidecar、`job.yaml`、`artifacts.yaml`、
`checkpoints.yaml`、`input/**`、qmd manifest、GraphRAG output manifest 与
runs evidence。

R3 `schemaVersionUpgradeMatrix` 将识别提升到 version-level，按
`packageSchemaVersion`、`layoutVersion`、`qmdIndexSchema`、
`graphRagArtifactSchema` 与 `producerLineageSchema` 区分 current、legacy、
qmd index v0、GraphRAG output v0、producer lineage missing 与 unsupported
legacy schema。R5 `migrationSourceTruthFailClosedTable` 进一步规定
`distribution_manifest.json`、manifest sidecar、canonical input、source
closure、artifact checksums 等关键证据缺失时的 fail-closed 分类。该组合满足
unknown、unsupported、repairable 与 current 的明确区分要求。

### 2. `migration_path_matrix`：通过

主文档提供 shape-level `upgradePathMatrix.pathRows`，为 current hotplug、
legacy distribution manifest、partial qmd、partial GraphRAG、duplicate
residue 与 unsupported unknown 定义迁移目标、前置条件、步骤和失败状态。
R3 `schemaVersionUpgradeMatrix.rows` 逐行覆盖 `hotplug_v1_current`、
`distribution_manifest_v1_to_hotplug_v1`、`qmd_index_schema_v0`、
`graphrag_output_schema_v0`、`producer_lineage_missing` 与
`unsupported_legacy_schema`，每行都有 outcome、requiredAction 与
failureOutcome。

R5 补充文档加强了迁移路径的源真值（source of truth）和重跑语义。
`migrationSourceTruthFailClosedTable` 明确哪些缺失证据禁止生成
`BOOK_MANIFEST.json`、`PUBLISH_READY.json` 或 manifest checksum sidecars。
`migrationRerunIdempotencyContract` 定义 already migrated、partial
migration、failed interrupted 与 legacy only 的重跑行为，防止重复移动、
覆盖用户元数据或改变已验证包身份。`migrationConflictDecisionTable` 规定
source-hash prefix conflict、target live root exists、staging mismatch、same
bookId different sourceHash 等冲突必须 fail closed 或进入人工决策记录。

### 3. `artifact_schema_conversion`：通过

主文档的 `artifactSchemaConversionMatrix` 明确 qmd build manifest、qmd book
index、GraphRAG output manifest、parquet tables、LanceDB、
reports/stats/context 与 producer runs 在跨 schema 升级时的处理动作：
兼容则保留，不兼容则重建、标记 visible-not-query-ready、要求 GraphRAG
rebuild，或作为 redacted lineage evidence 保留。

`graphRagArtifactMetadataContract` 要求每个 GraphRAG 必需 artifact 绑定
path、role、bytes、sha256、schemaVersion、schemaDigest、producerRunId、
producerStage 与 validation granularity。R5 `manifestFirstDirectQueryResolver`
要求 query-ready 从 manifest、artifact file entries、artifact metadata rows、
producer lineage summaries 与 schema compatibility 直接判定，catalog 仅为
cache。R5 `graphRagArtifactGateStateMachine` 覆盖 copied、candidate、
validating、validated、mounted、query_ready、visible_not_query_ready、
quarantined 与 rolled_back，明确转换后的 query-ready gate。

### 4. `identity_stability`：通过

R3 `identityFieldSemantics` 固定 bookId、sourceHash、packageVersion、
packageGeneration、canonicalTitle 与 titleSlug 的稳定性、生成来源、冲突角色和
可变性。主文档和 R3 replacement rules 要求 same bookId different sourceHash
fail closed，same sourceHash different bookId 进入 duplicate candidate 或人工
决策，title change 不作为身份冲突。

R3 `migrationEvidenceSchema` 要求记录 `sourceBookId`、`targetBookId`、
`sourceHash`、`oldNormalizedHash`、`newNormalizedHash`、`oldProducerRunIds`、
`newProducerRunIds`、old/new manifest path、old/new manifest SHA-256、
before/after package root、before/after artifact hashes、matrix row id、
conversion actions 与 producer provenance status。R5
`migrationRerunIdempotencyContract` 进一步禁止 rerun 改变已验证包身份，R5
`migrationConflictDecisionTable` 要求冲突决策记录 old/candidate manifest
digest 与 selected action。该组合防止关键身份字段在升级中被静默改变。

### 5. `checksum_reclosure`：通过

主文档要求迁移后重新生成 package-relative file entries、file bytes、
sha256、`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、checksum metadata
与 `PUBLISH_READY.json`。`atomicPackageLifecycle` 规定 manifest 与 sidecar 在
所有文件写入后提交，`checksumLastCommitRule` 要求 sidecar mismatch fail
closed。

`distributionManifestMigration` 明确旧 `distribution_manifest.json` 只作为
legacy evidence 保留到下一次成功 `BOOK_MANIFEST.json` audit，不能继续授权新包
挂载。R5 `migrationSourceTruthFailClosedTable` 明确 artifact file checksums
缺失时 `mayGenerateBookManifest: false`，迁移工具不得在 live root 生成新
manifest、publish marker 或 sidecar。新包挂载授权来自重建后的
package-relative 文件闭包（file closure）与 manifestSha256。

### 6. `rollback_atomicity`：通过

主文档定义 import/build staging root、atomic rename、publish marker、
last-good projection、mount scan transaction 与 `rollbackContract`。失败发生在
publish 前时删除 staging；publish 后 projection 前可移除新 live root 并恢复旧
root；projection 后可恢复 previous projection generation。mount scanner 只接受
通过 `BOOK_MANIFEST.json`、manifest sidecars 与 `PUBLISH_READY.json` 校验的
liveRoot。

R5 `importerPrePublishValidationContract` 要求 staged import 在 live-root rename
前完成 manifest schema、checksum、required file、path escape、package schema、
qmd schema、GraphRAG schema、identity conflict、sensitivity 与 producer
redaction 校验，失败时 liveRoot 不变。R5 `graphRagArtifactGateStateMachine`
要求 validation crash 或 commit failure 转入 rolled_back，并保持 last-good
generation。升级中目录、半迁移目录和失败 staging 不会被投影为 query-ready。

### 7. `compatibility_diagnostics`：通过

主文档 `upgradePathMatrix.compatibilityDiagnostics` 与 R3
`schemaVersionUpgradeMatrix.compatibilityDiagnostics` 覆盖
`missing_required_file`、`missing_source_closure`、
`missing_qmd_build_manifest`、`missing_graphrag_output_manifest`、
`missing_producer_lineage`、`rebuild_failed`、`tool_version_too_old`、
`unsupported_legacy_schema`、`unsupported_layout_version`、
`unsupported_qmd_index_schema`、`unsupported_graphrag_artifact_schema`、
`unsupported_producer_lineage_schema`、`artifact_schema_incompatible`、
`package_schema_incompatible` 与 `manual_decision_required`。

诊断保留位置由 `versionAndMigrationModel.migrationEvidence.root`、
`mountScanTransactionModel.scanState`、`quarantineAndRepairStateMachine.stateRoot`
和 external runtime state 覆盖。R5 增加 import 诊断、GraphRAG gate 诊断、
migration source truth 诊断、rerun 状态与 conflict decision 诊断，能表达不兼容、
缺失文件、旧 schema 未支持、需要重建、重建失败和工具版本不足等机器可读状态。

### 8. `producer_lineage_preservation`：通过

主文档要求 GraphRAG artifacts 与 producer run output hash 双向绑定，producer
runs 作为 redacted lineage evidence 保留，并禁止 raw provider request/response
进入包内 evidence。`artifactSchemaConversionMatrix.migrationToolEvidence` 要求
记录 migration tool version、时间、artifact class、action、input/output sha256、
rebuildRequired 与 failureCode，并明确不得伪造未实际运行 producer stage 的成功
记录。

R3 `migrationEvidenceSchema.producerProvenanceStatusValues` 提供
`preserved_verified`、`preserved_redacted`、`missing_marked_not_query_ready`、
`rebuilt_by_actual_producer_run` 与 `unavailable_repair_required`。R5
`migrationSourceTruthFailClosedTable` 要求 producer lineage 缺失时只能生成受限
manifest，并设置 producer provenance status 为 `missing_marked_not_query_ready`。
旧 run evidence、createdBy、artifact provenance、source provenance 与迁移工具
证据均可被保留或显式标记缺失，且不得伪造 producer 成功记录。

### 9. `privacy_preservation`：通过

主文档的 `securityExportPolicy`、`sensitiveMaterialTaxonomy` 与 R3
`providerSensitiveClassExtensions` 覆盖 provider payloads、provider caches、
reversible interactions、provider auth config、credential stores、runtime logs、
debug/trace、recovery payload 与 absolute/private local paths。R3
`scannerNoReadContracts` 明确 importer、mount scanner、compatibility checker、
migration scanner 与 query gate 的 mayRead/mustNotRead 边界。

R5 `manifestSensitivitySchema` 对 `BOOK_MANIFEST.json` 字段建立 public、
restricted、redacted、forbidden 分类，并要求 unknown fields fail closed。R5
`manifestFirstDirectQueryResolver` 禁止 direct query gate 读取 provider payload
roots、provider response logs、raw prompts、raw completions、secrets 和 absolute
local paths。升级扫描和导出不得读取或复制 provider payload、secrets、logs、
recovery payload 或本地凭据；旧包中若存在这些路径，只能排除、隔离或报告，不能
进入新 manifest 文件闭包。

### 10. `upgrade_testability`：通过

主文档定义模块边界：`book-upgrade-paths.mjs`、
`book-artifact-schema-conversion.mjs`、`book-package-migration.mjs`、
`book-qmd-rebuild-transaction.mjs`、`book-graphrag-artifact-metadata.mjs`、
`book-sensitive-material-policy.mjs`、`book-manual-conflict-decision.mjs` 与
`book-r3-fixup-contracts.mjs`。状态机覆盖 discovered、classified、staging、
files copied、manifest generated、checksums regenerated、validated、published、
mounted、repair required、migration failed 与 rolled back。

R3 `schemaVersionUpgradeMatrix.fixtureContracts` 明确 fixture 集合与每个 fixture
的 input tree shape、expected matrix row id、expected outcome、expected
diagnostics、expected migration evidence 和 expected rollback behavior。R5
`fixedBaselineTestContracts.migrationCleanup` 明确 source closure missing 禁止
manifest generation、producer runs missing marks not query ready、already
migrated verify-only、partial migration resumes、failed interrupted requires
decision、source-hash prefix conflict fail closed、target live root exists fail
closed 与 user metadata conflict prevents overwrite。结合 R5 GraphRAG query、
qmd index、安全隐私和并发测试契约，已可自动化验证 supported migration、
unsupported migration、checksum mismatch、rollback、rebuild qmd index、
GraphRAG schema incompatible 和 privacy exclusion。

## pass_fail

总体结论：通过（pass）。

R6 复用固定 10 维 baseline，未改变审计维度。三份 Type DD 的合并设计契约满足
旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema 的全部
`passCriteria`。

| baseline id | R6 结果 | 判定摘要 |
| --- | --- | --- |
| `legacy_version_detection` | 通过 | 旧 manifest、旧目录、qmd schema、GraphRAG schema 与 current/unknown/unsupported/repairable 状态已可区分。 |
| `migration_path_matrix` | 通过 | shape rows、version matrix、source truth fail-closed table、rerun idempotency 与 conflict decision table 覆盖目标、动作、失败状态和不可升级诊断。 |
| `artifact_schema_conversion` | 通过 | qmd、parquet、LanceDB、reports、stats、context 与 producer runs 均有转换、重建、失效或 gate 规则。 |
| `identity_stability` | 通过 | identity semantics、old/new migration evidence、rerun identity lock 与 conflict decision 记录覆盖关键身份字段。 |
| `checksum_reclosure` | 通过 | 新 file entries、bytes、sha256、manifestSha256 与 checksum metadata 重建闭包；旧 checksum 仅为 legacy evidence。 |
| `rollback_atomicity` | 通过 | staging、pre-publish validation、atomic publish、rollback 与 last-good projection 防止半迁移 query-ready。 |
| `compatibility_diagnostics` | 通过 | 缺文件、unsupported、rebuild failed、tool version too old、import failure、gate failure 与 conflict 均有稳定诊断。 |
| `producer_lineage_preservation` | 通过 | producer provenance status 显式区分 preserved、redacted、missing、rebuilt 和 unavailable，且禁止伪造成功记录。 |
| `privacy_preservation` | 通过 | provider payload、secrets、logs、recovery payload 与凭据受 no-read/no-export 和 manifest sensitivity 契约保护。 |
| `upgrade_testability` | 通过 | fixture contracts、状态机、模块边界和 R5 fixed baseline tests 足以支撑自动化验证。 |

## criteria_delta_from_previous_run

上一轮参照为：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-05-version-upgrade/report.md`

R5 与 R6 baseline SHA-256 相同，R6 未新增、删除、重排或重命名审计维度。R5
报告已判定 agent-05 的 10 个 baseline id 全部通过。本轮将 R5 fixup 文档作为
新的规范性补充纳入评估，结论无退化，并在若干维度上增加设计证据。

| baseline id | R5 结果 | R6 结果 | delta |
| --- | --- | --- | --- |
| `legacy_version_detection` | 通过 | 通过 | 无退化；R5 source truth table 进一步明确关键证据缺失时的分类与 fail-closed 行为。 |
| `migration_path_matrix` | 通过 | 通过 | 增强；R5 增加 source truth、rerun idempotency 与 conflict decision table。 |
| `artifact_schema_conversion` | 通过 | 通过 | 增强；R5 manifest-first resolver 与 GraphRAG artifact gate state machine 细化 query-ready 判定。 |
| `identity_stability` | 通过 | 通过 | 增强；R5 rerun contract 与 conflict decision table 防止已验证身份被重跑或 residue 替换。 |
| `checksum_reclosure` | 通过 | 通过 | 无退化；R5 明确 checksum/source evidence 缺失时不得生成 live-root manifest 与 sidecar。 |
| `rollback_atomicity` | 通过 | 通过 | 增强；R5 importer pre-publish validation 与 GraphRAG rolled_back transition 加强原子边界。 |
| `compatibility_diagnostics` | 通过 | 通过 | 增强；R5 增加 import、GraphRAG gate、migration evidence、rerun 与 conflict 诊断码。 |
| `producer_lineage_preservation` | 通过 | 通过 | 无退化；R5 producer lineage missing 限制 manifest 并保持 not query ready。 |
| `privacy_preservation` | 通过 | 通过 | 增强；R5 manifest sensitivity schema 与 direct query forbidden inputs 收紧 no-read/no-export 边界。 |
| `upgrade_testability` | 通过 | 通过 | 增强；R5 fixed baseline test contracts 将迁移清理、GraphRAG query、qmd、并发和隐私用例具体化。 |

## required_design_changes

无阻断性设计变更。

实现阶段必须把主 Type DD、R3 fixup 与 R5 fixup 作为同一规范集合执行，尤其是：

- `schemaVersionUpgradeMatrix`
- `migrationEvidenceSchema`
- `scannerNoReadContracts`
- `manifestSensitivitySchema`
- `importerPrePublishValidationContract`
- `graphRagArtifactGateStateMachine`
- `migrationSourceTruthFailClosedTable`
- `migrationRerunIdempotencyContract`
- `migrationConflictDecisionTable`
- `fixedBaselineTestContracts`

实现不得只依据主文档旧的 shape-level rows，也不得用旧
`distribution_manifest.json` checksum 授权新包挂载。

## residual_risks

- R6 只审查 Type DD 设计文本，未验证实现代码、真实迁移 fixture 或 CI 结果。
- 旧 schema 集合继续扩展时，`schemaVersionUpgradeMatrix.rows` 与 R5 source
  truth、rerun、conflict tables 必须同步增加；不得把新旧版本落入泛化 fallback
  后静默升级。
- `qmd_book_index_format` 仍是 open question；若 qmd SQLite 从可选投影变成默认
  包内 artifact，需要再次复审 freshness、checksum 和 repack 规则。
- 隐私边界已在设计层闭合，但实现中的 secret scan、diagnostics、repair、
  import validation 和 query gate 仍必须遵守 no-read policy，不能为排障读取 raw
  provider payload、secrets、日志 payload 或私有运行数据。
