# design-turn_007 agent-01 设计接地性复审报告

overallStatus: pass

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 执行接地性复审。审计对象为：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-grounding-review.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

本轮重点核对当前设计是否脱离现有代码和前序单书 hotplug package
设计基础，尤其核对 `implementationGrounding` 与
`currentImplementationStatus` 是否正确区分 `already_supported`、
`direct_extension`、`new_capability`，以及是否把 bookshelf/library
builder、upper CLI scope、`BOOKSHELF_MANIFEST`、`LIBRARY_MANIFEST`
误写为当前已实现能力。

## 接地性总判定

当前设计集通过接地性复审。设计没有把书架或 library 能力误表述为
现有代码能力；相反，主设计和 pipeline I/O 均明确把上层 manifest、
membership resolver、materialized bookshelf builder、library builder、
upper semantic artifacts、upper quality gates、`--bookshelf-id`、
`--library-id`、`qmd library list/build/status/rebuild` 和 upper typed
errors 标为待实现能力。

代码抽查结论与文档声明一致：

- `src/cli/qmd.ts` 当前只暴露 `--graph-book-id`、`--graph-vault`、
  `--query-method` 等单书 GraphRAG 查询参数；未实现 `--bookshelf-id`、
  `--library-id` 或 `qmd library ...` 命令。
- `src/cli/qmd.ts` 在多本 graph-ready 书匹配时返回
  `ambiguous_graph_book_scope`，要求使用 `--graph-book-id`，说明当前 CLI
  仍是单书 GraphRAG scope，而非上层 bookshelf/library scope。
- `src/graphrag/book-hotplug-catalog.ts` 以 `BOOK_MANIFEST.json` 与
  `PUBLISH_READY.json` 为包挂载输入，并生成 catalog projection；该能力
  支撑 bookshelf membership 的直接扩展，但不是 bookshelf builder 实现。
- `src/contracts/unified-query.ts` 的 typed error code 当前是开放字符串；
  设计列出的 `upper_index_missing`、`upper_index_stale` 等稳定分支仍未在
  代码中实现。grounding review 将其列为 missing implementation 是正确的。
- 在 `src/`、`scripts/`、`test/` 范围内未发现 `BOOKSHELF_MANIFEST`、
  `LIBRARY_MANIFEST`、`--bookshelf-id`、`--library-id` 或 upper index
  builder 的实现痕迹。

前序单书 hotplug package R6 复审已确认 `BOOK_MANIFEST.json`、包内 qmd
index、包内 GraphRAG output、manifest-first direct query 和包内质量门为
已通过设计基础。当前层级设计把这些作为输入边界，并把上层索引限定为
`graph_vault/catalog/**` 下的可重建派生物，未改变前序设计权威模型。

## D01_authority_boundaries

status: pass

