# R5 固定基准设计审计：agent-02-airgap-import

## scenario

离线机器导入书包，不能访问 provider，也不能依赖原始 batch catalog。
审计对象为：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

第二个文件按主设计文档声明作为规范性补充
（normative supplement）一起评估。审计只判断设计文档是否满足固定
10 维 `passCriteria`；未读取 provider payload、secrets、`.env`、
凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

复用固定基准：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-02-airgap-import/baseline.yaml`

基准 SHA-256：
`9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4`

审计维度保持原始顺序：

1. AIG-01 离线闭包完整性
2. AIG-02 挂载权威唯一性
3. AIG-03 原始 batch catalog 独立性
4. AIG-04 Provider 隔离
5. AIG-05 校验与失败关闭
6. AIG-06 路径可移植性
7. AIG-07 离线兼容性判定
8. AIG-08 查询就绪门槛
9. AIG-09 导入状态隔离
10. AIG-10 可实施流程与测试

未创建新基准（baseline），未新增、删除、重排或重命名审计维度。

## baseline_integrity_check

结论：PASS。

`baseline.yaml` 维度数量为 10，ID 顺序为 AIG-01 至 AIG-10，与本报告
判定表完全一致。本次只读取该文件以取得固定 `passCriteria`，未修改
`baseline.yaml`。输出仅写入本目录的 `report.md`。

## findings

| id | 维度 | 判定 | 设计证据与结论 |
| --- | --- | --- | --- |
| AIG-01 | 离线闭包完整性 | PASS | 主文档要求 `graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需文件，并列出 `source/`、`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/`、`state/` 等书级闭包。设计同时声明不依赖 sibling source 或 catalog roots，provider 请求、响应、密钥和日志 payload 不进入分发包。证据：主文档 `targetContract.packageRoot`、`targetDirectoryLayout`、`securityExportPolicy`。 |
| AIG-02 | 挂载权威唯一性 | PASS | 主文档明确 `BOOK_MANIFEST.json` 是 mounted book package 的 authoritative description；`graph_vault/catalog`、全局 qmd 和 retrieval indexes 仅为 mount scan 派生投影或缓存。证据：主文档 `targetContract.packageAuthority`。 |
| AIG-03 | 原始 batch catalog 独立性 | PASS | 主文档定义 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、`graph-capabilities.yaml` 的字段来源，输入限定为 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、readiness gates 和 scan validation results，并禁止读取 `graph_vault/catalog/batch-runs/**`、provider catalog roots、`graph_vault/input/**` 和 absolute source paths。导入流程以 manifest 和 sidecars 判定候选包，不需要原始 batch catalog。证据：主文档 `mountScanner`、`catalogProjectionSchemas`。 |
| AIG-04 | Provider 隔离 | PASS | 主文档和 R3 补充文档共同禁止导入器、mount scanner、compatibility checker 和 query gate 读取 provider payload roots、credential stores、runtime logs、raw prompts/completions 和 provider auth config；缺失敏感根不影响已打包产物的 query-ready 证明，若需要敏感根证明 readiness 则包无效并标记 `not_query_ready`。证据：主文档 `sensitiveMaterialTaxonomy`，R3 `scannerNoReadContracts`。 |
| AIG-05 | 校验与失败关闭 | PASS | 设计要求 projection 前验证 manifest schema、package-relative paths、required file presence、checksums、identity conflicts 和 schema compatibility；manifest、file sha256、sidecar、publish marker、路径逃逸和 symlink escape 均有稳定错误码。失败结果为 quarantine、`visible_not_query_ready`、`not_mounted` 或保留 last-good projection，不产生部分挂载。证据：主文档 `atomicPackageLifecycle`、`mountScanTransactionModel`、`quarantineAndRepairStateMachine`。 |
| AIG-06 | 路径可移植性 | PASS | 设计要求 `BOOK_MANIFEST.json` 使用 package-relative paths；source、input、files、diagnostics、bridge locators 和 mount package root 均不得依赖 absolute local path、external source path 或 batch run path。R3 补充进一步规定 `BOOK_MANIFEST.mount.packageRoot` 固定为 package-relative locator `"."`。证据：主文档 `bookManifestSchema`、`securityExportPolicy`，R3 `mountPackageRootSemantics`。 |
| AIG-07 | 离线兼容性判定 | PASS | 主文档定义 package schema、layout、qmd index schema、GraphRAG artifact schema、parquet/LanceDB schema digest、producer lineage schema 和 runtime reader version 等兼容输入；R3 补充给出按 schema version、layout version、qmd index schema、GraphRAG artifact schema、producer lineage schema 匹配的 upgrade matrix，并列出 `mount_as_is`、`rebuild_qmd_projection`、`visible_not_query_ready`、`fail_closed` 等离线决策。证据：主文档 `versionAndMigrationModel`、`graphRagArtifactMetadataContract`，R3 `schemaVersionUpgradeMatrix`。 |
| AIG-08 | 查询就绪门槛 | PASS | 设计区分 mounted、qmd-ready 和 GraphRAG query-ready；GraphRAG query-ready 需要 output manifest、text unit identity、context、stats、parquet tables、LanceDB、artifact metadata rows、schema digest、checksum 和 producer lineage binding。qmd index 缺失时通过 `reindex_on_mount` 和外部 projection root 重建，不写入只读包。证据：主文档 `readinessGates`、`qmdRebuildTransaction`、`graphRagArtifactMetadataContract`，R3 `qmdAvailabilityAndReexportPolicy`。 |
| AIG-09 | 导入状态隔离 | PASS | 设计将导入诊断、mount scan generation、本地查询缓存、qmd projection 和运行时可写状态隔离在接收 vault 的 `.local`、`catalog/mount-scans`、`catalog/qmd-book-projections` 或 runtime state roots；这些状态不是分发包的一部分，除非显式 debug export 生成已脱敏 support bundle。包内 `state/` 只包含脱敏 final state snapshot，运行时 import 状态不写入包内。证据：主文档 `atomicPackageLifecycle.writableRoots`、`externalRuntimeLayout`、`bookManifestSchema.mount`。 |
| AIG-10 | 可实施流程与测试 | PASS | 主文档给出模块职责、mount lifecycle、migration lifecycle、error codes、quarantine/repair state machine、catalog projection schemas、artifact conversion matrix、sensitive material taxonomy 和测试合同。测试覆盖空 vault copy install、无 provider payload export/import、无 batch state catalog rebuild、query-ready artifact closure、schema upgrade fixtures、damage validator 和 qmd rebuild transaction。R3 补充增加 fixture contracts、no-read contracts、qmd diagnostics 和 bridge lifecycle。证据：主文档 `implementationPlan.testContracts`，R3 `fixtureContracts`、`qmdDiagnosticsSchema`。 |

