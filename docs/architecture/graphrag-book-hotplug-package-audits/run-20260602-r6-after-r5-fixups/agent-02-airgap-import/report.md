# R6 固定基准设计审计：agent-02-airgap-import

## scenario

离线机器导入书包，不能访问 provider，也不能依赖原始 batch catalog。
审计对象为：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

R3 与 R5 文件按主设计文档声明作为规范性补充
（normative supplements）一起评估。审计只判断设计文档是否满足固定
10 维 `passCriteria`；未读取 provider payload、secrets、`.env`、凭据、
日志 payload 或私有运行数据。

## reused_fixed_baseline

复用固定基准（fixed baseline）：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-02-airgap-import/baseline.yaml`

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

未创建新基准，未新增、删除、重排或重命名审计维度。

## baseline_integrity_check

结论：PASS。

`baseline.yaml` 维度数量为 10，ID 顺序为 AIG-01 至 AIG-10，与本报告
判定表完全一致。本次只读取该文件以取得固定 `passCriteria`，未修改
`baseline.yaml`。输出仅写入本目录的 `report.md`。

## findings

| id | 维度 | 判定 | 设计证据与结论 |
| --- | --- | --- | --- |
| AIG-01 | 离线闭包完整性 | PASS | 主文档要求 `graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需的完整书包闭包，包括 `source/`、`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/` 和脱敏 `state/`。该闭包不得依赖 sibling source、global input、provider 服务、provider payload 或原始 batch catalog。R5 staged import 合同要求完整文件复制和 required file validation 后才允许发布。 |
| AIG-02 | 挂载权威唯一性 | PASS | 主文档明确 `BOOK_MANIFEST.json` 是 mounted book package 的唯一权威描述；`graph_vault/catalog`、全局 qmd index 和 retrieval index 仅为 mount scan 派生投影或缓存。R5 `manifestFirstDirectQueryResolver` 进一步规定 catalog projection 缺失、陈旧或与 manifest digest 不一致时，query readiness 由 manifest 与包内 artifacts 决定。 |
| AIG-03 | 原始 batch catalog 独立性 | PASS | 主文档 `catalogProjectionSchemas` 固定了 `books.yaml`、`sources.yaml`、`document-identity-map.yaml` 和 `graph-capabilities.yaml` 的字段来源，输入限定为 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、readiness gates 和 scan validation results，并禁止读取 `graph_vault/catalog/batch-runs/**`。R5 direct query 与 staged import 合同均不需要原始 batch catalog 判定可挂载。 |
| AIG-04 | Provider 隔离 | PASS | 主文档和 R3/R5 补充文档禁止 importer、mount scanner、compatibility checker 和 query gate 读取 provider payload roots、provider response logs、raw prompts、raw completions、secrets、credential stores 或 provider auth config。R3 明确 missing sensitive roots 不得作为 query-ready 必需条件；R5 明确 provider roots absent 不会导致 manifest-first query gate 失败。 |
| AIG-05 | 校验与失败关闭 | PASS | 主文档要求 projection 前验证 manifest schema、manifest checksum sidecars、package-relative paths、required file presence、file sha256、identity conflicts 和 schema compatibility。R5 importer pre-publish 合同新增 staged import 发布前校验、fencing token 和失败后 liveRoot unchanged；R5 GraphRAG gate state machine 要求 checksum mismatch、unsafe path、corrupt sidecar 或 payload leak 进入 quarantine，而不是部分挂载。 |
| AIG-06 | 路径可移植性 | PASS | 主文档要求 manifest `files` 使用 package-relative path，`source/` 和 `input/` 的外部路径只可作为 provenance 或兼容元数据。R3 明确 `BOOK_MANIFEST.mount.packageRoot` 固定为 package-relative locator `"."`，live vault absolute paths 属于 scan-local state，不得写入 manifest。R5 manifest sensitivity schema 禁止 absolute local path、user home path 和 provider cache path。 |
| AIG-07 | 离线兼容性判定 | PASS | 主文档和 R3 `schemaVersionUpgradeMatrix` 定义 package schema、layout version、qmd index schema、GraphRAG artifact schema、producer lineage schema、parquet/LanceDB schema digest、embedding dimension 和 runtime reader version 等离线输入。决策结果包括 `mount_as_is`、`rebuild_qmd_projection`、`visible_not_query_ready`、`repair_required`、`quarantine_mount_candidate` 和 `fail_closed`。R5 pre-publish 合同要求 staged import 在 live-root rename 前完成这些兼容性校验。 |
| AIG-08 | 查询就绪门槛 | PASS | 主文档区分 mounted、qmd-ready 和 GraphRAG query-ready。GraphRAG query-ready 需要 output manifest、text unit identity、context、stats、parquet tables、LanceDB、artifact metadata rows、checksum binding、schema digest 和 redacted producer lineage summaries。R5 manifest-first resolver 允许 catalog cache 缺失时从 manifest 与包内 artifacts 判定 readiness；缺失 artifact metadata row 返回 `visible_not_query_ready`。qmd index 缺失时按 R5 qmd availability matrix 选择本地 projection rebuild 或不可 qmd retrieval。 |
| AIG-09 | 导入状态隔离 | PASS | 主文档将 runtime writes、local query caches、repair diagnostics 和 import state 放在 `runtimeStateRoot` 或 catalog scan state，而非 package root；`externalRuntimeLayout` 将导入诊断、mount 状态、本地查询缓存和 qmd projection 放在接收 vault 的 `.local` 与 `catalog/*` roots。`bookManifestSchema.mount` 同时要求可写 runtime state 隔离在 `import/` 或 `state/runtime` 并排除在 package checksums 外。R5 staged import 明确禁止把 import diagnostics 写入 distributable package closure。 |
| AIG-10 | 可实施流程与测试 | PASS | 主文档列出 manifest、mount scanner、lifecycle、readiness gates、security、migration、import、catalog projection、quarantine repair、schema conversion、lock cleanup、qmd rebuild 和 GraphRAG artifact metadata 等模块职责。生命周期步骤、错误分类、quarantine/repair state machine、projection transaction 和测试合同足以指导在空 vault、无 provider、无原始 batch catalog 的机器上实现验证。R5 fixed baseline test contracts 补充 staged import、provider no-read、manifest-first query 和 direct copy fail-closed fixtures。 |

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

