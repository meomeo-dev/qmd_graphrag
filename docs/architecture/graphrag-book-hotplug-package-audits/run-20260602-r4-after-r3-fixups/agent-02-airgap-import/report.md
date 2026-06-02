# scenario

离线机器导入书包，不能访问 provider，也不能依赖原始 batch catalog。

审查对象为主 Type DD：
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。

规范性补充 Type DD：
`docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`。

审查边界限于 Type DD、补充 Type DD 与本目录固定 `baseline.yaml`。
未读取 provider payload、secrets、凭据、原始 provider 请求/响应或运行 payload。

# reused_fixed_baseline

复用本 R4 目录已有固定基线：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-02-airgap-import/baseline.yaml`

baseline SHA-256：
`9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4`

固定维度共 10 项，顺序为：

| order | id | name |
|---:|---|---|
| 1 | AIG-01 | 离线闭包完整性 |
| 2 | AIG-02 | 挂载权威唯一性 |
| 3 | AIG-03 | 原始 batch catalog 独立性 |
| 4 | AIG-04 | Provider 隔离 |
| 5 | AIG-05 | 校验与失败关闭 |
| 6 | AIG-06 | 路径可移植性 |
| 7 | AIG-07 | 离线兼容性判定 |
| 8 | AIG-08 | 查询就绪门槛 |
| 9 | AIG-09 | 导入状态隔离 |
| 10 | AIG-10 | 可实施流程与测试 |

# baseline_integrity_check

| check | result |
|---|---|
| R4 `baseline.yaml` 是否存在 | Pass |
| baseline SHA-256 | `9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4` |
| R4 baseline 是否复用 R3 agent-02 baseline | Pass，SHA-256 一致 |
| R4 baseline 是否复用 R2 agent-02 baseline | Pass，SHA-256 一致 |
| R4 baseline 是否复用初始固定 baseline | Pass，SHA-256 一致 |
| 维度数量 | Pass，10 项 |
| 维度顺序 | Pass，AIG-01 至 AIG-10 未重排 |
| 维度 id/name | Pass，未新增、删除、重命名 |
| `passCriteria` | Pass，未改变 |
| `baseline.yaml` 覆盖状态 | Pass，未覆盖 |

# findings

## AIG-01 离线闭包完整性

结论：通过。

主 Type DD 将 `graph_vault/books/{bookId}` 定义为单本书包权威根目录，
并要求 `packageRoot` 包含校验、查询、导出和重挂载所需的全部文件，
且不得依赖 sibling source 或 catalog roots。目标布局要求 `source/`、
`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/` 和脱敏 `state/`
进入书包闭包。provider 请求、响应、密钥和日志 payload 被排除在分发范围外。

关键证据：
`scope.included/excluded`、`targetContract.packageRoot`、
`targetDirectoryLayout.required`、`scannerNoReadContracts`。

## AIG-02 挂载权威唯一性

结论：通过。

主 Type DD 明确 `BOOK_MANIFEST.json` 是 mounted book package 的权威描述；
`graph_vault/catalog`、全局 qmd index 和 retrieval index 只是 mount scan
派生的 projection/cache。`distribution_manifest.json` 仅保留为旧分发闭包
证据，不能作为 hot-plug authoritative manifest。

关键证据：
`targetContract.packageAuthority`、`targetContract.mountScanner`、
`distributionManifestMigration.compatibilityBridge`。

## AIG-03 原始 batch catalog 独立性

结论：通过。

`catalogProjectionSchemas` 定义了从 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
readiness gates 和 scan validation results 重建 `books.yaml`、
`sources.yaml`、`document-identity-map.yaml`、`graph-capabilities.yaml`
及 conflict index 的字段来源。该 schema 明确禁止读取
`graph_vault/catalog/batch-runs/**`、provider catalog roots、全局 input
和 absolute source paths。导入可挂载性由 manifest、sidecars、publish marker、
checksums、schema compatibility 和 identity conflict 决定，不依赖原始 batch
catalog。

关键证据：
`mountScanTransactionModel.validationPipeline`、`catalogProjectionSchemas`、
`scannerNoReadContracts`。

## AIG-04 Provider 隔离

结论：通过。

主 Type DD 与 R3 补充 Type DD 均禁止离线 importer、mount scanner、
compatibility checker 和 query gate 读取 provider payload、credentials、
raw prompts、raw completions、provider auth config 或 raw logs。缺少敏感根
不得降低已打包 GraphRAG 产物的 query-ready 判定；如果包需要敏感根证明
readiness，则包本身无效并标记为 `not_query_ready`。GraphRAG gate failure
只返回稳定诊断，不触发 provider calls。

关键证据：
`securityExportPolicy.manifestFieldClassification`、
`securityExportPolicy.producerEvidenceRedaction`、
`sensitiveMaterialTaxonomy.scannerReadPolicy`、`scannerNoReadContracts`。

## AIG-05 校验与失败关闭

结论：通过。

主 Type DD 要求在 catalog 或 qmd projection 变更前验证 manifest schema、
package-relative paths、required file presence、checksums、identity conflicts
和 schema compatibility。缺失 manifest、缺失 publish marker、缺 required file、
checksum mismatch、path traversal、symlink escape 和 corrupt sidecar 均不会被
部分挂载。损坏、缺失、歧义或 unsafe package 进入 quarantine 或非 query-ready
诊断状态；成功 repair 只能在完整 validator pass 和新 projection generation
commit 后生效。

关键证据：
`atomicPackageLifecycle.publishProtocol`、
`atomicPackageLifecycle.incompletePackagePolicy`、
`mountScanTransactionModel.validationPipeline`、
`quarantineAndRepairStateMachine.validatorContract`。

## AIG-06 路径可移植性

结论：通过。

主 Type DD 要求生成 `BOOK_MANIFEST.json` 时只使用 package-relative paths。
`source.sourcePath` 必须位于 `source/`，外部 source path 只能作为 provenance；
legacy `graph_vault/input` path 只能作为 compatibility metadata。安全策略拒绝
absolute path、parent traversal、symlink escape 和 hardlink outside package。
R3 补充进一步规定 `BOOK_MANIFEST.mount.packageRoot` 恒为 package-relative
locator，值为 `"."`。

关键证据：
`atomicPackageLifecycle.publishProtocol`、`bookManifestSchema.source/input/files`、
`securityExportPolicy.pathSafety`、
`providerSensitiveClassExtensions.mountPackageRootSemantics`、
`compatibilityBridgeLifecycle.rules`。

## AIG-07 离线兼容性判定

结论：通过。

主 Type DD 与 R3 补充 Type DD 给出 package schema、layout version、
qmd index schema、GraphRAG artifact schema、producer lineage schema、
parquet schema digest、LanceDB schema digest、embedding dimension 和本机
runtime reader/tool version 的兼容输入字段。判定结果包括 `mount_as_is`、
`migrate_to_hotplug_v1`、`rebuild_qmd_projection`、
`visible_not_query_ready`、`repair_required` 和 `fail_closed`，可在无网络
条件下执行。

关键证据：
`bookManifestSchema.compatibility`、`versionAndMigrationModel`、
`schemaVersionUpgradeMatrix`、`artifactSchemaConversionMatrix`、
`graphRagArtifactMetadataContract.queryGateCompatibilityInputs`。

## AIG-08 查询就绪门槛

结论：通过。

Type DD 区分 mounted、qmd-ready、GraphRAG-ready 和 query-ready。qmd-ready
需要 included index fresh 或本地 projection ready；缺少 book-scoped qmd index
时，manifest 必须声明 `reindex_on_mount` 并列出本地重建 input closure。
GraphRAG query-ready 要求最小 artifact closure、artifact metadata row、
checksum、schema digest、producer lineage 和 output hash 双向绑定。

关键证据：
`readinessGates.qmdReadyGate`、`readinessGates.graphragReadyGate`、
`qmdRebuildTransaction`、`graphRagArtifactMetadataContract`、
`qmdAvailabilityAndReexportPolicy`。

## AIG-09 导入状态隔离

结论：部分通过。

主 Type DD 已满足“状态不得写入 distributable package、不得参与包校验”的
核心隔离要求：readonly package 的 runtime writes、local query caches、
repair diagnostics 和 import state 放在 `runtimeStateRoot` 或 catalog scan
state，`externalRuntimeLayout` 也声明这些 roots 是 receiving vault local，
不是 distributable book package 的一部分。

未完全满足点在路径类别一致性。固定 passCriteria 要求导入诊断、mount 状态
和本机运行时状态隔离在 `import/` 或 `state/runtime` 中；当前实际 layout 使用
`graph_vault/.local/book-runtime/{bookId}`、`graph_vault/catalog/mount-scans`
和 `graph_vault/catalog/qmd-book-projections/{bookId}`。虽然
`bookManifestSchema.mount.contract` 规定 writable runtime state 应位于
`import/` 或 `state/runtime` 并排除在 package checksums 外，但该命名没有与
`externalRuntimeLayout` 的实际路径统一，且没有明确导入诊断和 mount 状态在
`import/` 或 `state/runtime` 下的最终归属。

关键证据：
`atomicPackageLifecycle.writableRoots`、`externalRuntimeLayout`、
`bookManifestSchema.mount.contract`、`mountScanTransactionModel.scanState`。

## AIG-10 可实施流程与测试

结论：通过。

主 Type DD 提供了可实施模块边界、生命周期步骤、错误分类和测试合同。
模块职责覆盖 manifest builder、mount scanner、package lifecycle、
readiness gates、security policy、migration、import、catalog projection、
quarantine repair、qmd rebuild、GraphRAG artifact metadata 和 R3 fixup
contracts。测试合同覆盖空 vault 复制导入、删除卸载、缺 publish marker、
scanner crash、provider payload 排除、path/symlink/secret fail closed、
identity conflict、qmd rebuild、GraphRAG lineage gate、legacy migration、
derived catalog rebuild without batch run state 和 R3 supplemental contracts。

关键证据：
`implementationPlan.designFirstModules`、`implementationPlan.testContracts`、
`schemaVersionUpgradeMatrix.fixtureContracts`、`qmdDiagnosticsSchema.tests`。

# pass_fail

总体结论：部分通过 (Partial)。

| id | result |
|---|---|
| AIG-01 | Pass |
| AIG-02 | Pass |
| AIG-03 | Pass |
| AIG-04 | Pass |
| AIG-05 | Pass |
| AIG-06 | Pass |
| AIG-07 | Pass |
| AIG-08 | Pass |
| AIG-09 | Partial |
| AIG-10 | Pass |

9 项通过，1 项部分通过，0 项失败。阻断点不是 provider 访问、batch catalog
依赖或 query-ready gate，而是 AIG-09 对 `import/` 或 `state/runtime` 路径
类别的固定要求与当前 `externalRuntimeLayout` 实际路径不完全一致。

# criteria_delta_from_r3

baseline 判据变化：无。

R4 继续复用与 R3、R2、初始固定基线相同的 10 个 dimension id、name 和
`passCriteria`。没有新增、删除、重排、重命名维度，也没有改变任何
`passCriteria`。R4 与 R3 agent-02 baseline 的 SHA-256 均为：
`9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4`。

结果变化：

| id | R3 result | R4 result | delta |
|---|---|---|---|
| AIG-01 | Pass | Pass | 无 |
| AIG-02 | Pass | Pass | 无 |
| AIG-03 | Pass | Pass | 无 |
| AIG-04 | Pass | Pass | 无 |
| AIG-05 | Pass | Pass | 无 |
| AIG-06 | Pass | Pass | 无 |
| AIG-07 | Pass | Pass | 无 |
| AIG-08 | Pass | Pass | 无 |
| AIG-09 | Pass | Partial | R4 按固定 passCriteria 严格核对 `import/` 或 `state/runtime` 路径类别，发现实际 layout 使用 `.local` 与 `catalog/*` roots，缺少统一映射。 |
| AIG-10 | Pass | Pass | 无 |

# required_design_changes

1. 统一 AIG-09 状态根路径。将导入诊断、mount 状态、本机 query cache、
   qmd projection state 和 writable runtime state 的 vault-local 归属明确改为
   `graph_vault/import/{importId}/{bookId}/...` 或
   `graph_vault/state/runtime/{bookId}/...`，或在 Type DD 中明确定义现有
   `.local/book-runtime` 是 `state/runtime` 的兼容别名并给出迁移规则。

2. 同步更新 `atomicPackageLifecycle.writableRoots`、`externalRuntimeLayout`、
   `bookManifestSchema.mount.contract`、`mountScanTransactionModel.scanState`
   和 `qmdRebuildTransaction.transactionPaths`，避免同一类本机状态同时出现
   `.local`、`catalog/mount-scans`、`catalog/qmd-book-projections` 与
   `state/runtime` 多套命名。

3. 明确这些 vault-local 状态均不属于 distributable package closure，不进入
   `BOOK_MANIFEST.files`，不计入 package checksum、manifest checksum 或
   export allowlist；只有显式 debug export 才能产生脱敏 support bundle。

4. 增加 AIG-09 专项测试合同：导入诊断、mount 状态和本机 runtime 状态变更
   不改变 `manifestSha256`，不改变 package closure digest，不影响 readonly
   package export；删除这些本机状态后，离线 importer 可重新生成诊断和
   projection state。

# residual_risks

- Source-redacted package 可以离线查询既有 qmd/GraphRAG 产物，但不能在无
  replacement source material 时完整 rebuild source-derived artifacts。
- 离线兼容性判定依赖实现层维护本机 toolchain/version support matrix；Type DD
  已定义输入和结果，但实现若漏配版本表仍会误判兼容性。
- Provider payload 隔离依赖 allowlist-first export、no-read scanner policy 和
  secret scan 的一致实现；实现层必须避免把诊断 payload 原文写回报告。
- 首次导入或大规模 repair 时，full closure checksum 与 qmd projection rebuild
  可能产生较高 I/O；当前设计有预算和降级策略，但需要压测验证。
- Legacy compatibility bridge、relative symlink 和旧 distribution manifest
  迁移必须严格按 R3 补充生命周期过期；否则可能重新引入外部路径定位依赖。
