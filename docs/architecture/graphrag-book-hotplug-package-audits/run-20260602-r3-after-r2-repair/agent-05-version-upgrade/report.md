# agent-05-version-upgrade R3 复审报告

## scenario

旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema。复审对象为
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`，重点验证
修订后的 Type DD 是否能把旧 `distribution_manifest.json`、旧目录布局、
旧 qmd index schema 与旧 GraphRAG artifact schema 升级为以
`BOOK_MANIFEST.json` 为挂载权威的新热插拔包。

## reused_fixed_baseline

本轮复审复用 R3 输出目录中已存在的固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-05-version-upgrade/baseline.yaml`

baseline SHA-256：

`50eea87bc68cbd3bb809e56cecb4797e9b89bc47a0c50b16396fa879b585c8f8`

固定 10 维如下，未新增、删除、重排或重命名维度，未改变
`passCriteria`：

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

R3 目录中的 `baseline.yaml` 在复审前已存在，本报告未覆盖该文件。该
baseline 与 R2 `agent-05-version-upgrade/baseline.yaml` 的 SHA-256 相同，
字节级比较无差异。

复审只读取架构文档、固定 baseline 与 R2 复审报告，未读取 provider payload、
secrets、日志 payload、recovery payload 或本地凭据。

## findings

### 1. `legacy_version_detection`：部分通过

Type DD 已新增 `upgradePathMatrix.legacyVersionDetection`，列出
`current_hotplug_v1`、`legacy_distribution_manifest_v1`、
`legacy_book_root_without_manifest`、`legacy_partial_qmd_only`、
`legacy_partial_graphrag_only`、`residue_duplicate_source`、
`unsupported_unknown` 与 `repairable_incomplete`，并指定
`distribution_manifest.json`、sidecar、`qmd/qmd_build_manifest.json`、
`output/qmd_output_manifest.json` 与 `runs/*.yaml` 等检测输入。结合
`compatibilityMatrix` 与 `artifactSchemaConversionMatrix`，设计已能识别
旧目录形态、旧 distribution manifest、qmd index schema 与 GraphRAG artifact
schema 的关键兼容输入。

剩余缺口是 `unsupported_unknown` 把 unknown 与 unsupported 合并为一个
分类状态。baseline 要求明确区分 `unknown`、`unsupported`、`repairable` 与
`current`。当前文档在诊断码中有 `legacy_schema_unknown` 与
`fail_closed_unsupported`，但分类状态本身仍未完全分离。

### 2. `migration_path_matrix`：部分通过

Type DD 已新增 `upgradePathMatrix.pathRows`，覆盖 current hotplug、legacy
distribution manifest、partial qmd、partial GraphRAG、duplicate residue 与
unsupported unknown，并为每行给出目标、前置条件、步骤和失败结果。该修订使
R2 中“只有维度、没有路径行”的主要缺陷得到实质改善。

剩余缺口是矩阵仍按 legacy package shape 组织，而不是按每个受支持的旧
`packageSchemaVersion`、`layoutVersion`、`qmdIndexSchema` 与
`graphRagArtifactSchema` 展开。`legacy_book_root_without_manifest` 与
`repairable_incomplete` 出现在检测状态中，但没有独立 path row。因此实现者仍
不能仅凭矩阵判断每个旧 schema version 的确定迁移路径。

### 3. `artifact_schema_conversion`：通过

Type DD 新增 `artifactSchemaConversionMatrix`，为 `qmd_build_manifest`、
`qmd_book_index`、`graph_output_manifest`、parquet tables、LanceDB、
reports/stats/context 与 producer runs 定义 preserve、rebuild、
visible-not-query-ready 或 lineage evidence 动作。`graphRagArtifactMetadataContract`
进一步要求每个 GraphRAG artifact metadata row 绑定路径、role、schema、
checksum、producer lineage 与 validation granularity，并将 parquet schema
digest、LanceDB schema digest、embedding dimension 与 package layout 纳入
query gate。