与上一轮 `run-20260602-r5-fixed-baseline-rerun` 相比，本次未改变
AIG-01 至 AIG-10 的审计维度、名称、顺序或 `passCriteria`。上一轮
agent-02 结果为 PASS；本轮在同一固定维度下继续为 PASS。

R5 补充文档只作为规范性设计证据纳入评估，补强 staged import、
manifest sensitivity、manifest-first direct query、GraphRAG artifact gate
state machine 和 fixed baseline test contracts；这些补强没有形成新基准，
也没有替换固定 baseline。

## required_design_changes

无强制设计变更。

当前主 Type DD、R3 规范性补充文档与 R5 规范性补充文档共同满足离线
导入场景要求的固定 10 维 `passCriteria`。后续工作应进入实现验证
（implementation verification）、fixture 执行和 no-read 行为测试，而不是
扩大本基准的设计范围。

## residual_risks

- 本审计只检查设计文档，不证明实现代码已经遵守 provider no-read、
  fail-closed、projection transaction 或 query-ready gate 合同。
- AIG-09 的实现必须保持 `.local`、`catalog/*`、`import/` 与
  `state/runtime` 的语义映射清晰，确保导入诊断、mount 状态和本机
  runtime 状态不进入分发闭包，也不参与包校验。
- qmd 本地重建仍依赖接收机器具备兼容工具链和本地可用输入；无网络环境
  下不得把外部 provider 可用性作为 query-ready 前提。
- Source-redacted package 可以离线查询既有 qmd/GraphRAG 产物，但不能在无
  source 或 normalized input 的情况下承诺完整 rebuild 能力。
