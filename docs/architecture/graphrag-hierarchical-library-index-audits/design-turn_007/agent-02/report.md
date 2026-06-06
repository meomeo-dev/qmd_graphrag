# design-turn_007 agent-02 设计接地性复审报告

overallStatus: pass

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 复审以下设计集：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-grounding-review.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

复审重点为代码落地性（implementation grounding）：既有代码支撑是否被准确
描述，待实现缺口是否被准确标注，以及是否引入不合理依赖或过度抽象。

## 总体结论

设计集通过本轮接地性复审。文档对现有实现边界的描述成立：当前代码已有
单书 hotplug package 发布与校验、包内 qmd index、catalog projection、单书
GraphRAG 查询、query timing 和 provider runtime metrics。文档也准确标注了
书架与 library 能力仍未实现，包括 `--bookshelf-id`、`--library-id`、`qmd
library list/build/status/rebuild`、`upper_index_*` typed errors、
`BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、upper `semantic_units`、
`semantic_edges` 与 `evidence_map` builder。

未发现把设计能力误写为现有代码能力的问题。未发现新增不合理依赖；设计把
上层索引限定为复用现有 manifest validator、catalog projection、GraphRAG
artifact contract、typed query contract 和 timing 机制的独立 upper-index
模块，抽象边界与当前代码结构相容。后续实现仍需避免把书架/library 逻辑
继续并入已经较长的 `src/cli/qmd.ts` 主文件。

必须修订位置：无。

## D01_authority_boundaries

status: pass

依据：设计保持 `graph_vault/books/{bookId}/BOOK_MANIFEST.json` 与
`PUBLISH_READY.json` 为单书包权威，并把书架/library 索引放在
`graph_vault/catalog/**` 下作为可重建派生物。现有代码与该边界一致：
`src/graphrag/book-hotplug-package-validator.ts` 以 `BOOK_MANIFEST.json`、
`PUBLISH_READY.json`、checksum sidecar 和包内文件闭包判定包有效；
`src/graphrag/book-hotplug-package-projection.ts` 只有在 manifest、publish
marker、boundary validation 和 runtime gate 通过后才投影单书；catalog 代码
只生成投影，不改变单书包文件闭包。

接地性判断：文档准确说明单书 query-ready 不依赖书架或 library 索引，且
删除或损坏 catalog 上层索引不会改变单书挂载状态。

## D02_fixed_query_budget

status: pass

依据：设计为上层交互查询定义固定 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数和 token 上限，
并禁止查询时全量扫描所有单书 `community_reports`。当前代码只支持单书
GraphRAG scope：`src/cli/qmd.ts` 暴露 `--graph-book-id`，并在选择 GraphRAG
route 后要求 `selectedBookIds.length === 1`。不存在已经实现的跨书全量扫描
路径。

接地性判断：固定预算是待实现上层查询的正确合同，没有把当前单书查询误称
为跨书固定预算能力。缺失 `--bookshelf-id` 与 `--library-id` 被明确列为
new capability，标注准确。

## D03_graphrag_semantic_alignment

status: pass

依据：设计的上层输入包含单书 `community_reports.parquet`、`entities.parquet`、
`relationships.parquet` 和受控 `text_units.parquet`，输出包含
`semantic_units.parquet`、`semantic_edges.parquet`、`communities.parquet` 与
`community_reports.parquet`。现有单书包发布脚本
`scripts/graphrag/book-hotplug-package.mjs` 把上述 GraphRAG artifacts 列为包内
必需产物，`src/graphrag/capability-catalog.ts` 也把 `community_reports` 作为
Graph capability 之一投影。

接地性判断：上层设计没有退化为普通摘要检索；它从现有 GraphRAG artifact
合同延展 entity、relationship、community report 和 map-reduce 语义。相关
builder 尚未实现，grounding review 已准确标为 new capability。

## D04_evidence_traceability

status: pass

依据：设计定义 `evidence_map.parquet`，要求上层 semantic unit、semantic
edge、community 和 community report 回链到 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report 或 text unit。现有单书查询
合同已有 evidence 字段，`src/contracts/unified-query.ts` 的 `EvidenceRefSchema`
包含 `sourceId`、`documentId`、`contentHash`、`bookId`、`graphTextUnitId` 和
`artifactId`。catalog capability projection 也维护 `bookId`、`sourceId`、
`documentId`、`contentHash` 与 artifact ids。

接地性判断：证据追溯设计与现有 evidence/capability 字段相容。upper
`evidence_map` writer 尚不存在，文档已将其列为缺口，描述准确。

## D05_state_recovery

status: pass

依据：设计要求上层构建具备 durable checkpoints、events、status、staging、
quality gate、publish marker、stale 检测和 partial publish 防护。现有单书
hotplug 与 job-state 代码已经具备相似模式：单书包有 manifest sidecar、
publish marker、runtime gate、artifact validation 与 run/checkpoint 记录；
pipeline I/O 把这些模式扩展到书架/library，并要求 staged artifacts 通过
schema、checksum、敏感扫描、质量门和固定预算模拟后才能发布。

接地性判断：状态闭环不是凭空引入的新范式，而是沿用现有 durable state 与
manifest-first 验证风格。上层状态机仍为待实现能力，文档未误标为已有。

## D06_quality_gates

status: pass

依据：设计分别定义 bookshelf quality gate 与 library quality gate，覆盖
schema、checksum、成员 manifest 一致性、membership authority、LLM
suggestion acceptance、虚拟父书架、direct book limit、fixed budget
simulation、敏感扫描和 stale marker。现有代码已有单书 gate 基础：
`book-hotplug-package-validator.ts` 检查敏感路径、manifest、publish marker、
checksum 和包闭包；`book-hotplug-runtime-gate.ts` 被 projection 和 catalog
路径调用以校验 query runtime。

接地性判断：上层质量门以现有单书质量门为基础扩展，且文档明确
`BOOKSHELF_MANIFEST`、`LIBRARY_MANIFEST` 与上层质量门尚未实现。缺口标注
准确。

## D07_incremental_scaling

status: pass

依据：设计要求记录成员 `manifestSha256`、`packageGeneration`、builder/config
fingerprint 与 generation，并用书架分层、虚拟父书架、物化子书架、library
partition 和 checksum-based incremental refresh 限制大库刷新影响范围。现有
catalog projection 已记录 `packageGeneration`、`manifestSha256`、
`qmdReadyState`、`qmdIndexSchema` 和 package root；这些字段足以作为上层成员
generation 的输入基础。

接地性判断：增量扩展设计建立在当前 manifest sha 与 package generation
字段之上。书架 membership resolver、split planner 和 incremental refresh
实现尚不存在，文档已正确列为 direct extension 或 new capability。

## D08_security_privacy

status: pass

依据：设计禁止 provider payload、raw prompt、raw completion、密钥、绝对
路径和 query log 进入可发布上层 manifest、索引、质量门或诊断。现有单书包
validator 已有 forbidden package path patterns，覆盖 `.env`、provider
requests/responses、logs、debug、trace、lock 和 corrupt residue。hotplug
发布脚本也通过包相对路径、checksum sidecar 和 redaction status 表达可发布
状态。

接地性判断：上层 sensitivity policy 与现有包边界一致，且 pipeline I/O 明确
禁止 runner ledger 作为语义输入。未发现设计要求引入会扩大敏感面或供应链面
的新依赖。

## D09_cli_operability

status: pass

依据：设计定义 scope resolution order、typed errors、exit codes、
remediation commands、CLI behavior matrix 和分层 timing fields。现有 CLI
代码只支持 `--graph-vault`、`--graph-book-id`、`--query-method`、
`--response-type`、`--community-level`、`--python-bin` 与 `--timing`；未暴露
`--bookshelf-id`、`--library-id` 或 `qmd library` 子命令。现有
`TypedQueryErrorSchema` 允许 string code，但实际 router 只实现
`capability_missing`、`capability_catalog_unreadable`、`provider_unavailable`、
`provider_response_invalid`、`ambiguous_graph_book_scope` 等单书/通用错误。

接地性判断：grounding review 对缺失的 `--bookshelf-id`、`--library-id`、
`qmd library list/build/status/rebuild` 和 `upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed` typed error mapping 的判断
准确。设计未误称当前 CLI 已具备上层 scope 操作能力。

## D10_testability

status: pass

依据：主设计和 pipeline I/O 均列出超过 8 个 required cases，覆盖固定预算、
不同规模库模拟、单书 hotplug 非回归、缺上层索引、stale、质量门失败、
证据图、安全扫描、中断恢复、LLM suggestion gate、membership 权威和 direct
book limit。现有代码层面尚未发现上层 bookshelf/library 测试或实现模块；
这与文档把上层 builder、manifest、CLI scope 和 typed errors 列为后续实现
合同相一致。

接地性判断：测试合同覆盖代码落地风险，尤其包含删除 catalog 上层索引不影响
单书 query、缺 upper index 不在查询路径隐式重建、10/100/1000 书固定预算
模拟等关键非回归。无需新增 D10 修订项。

## 代码落地专项结论

- 单书 hotplug package：支撑准确。发布脚本和 validator 均以
  `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd artifacts 与 GraphRAG
  artifacts 为边界。
- 包内 qmd index：支撑准确。`book-hotplug-qmd-index.mjs` 生成
  `qmd/index/qmd_book_index.sqlite` 与 `qmd/qmd_build_manifest.json`，validator
  将其列入 required artifacts。
- catalog projection：支撑准确。catalog 代码可从已验证单书包投影 books、
  qmd projection、document identity 与 graph capability，并记录
  `manifestSha256` 和 `packageGeneration`。
- GraphRAG 单书查询：支撑准确。CLI 与 router 支持 `--graph-book-id` 的单书
  GraphRAG route，并通过 capability catalog 选择 graph-ready book。
- timing：支撑准确。`QueryTimingRecorder` 提供 stage timing；GraphRAG runtime
  metrics 可报告 provider stages、model calls、tokens 与 retry 统计。
- 上层缺口：标注准确。源码中未见 `BOOKSHELF_MANIFEST`、
  `LIBRARY_MANIFEST`、upper `semantic_units`/`semantic_edges`/`evidence_map`
  builder、`--bookshelf-id`、`--library-id`、`qmd library` 子命令或稳定
  `upper_index_*` typed error 分支。

## 必须修订项

无。