依据：主设计的 `hardInvariants.book_package_authority_preserved` 和
`derived_upper_indexes_only` 保持单书包 `BOOK_MANIFEST.json`、
`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物为单书权威。书架与
library 的根目录均在 `graph_vault/catalog/**`，并被声明为可重建派生物。
pipeline I/O 的 `package_first_authority`、`catalog_is_derivative` 和
`book_mount_projection` 也明确 catalog 不改变单书身份、文件闭包或单书
query_ready 判定。

接地性核对：现有代码确有单书 manifest、publish marker、catalog projection
和单书 GraphRAG 查询基础；未发现上层索引回写单书包的实现或设计要求。
`implementationGrounding.newCapabilities` 明确把 `BOOKSHELF_MANIFEST`、
`LIBRARY_MANIFEST` 和上层 CLI scope 归为新能力，未误写为已实现。

必须修订位置：无。

## D02_fixed_query_budget

status: pass

依据：主设计的 `queryContract.interactiveBudget` 固定
`maxSemanticUnits`、`maxBookshelves`、`maxBooksForDeepening`、
`maxMemberCommunityRefs`、LLM 调用数和 token 上限，并要求超预算时
fail closed 或要求收窄 scope。pipeline I/O 的
`scoped_query_execution.forbiddenInputs` 禁止 query path 中缺索引自动构建、
stale scope 和交互式 all-books scan。

接地性核对：当前代码只有单书 GraphRAG scope，尚不存在上层固定预算
retrieval。因此设计把 bookshelf/library scoped query execution 标为
`newCapabilities` 是正确的；固定预算是待实现合同，不是当前能力声明。

必须修订位置：无。

## D03_graphrag_semantic_alignment

status: pass

依据：书架构建输入包含成员 `community_reports.parquet`、`entities.parquet`
和 `relationships.parquet`，library 构建输入包含书架 semantic units、
semantic edges、community reports 和 evidence map。主设计定义
`semantic_units.parquet` 与 `semantic_edges.parquet`，保留 entity、
relationship、community、membership 和 generation 关系，避免退化为普通
摘要检索。

接地性核对：前序单书 hotplug 设计与现有代码已经围绕包内 GraphRAG output
建模；上层 GraphRAG builder 尚未实现。grounding review 将
`materialized_bookshelf_graph_build` 与 `library_graph_build` 标为
`new_capability`，同时禁止 runner ledger 作为语义输入，接地边界正确。

必须修订位置：无。

## D04_evidence_traceability

status: pass

依据：主设计定义 `evidence_map.parquet`，字段覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report、text unit、artifact digest
和 generation。质量门要求每个上层 semantic unit、semantic edge、community
和 community report 至少回链到下层证据。pipeline I/O 要求查询输出
evidence lineage，并且只引用已发布 artifact。

接地性核对：现有 unified query 合同已支持 `bookId`、`sourceId`、
`documentId`、`contentHash`、`graphTextUnitId` 和 `artifactId` 等证据字段。
上层 `evidence_map.parquet` 仍属于新产物；设计没有把它误称为当前代码已
发布或已查询的文件。

必须修订位置：无。

## D05_state_recovery

status: pass

依据：主设计定义上层 `runs/{runId}`、`events.jsonl`、`status.json`、
`checkpoints/{unitId}.json`、`recovery-summary.json`、staging publish
protocol 和 stale behavior。pipeline I/O 要求 staged artifacts 完成 schema、
checksum、敏感扫描、质量门和固定预算模拟后才能提升为 current generation，
publish marker 最后写入，failed 或 partial build 不会成为 query-ready。

接地性核对：仓库已有 durable state、artifact validation、runner ledger
和 hotplug gate 模式，可作为实现模式基础；但上层 build state 尚未实现。
pipeline I/O 没有把 bookshelf/library 恢复闭环写成当前已存在能力。

必须修订位置：无。

## D06_quality_gates

status: pass

依据：主设计分别定义 `qualityGates.bookshelfGate` 与
`qualityGates.libraryGate`。书架门覆盖 manifest schema、成员 manifest
sha256、包 gate、membership authority、用户 lock、LLM suggestion 接受状态、
虚拟父书架、semantic schema、evidence map、embedding metadata、固定预算
模拟、敏感扫描和 stale marker。library 门覆盖成员书架 checksum、成员
书架 gate、direct book limit、partition、semantic schema、evidence map、
固定预算模拟、敏感扫描和 stale marker。

接地性核对：现有代码支持单书 hotplug quality/runtime gate；不支持上层
quality gate。`currentImplementationStatus.alreadySupported` 只列出
`book_package_publish`、`book_mount_projection` 和单书 scoped query，
没有把 bookshelf/library gate 误列为已支持。

必须修订位置：无。

## D07_incremental_scaling

status: pass

依据：主设计要求书架与 library generation 记录成员 manifest sha256、
package generation、builder version、embedding model fingerprint、clustering
config、summary config 和 evidence schema。书架与 library 均定义基于
checksum 的增量刷新；无法证明局部不变时，保守重建或标记 stale。超大
书架通过虚拟父书架和物化子书架拆分，library 通过书架分层、direct book
limit 和 partition 限制影响范围。

接地性核对：单书包 manifest sha256 和 package generation 是已有基础。
bookshelf membership resolver 被标为 `directExtensions`，materialized
bookshelf graph build 和 library build 被标为 `newCapabilities`，扩展层级
与当前代码边界匹配。

必须修订位置：无。

## D08_security_privacy

status: pass

依据：主设计的 `no_sensitive_payload_export`、
`diagnosticRedactionPolicy`、manifest `sensitivityPolicy` 和 pipeline I/O 的
`redacted_diagnostics_only` 均禁止 provider payload、raw prompt、raw
completion、密钥、credential、绝对本地路径和 query log 进入上层 manifest、
索引、质量门或诊断。诊断只允许 digest、schema id、check id、bounded
summary 和 scope-relative locator。

接地性核对：前序单书 hotplug 设计已把分发安全和 manifest 敏感字段作为
通过项。当前层级设计继承该边界，并额外禁止 runner ledger 和 provider
runtime material 作为上层语义输入；未发现将敏感运行产物纳入
`BOOKSHELF_MANIFEST` 或 `LIBRARY_MANIFEST` 的设计表述。

必须修订位置：无。

## D09_cli_operability

status: pass

依据：主设计定义 scope resolution order、typed query error schema、退出码、
remediation command、CLI behavior matrix 和分层 timing fields，覆盖无
scope、scope 歧义、缺索引、stale、质量门失败和超预算。pipeline I/O 的
`scoped_query_execution.failureOutputs` 与主 typed errors 对齐，包含
`missing_scope`、`ambiguous_scope`、`upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed` 和
`budget_exceeded_narrow_scope_required`。

接地性核对：当前 CLI 只实现单书 `--graph-book-id` GraphRAG 查询；未实现
`--bookshelf-id`、`--library-id` 或 `qmd library list/build/status/rebuild`。
grounding review 将这些列为 missing implementation 和 new capability，
并指出现有 `TypedQueryErrorSchema` 只允许 string code、尚无稳定 upper
error code 分支。该区分准确，未把 upper CLI scope 误写成已实现能力。

必须修订位置：无。

## D10_testability

status: pass

依据：主设计与 pipeline I/O 的 `testContracts.requiredCases` 均超过 8 个
必测案例，覆盖 10/100/1000 书固定预算验证、单书 hotplug 非回归、
catalog 上层索引删除不影响单书查询、缺上层索引不隐式构建、stale 默认
拒绝、质量门失败、证据图、semantic edges、安全扫描、中断恢复、LLM
suggestion gate、membership authority、超大分类拆分、虚拟父书架和 direct
book limit。

接地性核对：测试合同把 bookshelf/library 能力作为后续实现和非回归验证
对象，没有声称现有测试已覆盖上层 builder 或 upper CLI scope。接地性文档
还建议先实现 schema validators、fixtures、list/status 命令和 upper typed
error mapping，再实现 builder；该实施顺序与当前代码状态一致。

必须修订位置：无。

## 必须修订位置

无。