该维度满足 baseline：旧 artifact 不再被静默解释，跨 schema 升级时每类 qmd 与
GraphRAG artifact 都有明确保留、重建、失效或非 query-ready 规则。

### 4. `identity_stability`：部分通过

Type DD 保留 `identity.bookId`、`identity.sourceHash`、
`identity.canonicalTitle`、`input.normalizedHash` 与 producer lineage 绑定，并
新增 `identityMigrationRecord`，记录 old/new bookId、identity algorithm、title
before/after、package version before/after、decision reason 与 decidedBy。
`manualConflictDecisionWorkflow` 也要求同 bookId 不同 sourceHash、同 sourceHash
不同 bookId 与 residue promotion 进入显式人工决策。

剩余缺口是 identity migration record 没有覆盖 baseline 指定的全部字段语义：
`sourceHash` 不是 old/new 成对记录，`normalizedHash` 未记录，`producerRunIds`
也未记录旧值、新值与冲突策略。若旧规范化算法或旧 producer lineage 发生变化，
仍存在 identity 语义漂移未被完整审计的风险。

### 5. `checksum_reclosure`：通过

Type DD 要求迁移后重新生成 package-relative file entries、file checksums、
`BOOK_MANIFEST.json`、manifest checksum sidecars 与 `PUBLISH_READY.json`。
`atomicPackageLifecycle` 将 sidecar 与 publish marker 作为挂载可见性条件，
`distributionManifestMigration` 明确旧 `distribution_manifest.json` 仅作为
legacy evidence 保留到下一次成功 `BOOK_MANIFEST.json` audit。

该维度满足 baseline：新包挂载授权来自新的 manifest、file entries、checksum
metadata 与 publish marker，旧 checksum 不再授权新包挂载。

### 6. `rollback_atomicity`：通过

Type DD 定义 import/build staging roots、publish marker、checksum-last commit、
atomic rename、scanner visibility rule、last-good projection 与
`rollbackContract`。升级失败时可删除 staging、恢复旧 live root，或恢复 previous
projection generation；scanner 忽略缺少有效 manifest sidecars 与 publish marker
的升级中目录。

该维度满足 baseline：半迁移状态不会被投影为 query-ready，失败时旧书包或
last-good projection 仍可见。

### 7. `compatibility_diagnostics`：部分通过

Type DD 新增 `upgradePathMatrix.compatibilityDiagnostics`，提供
`legacy_schema_supported`、`legacy_schema_unknown`、
`artifact_schema_incompatible`、`qmd_index_schema_incompatible`、
`producer_lineage_schema_missing`、`source_closure_missing`、
`manual_decision_required`、`rebuild_required`、`repair_required` 与
`fail_closed_unsupported` 等 stable codes。`migrationEvidence` 与 mount scan
state 也提供了明确保存位置。

剩余缺口是 baseline 要求的全部诊断状态尚未闭合。当前诊断码缺少明确的
`missing_required_file`、`rebuild_failed` 与 `tool_version_too_old` 等兼容诊断；
qmd rebuild 的失败码存在于 `qmdRebuildTransaction`，但未统一进入 migration
compatibility diagnostic schema。工具版本不足、GraphRAG 重建失败和迁移期缺失
文件仍可能产生不一致状态。

### 8. `producer_lineage_preservation`：部分通过

Type DD 已强化 producer lineage：GraphRAG artifact 必须绑定 producer run
output hash，producer runs 可按 redacted summary 保留，`migrationToolEvidence`
记录 migration tool version、时间、artifact class、action、input/output hash 与
failure code，并明确不得声称未实际运行的 producer stage 成功。

剩余缺口是 baseline 要求旧 run evidence、`createdBy`、artifact provenance、
source provenance 与 migration tool evidence 被保留或显式标记缺失。当前文档对
旧 evidence 缺失的标记规则仍偏分散，只明确了
`producer_lineage_schema_missing`，未要求每类旧 provenance 形成
`present/missing/redacted` 状态。