## pass_fail

总体结论：PASS。

固定 10 维全部通过：

| id | result |
| --- | --- |
| AIG-01 | PASS |
| AIG-02 | PASS |
| AIG-03 | PASS |
| AIG-04 | PASS |
| AIG-05 | PASS |
| AIG-06 | PASS |
| AIG-07 | PASS |
| AIG-08 | PASS |
| AIG-09 | PASS |
| AIG-10 | PASS |

## criteria_delta_from_previous_run

准则变化（criteria delta）：0。

本次 R5 固定基准复跑未改变 AIG-01 至 AIG-10 的审计维度、名称、
顺序或 `passCriteria`。R3 补充文档只作为规范性设计证据纳入评估，
没有形成新基准，也没有替换固定 baseline。

## required_design_changes

无强制设计变更。

当前主 Type DD 与 R3 规范性补充文档已覆盖离线导入场景要求的固定
10 维 pass criteria。后续工作应进入实现验证（implementation
verification）和 fixture 执行，而不是继续扩大本基准的设计范围。

## residual_risks

- 本审计只检查设计文档，不证明实现代码已经遵守 no-read、fail-closed、
  projection transaction 或 query-ready gate 合同。
- `not_mounted`、`incomplete_copy`、`quarantine_mount_candidate` 和
  `visible_not_query_ready` 的实现状态映射必须保持失败关闭语义，避免
  在 UI 或 API 中被误解释为可查询。
- qmd book index 默认是否打包、source EPUB 是否默认导出仍是主文档中的
 开放问题；这些问题不阻断本离线导入基准，但会影响后续产品策略。
