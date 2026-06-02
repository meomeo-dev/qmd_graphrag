# scenario

离线机器导入书包。接收机器只能获得
`graph_vault/books/{bookId}` 书包目录，不能访问 provider，也不能读取或依赖
原始 batch catalog。导入后必须仅凭 `BOOK_MANIFEST.json`、manifest sidecar
和包内文件完成校验、挂载投影、qmd 或 GraphRAG query-ready 判定，以及必要的
本地索引重建。

# reused_fixed_baseline

本轮复审复用本目录既有基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-02-airgap-import/baseline.yaml`

固定 10 维评估结果如下：

| id | name | R2 result |
| --- | --- | --- |
| AIG-01 | 离线闭包完整性 | 通过 |
| AIG-02 | 挂载权威唯一性 | 通过 |
| AIG-03 | 原始 batch catalog 独立性 | 部分通过 |
| AIG-04 | Provider 隔离 | 通过 |
| AIG-05 | 校验与失败关闭 | 通过 |
| AIG-06 | 路径可移植性 | 通过 |
| AIG-07 | 离线兼容性判定 | 通过 |
| AIG-08 | 查询就绪门槛 | 通过 |
| AIG-09 | 导入状态隔离 | 通过 |
| AIG-10 | 可实施流程与测试 | 通过 |

# baseline_integrity_check

R2 `baseline.yaml` 已按要求复用，未新增、删除、重命名维度，也未改变
`passCriteria`。

- R1 baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/agent-02-airgap-import/baseline.yaml`
- R2 baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-02-airgap-import/baseline.yaml`
- SHA-256:
  `9adf6bc3507b408bc0c4076e3bad25216443d57690a041b3c8dfa1451e4680e4`
- `diff -u` 结果为空，两个 baseline 文件内容一致。
- 本次复审只写入 `report.md`；未覆盖 `baseline.yaml`。

# findings

## AIG-01 离线闭包完整性

结论：通过。

修订后的 Type DD 将 `graph_vault/books/{bookId}` 定义为单本书包权威根目录，
并要求该根目录包含 `source/`、`input/`、`qmd/`、`graphrag/output/`、
`graphrag/runs/` 和脱敏后的 `state/` final snapshot。`packageRoot` 的
completeness rule 明确不得依赖 sibling source 或 catalog roots。

`BOOK_MANIFEST.json` 的 `files` 条目要求记录 package-relative `path`、
`bytes`、`sha256`、`required`、`producerRunId` 和 `sensitivity`。
GraphRAG 最低 artifact closure、qmd reindex 所需 normalized input、producer
lineage 和 checksum sidecars 也被纳入离线校验边界。provider payload、密钥、
日志和 recovery payload 被排除在可分发包之外。

## AIG-02 挂载权威唯一性

结论：通过。

Type DD 明确 `BOOK_MANIFEST.json` 是 mounted book package 的 authoritative
description。mount scanner 的 authoritative input 仅为
`graph_vault/books/*/BOOK_MANIFEST.json`，catalog、全局 qmd index 和 retrieval
index 均被定义为可重建 projection 或 cache。

旧 `distribution_manifest.json` 只作为 migration compatibility evidence，
不能作为 hot-plug authoritative manifest。该约束满足离线导入只信任书包
manifest 的要求。

## AIG-03 原始 batch catalog 独立性

结论：部分通过。

修订稿已经满足关键方向：mount scanner 从书包 manifest 枚举候选包，并派生
`books.yaml`、`sources.yaml`、`document-identity-map.yaml` 和
`graph-capabilities.yaml`。`mountScanTransactionModel` 还要求先构建
projection plan，再原子提交派生 catalog，失败时保留 last-good generation。

未完全通过的原因是派生 catalog 的字段映射仍未显式定义。Type DD 列出了
manifest 的 `identity`、`source`、`qmd`、`graphrag`、`compatibility` 等输入
字段，也把 `graphrag/output/qmd_graph_text_unit_identity.json` 纳入最低闭包；
但没有定义每个 derived catalog 文件的 schema、字段来源、必填字段和稳定
identity join 规则。

在严格 airgap 场景下，实现者不应为了确定 catalog 字段形状而读取原始 batch
catalog。当前设计已经禁止依赖原始 batch catalog，但还需要补足
catalog projection schema，才能完全满足本维 passCriteria。

## AIG-04 Provider 隔离

结论：通过。

scope 排除了 provider 请求、provider 响应、密钥和日志 payload 的分发。
`securityExportPolicy` 进一步采用 allowlist-first，禁止
`provider-requests/**`、`provider-responses/**`、logs、debug、trace、secret、
credential、token 和 key 类路径进入导出包。

`producerEvidenceRedaction` 只允许 producer run id、stage、input/output hash、
model/embedding fingerprint、toolVersion 和 completedAt 等摘要字段。prompts、
rawResponses、providerHeaders、requestBodies 和 responseBodies 被列为 forbidden
fields。GraphRAG query gate failure 也明确不触发 provider calls，除非用户执行
显式 rebuild command。因此 provider 不可达不会降低已打包且校验通过的
GraphRAG 产物的 query-ready 判定。

## AIG-05 校验与失败关闭

结论：通过。

修订稿定义了 manifest-last-write、checksum-last-commit、`PUBLISH_READY.json`
和 atomic rename。mount scanner 在投影 catalog 或 qmd index 前校验 manifest
schema、package-relative paths、required file presence、file checksums、身份
冲突和 schema compatibility。

失败策略覆盖 missing manifest、missing publish marker、missing required file、
checksum mismatch、path traversal、symlink escape 和 corrupt sidecar。失败包被
标记为 not_mounted、not_query_ready、visible_not_query_ready 或 quarantine
candidate，不会部分投影为 query-ready。projection commit 使用 staging root、
fsync 和 current-generation pointer，失败时保留 last-good projection。

## AIG-06 路径可移植性

结论：通过。

Type DD 要求 `BOOK_MANIFEST.json` 由 package-relative paths 生成，且每个 required
package file 都必须使用 package-relative path。旧 `graph_vault/input`、外部
source path 和 batch run path 只能作为 compatibility metadata 或 provenance，
不能参与离线定位。

`securityExportPolicy.pathSafety` 明确拒绝 absolute paths、parent traversal、
symlink escape 和 hardlink outside package。该设计足以保证接收机器不依赖发送方
用户名、本地绝对路径、sibling roots 或旧 batch run 目录。

## AIG-07 离线兼容性判定

结论：通过。

manifest `compatibility` section 要求记录 `minQmdGraphRagVersion`、
`graphRagArtifactSchema`、`qmdIndexSchema` 和 `createdBy`。
`versionAndMigrationModel.compatibilityMatrix` 覆盖 package schema、layout
version、qmd index schema、GraphRAG artifact schema、parquet schema digest、
LanceDB schema digest 和 producer lineage schema。

矩阵输出包括 `mount_as_is`、`migrate_metadata_only`、
`rebuild_qmd_projection`、`rebuild_graphrag_required`、
`visible_not_query_ready` 和 `fail_closed`。这些输入和决策结果可以由离线
importer 的内置兼容表执行，不需要联网或访问 provider。

## AIG-08 查询就绪门槛

结论：通过。

修订稿区分 mounted、qmd-ready、GraphRAG-ready 和 query-ready。qmd gate 定义了
included index、reindex required、projection ready、schema incompatible 等状态，
并以 `bookId`、`sourceHash`、`normalizedHash`、build manifest、index schema、
toolVersion、embedding profile、chunking config hash 和 required artifacts 作为
freshness inputs。

GraphRAG gate 定义了 minimum artifact closure，包括 qmd output manifest、
identity map、context、stats、documents/text_units/entities/relationships/
communities/community_reports parquet 和 LanceDB。producer lineage schema、
stage order、artifact-lineage binding rule、schema/dimension compatibility 和
query entrypoint 均已明确。缺少可本地重建的 qmd index 时，设计要求将 projection
写入 `graph_vault/catalog/qmd-book-projections/{bookId}`，不修改 readonly package。

## AIG-09 导入状态隔离

结论：通过。

修订稿把导入诊断、mount 状态、本地查询缓存和可写运行状态放在
`graph_vault/.local/book-runtime/{bookId}`，把 mount scan generation 和 projection
plan 放在 `graph_vault/catalog/mount-scans`，把 qmd projection 放在
`graph_vault/catalog/qmd-book-projections/{bookId}`。

`immutablePackagePolicy` 明确共享包 publish 后默认 readonly。runtime writes、
local query caches、repair diagnostics 和 import state 不写入 package root。
包内 `state/` 只承载脱敏后的 final state snapshot；导入后产生的本机状态被排除在
包校验闭包之外。

## AIG-10 可实施流程与测试

结论：通过。

Type DD 已提供可实施模块边界：manifest builder/validator、mount scanner、
lifecycle、readiness gates、security、migration、export 和 import。生命周期步骤
覆盖 staged import、direct directory copy、atomic publish、mount scan、quarantine、
projection commit、replacement 和 delete unmount。

测试合同覆盖空 vault 复制导入、删除后 projection 移除、缺
`PUBLISH_READY.json` 不挂载、scanner crash 保留 last-good generation、catalog/qmd
projection 不暴露 partial state、provider payload 排除、secret/path/symlink fail
closed、身份冲突、reindex_on_mount、qmd freshness invalidation、GraphRAG artifact
lineage binding、legacy manifest migration 和 thousand-book scan。实现者可以据此
在无 provider、无原始 batch catalog 的机器上构建导入验证。

# pass_fail

总体结论：部分通过。

R2 修订已经解决 R1 airgap import 审计的大多数阻塞点。离线闭包、manifest
权威、provider 隔离、失败关闭、路径可移植、离线兼容性、query-ready gates、
导入状态隔离和可实施测试均达到本基线要求。

唯一未完全通过项是 AIG-03。修订稿已经禁止依赖原始 batch catalog，并定义了
从 manifest 派生 catalog 的行为；但还没有把 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml` 和 `graph-capabilities.yaml` 的字段 schema 与字段
来源固定下来。该缺口可能导致实现者仍需参考旧 batch catalog 的实际形状，或在
不同 importer 中生成不兼容的派生 catalog。

# criteria_delta_from_r1

| id | R1 result | R2 result | delta |
| --- | --- | --- | --- |
| AIG-01 | 部分通过 | 通过 | 新增 package completeness、target layout、file checksum closure、readiness gates 后满足。 |
| AIG-02 | 通过 | 通过 | manifest authority 继续成立，并通过 mount scan transaction model 强化。 |
| AIG-03 | 部分通过 | 部分通过 | 行为已补足，但 derived catalog 字段映射仍不够显式。 |
| AIG-04 | 部分通过 | 通过 | security export 和 producer evidence redaction 解决 provider payload 边界。 |
| AIG-05 | 部分通过 | 通过 | atomic lifecycle、validation pipeline 和 projection commit 解决失败关闭。 |
| AIG-06 | 部分通过 | 通过 | package-relative path 与 path safety policy 已覆盖离线路径定位。 |
| AIG-07 | 部分通过 | 通过 | compatibility matrix 给出离线输入字段和决策结果。 |
| AIG-08 | 部分通过 | 通过 | qmd-ready 与 GraphRAG-ready gate 已结构化，最低 artifact closure 已列出。 |
| AIG-09 | 部分通过 | 通过 | external runtime layout 与 immutable package policy 明确了状态隔离。 |
| AIG-10 | 部分通过 | 通过 | 模块职责、生命周期步骤、错误分类和测试合同已足够实施。 |

# required_design_changes

1. 增加 `catalogProjectionSchema` 或等价设计块，逐一规定
   `books.yaml`、`sources.yaml`、`document-identity-map.yaml` 和
   `graph-capabilities.yaml` 的字段、required/optional 属性、字段来源和稳定排序
   规则。
2. 为 `document-identity-map.yaml` 固定离线 identity join contract，至少覆盖
   `bookId`、`sourceHash`、`normalizedHash`、qmd document id、GraphRAG document
   id、text unit 或 chunk locator、artifact hash、schema digest 和 package
   generation。
3. 规定 `graph-capabilities.yaml` 如何从 GraphRAG artifact schema、producer
   lineage、embedding profile、LanceDB schema digest、parquet schema digest 和
   readiness gate state 派生，避免读取原始 batch catalog。
4. 在 test contracts 中增加显式 airgap projection 测试：空 vault、无 provider、
   无原始 batch catalog，仅复制一个有效书包后，scanner 能从 manifest 和包内
   identity artifact 重建全部 derived catalog，并拒绝任何旧 catalog fallback。

# residual_risks

1. 若 derived catalog schema 继续留给实现细节，离线 importer 可能与历史 batch
   catalog 或其他 importer 产生不同字段形状，影响后续查询和迁移。
2. `qmd_graph_text_unit_identity.json` 已进入最低闭包，但其内部 schema 未在 Type DD
   中固定，仍可能随 qmd 或 GraphRAG 版本漂移。
3. producer evidence 脱敏边界已经明确；残余风险是摘要 evidence 可能足以 query-ready，
   但不足以支持深度调试或质量追溯，需要另行定义 redacted support bundle。
4. source-redacted mode 仍是开放问题。若包不含原始 EPUB，离线机器可以查询既有产物，
   但无法完整 rebuild source-derived artifacts。
5. direct directory copy 依赖 `PUBLISH_READY.json` 与 checksum 防止半复制挂载。
   实现仍必须防止 publish 后包目录被本机进程修改，否则只能通过下一次 scan
   的 checksum 失败进入 quarantine。