### 9. `privacy_preservation`：通过

Type DD 新增 `sensitiveMaterialTaxonomy`，按 provider payloads、credentials、
private paths 与 runtime payloads 分类敏感材料，并规定 export、import、
mountScan、migration、query 的 scanner read policy。其中 migration 明确为
`no_raw_provider_payload_reads`，并禁止 provider requests、provider responses、
logs、debug、trace、recovery payload、凭据与绝对本地路径进入 manifest 或
诊断内容。

该维度满足 baseline：升级扫描和导出不得读取或复制 provider payload、secrets、
logs、recovery payload 或本地凭据；旧包中敏感路径只能被拒绝、隔离或记录为
不含内容的诊断。

### 10. `upgrade_testability`：部分通过

Type DD 已新增明确模块边界：`book-upgrade-paths.mjs`、
`book-artifact-schema-conversion.mjs`、`book-package-migration.mjs`、
`book-qmd-rebuild-transaction.mjs`、`book-graphrag-artifact-metadata.mjs` 与
`book-sensitive-material-policy.mjs`。测试契约覆盖升级路径矩阵、artifact
conversion matrix、legacy migration idempotency、qmd rebuild、GraphRAG schema
mismatch 与 sensitive material rejection。

剩余缺口是测试契约仍主要是行为清单，而不是 fixture 级自动化契约。baseline
要求验证 supported migration、unsupported migration、checksum mismatch、
rollback、rebuild qmd index、GraphRAG schema incompatible 与 privacy exclusion。
当前文档没有为这些升级专项测试逐项指定输入 fixture、预期状态、输出诊断文件与
失败码，尤其缺少 migration checksum mismatch 和 migration rollback 的专项测试
契约。

## pass_fail

总体结论：未通过（fail）。

R3 相比 R2 有明显修复：升级路径矩阵、artifact schema conversion、隐私扫描边界
和 qmd/GraphRAG readiness gate 已显著增强。但固定 baseline 的 10 维中仍有
6 维只达到部分通过，特别是逐 schema version 的迁移矩阵、identity old/new 审计、
统一兼容诊断 schema、producer provenance 缺失标记和 fixture 级升级测试仍未闭合。

| baseline id | R3 结果 | 判定摘要 |
| --- | --- | --- |
| `legacy_version_detection` | 部分通过 | 识别状态与检测输入已增强，但 unknown 与 unsupported 仍合并为 `unsupported_unknown`。 |
| `migration_path_matrix` | 部分通过 | 已有 path rows，但未按每个旧 schema/layout/qmd/artifact version 展开。 |
| `artifact_schema_conversion` | 通过 | qmd、parquet、LanceDB、reports、stats、context 与 producer runs 均有转换或失效规则。 |
| `identity_stability` | 部分通过 | 有 identity migration record，但缺 normalizedHash 与 producerRunIds 的 old/new 审计。 |
| `checksum_reclosure` | 通过 | 新 file entries、checksums、manifest sidecars 与 publish marker 形成新闭包。 |
| `rollback_atomicity` | 通过 | staging、atomic publish、rollback 与 last-good projection 已覆盖。 |
| `compatibility_diagnostics` | 部分通过 | 有 stable codes 和存放位置，但缺 missing file、rebuild failed、tool version too old 等统一状态。 |
| `producer_lineage_preservation` | 部分通过 | lineage binding 和 migration tool evidence 已增强，旧 provenance 缺失标记仍不足。 |
| `privacy_preservation` | 通过 | migration no-read policy 与敏感材料分类已满足隐私排除要求。 |
| `upgrade_testability` | 部分通过 | 模块和行为测试清单已增强，但缺 fixture 级升级专项测试契约。 |

## criteria_delta_from_r2

| baseline id | R2 结果 | R3 结果 | delta |
| --- | --- | --- | --- |
| `legacy_version_detection` | 部分通过 | 部分通过 | 新增 detection states 和 inputs，但 unknown/unsupported 未完全拆分。 |
| `migration_path_matrix` | 未通过 | 部分通过 | 新增 path rows，仍缺逐 schema version 矩阵。 |
| `artifact_schema_conversion` | 部分通过 | 通过 | 新增 artifact conversion matrix 与 metadata contract，已覆盖 baseline artifact 类。 |
| `identity_stability` | 部分通过 | 部分通过 | 新增 identityMigrationRecord，但未覆盖 normalizedHash 与 producerRunIds。 |
| `checksum_reclosure` | 基本通过 | 通过 | 旧 manifest 作为 legacy evidence、新闭包授权挂载的规则已明确。 |
| `rollback_atomicity` | 通过 | 通过 | 保持通过；新增 lock/staging cleanup 强化恢复边界。 |
| `compatibility_diagnostics` | 部分通过 | 部分通过 | 新增 stable codes，但诊断枚举仍不完整。 |
| `producer_lineage_preservation` | 部分通过 | 部分通过 | 新增 migrationToolEvidence 和 no fabricated producer success 规则，缺失标记仍不足。 |
| `privacy_preservation` | 部分通过 | 通过 | 新增 sensitiveMaterialTaxonomy 与 migration no-read policy，隐私排除闭合。 |
| `upgrade_testability` | 部分通过 | 部分通过 | 新增专项模块和行为测试清单，但缺 fixture 级输入输出契约。 |

## required_design_changes

1. 将 `upgradePathMatrix.pathRows` 扩展为逐 schema version 矩阵。每行必须包含旧
   package schema、layout version、qmd index schema、GraphRAG artifact schema、
   迁移目标、前置条件、转换步骤、失败状态和不可升级诊断。为
   `legacy_book_root_without_manifest` 与 `repairable_incomplete` 增加独立行。

2. 将 `unsupported_unknown` 拆分为独立的 `unknown` 与 `unsupported` 分类状态，
   并明确二者与 `repairable`、`current` 的检测优先级、诊断码和终态。

3. 扩展 `identityMigrationRecord`。至少增加 old/new `sourceHash`、
   old/new `normalizedHash`、old/new `producerRunIds`、冲突策略、算法版本、
   变更原因和无法重算时的缺失标记。

4. 统一 `compatibilityDiagnostics`。补充 `missing_required_file`、
   `rebuild_failed`、`tool_version_too_old`、`unsupported_legacy_schema` 等稳定
   状态，并明确它们在 migration evidence、mount scan state 或 runtime state 中
   的保存路径。

5. 补强 producer provenance 保全契约。对旧 run evidence、`createdBy`、artifact
   provenance、source provenance 与 migration tool evidence 分别要求
   `present`、`missing`、`redacted` 或 `incompatible` 状态，避免旧证据缺失被静默
   忽略。

6. 补充 fixture 级升级测试契约。对 supported migration、unsupported migration、
   checksum mismatch during migration、migration rollback、rebuild qmd index、
   GraphRAG schema incompatible 与 privacy exclusion during upgrade 指定 fixture
   输入、预期状态、诊断码和输出文件。

## residual_risks

- 当前设计假设旧版本集合较小；若后续出现多个旧 qmd index schema 或 GraphRAG
  artifact schema，现有 shape-based path rows 可能不足以避免误升级。
- `qmd_book_index_format` 仍是 open question，未来若 qmd SQLite 从可选投影变成
  默认包内 artifact，identity、checksum 与 rebuild gate 需要再次复审。
- 隐私排除已经在设计层闭合，但实现必须保持路径级扫描和 no-read policy，避免
  为了 secret scan 或 migration diagnostics 打开 raw provider payload。
- Producer evidence redaction 可能隐藏排障所需细节；需要用 package-relative、
  hash-bound summary 保持 lineage 可验证性。
- 本报告只审查 Type DD 设计文本，未验证实现代码或实际迁移 fixture。
