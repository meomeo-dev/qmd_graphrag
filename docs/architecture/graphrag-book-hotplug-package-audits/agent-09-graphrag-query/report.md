# agent-09-graphrag-query 审计报告

## scenario

审计场景为：单本书包复制并挂载后，用户直接执行 GraphRAG 查询
(direct GraphRAG query after mount)。查询必须只依赖
`graph_vault/books/{bookId}` 下声明的包内 artifact、producer evidence 和必要的
本地投影。设计需要保证完整 producer lineage，并以 artifact gate 阻止缺失、
替换、过期、schema 不兼容或来源不明的 GraphRAG 产物进入 query-ready 状态。

本审计不读取 provider request、provider response、secrets、payload logs 或
recovery payload。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `direct_query_entrypoint`: 直接查询入口。
2. `artifact_minimum_closure`: 查询 artifact 最低闭包。
3. `artifact_gate_state_machine`: Artifact gate 状态机。
4. `producer_lineage_completeness`: Producer lineage 完整性。
5. `lineage_artifact_binding`: Lineage 与 artifact 绑定。
6. `schema_runtime_compatibility`: Schema 与运行时兼容。
7. `query_scope_isolation`: 单书查询范围隔离。
8. `privacy_payload_exclusion`: Provider payload 排除。
9. `recovery_diagnostics`: 失败恢复与诊断。
10. `executable_contract_tests`: 可执行契约测试。

## findings

### F1: 挂载权威清楚，但直接 GraphRAG 查询入口没有闭合

Type DD 明确 `BOOK_MANIFEST.json` 是单本书包挂载权威，并要求
`graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需文件。这为挂载后
查询建立了正确边界。

不足是 GraphRAG 查询入口没有被设计成可执行 contract。文档没有说明查询命令或
retrieval adapter 如何从 manifest 解析 `graphrag/output/`、LanceDB、parquet、
reports、stats、context/config 和 book-scoped scope。`mountLifecycle` 只说
“Book becomes query-ready”，但没有定义 query-ready 之后的 locator、参数、范围
过滤和错误返回。因此“挂载后直接查询”仍依赖实现者猜测。

### F2: Artifact gate 存在概念，但缺少最低 artifact 集合

Type DD 在 `graphrag.requiredFields` 中要求 `outputManifestPath`、`queryReady`、
`requiredArtifacts` 和 `producerRunIds`，并声明 GraphRAG output 和 producer
evidence 必须通过验证。这是 artifact gate 的正确起点。

缺口是最低 artifact 集合未枚举。设计没有明确哪些 parquet、embedding store、
LanceDB 目录、community report、entity/relationship/text-unit files、stats、
GraphRAG config、output manifest 或 prompt/context metadata 是直接查询的必要
条件。缺少该集合后，`requiredArtifacts` 只是字段名，不足以指导实现 gate、测试
损坏包或判断 GraphRAG-only 查询是否可用。

### F3: Producer evidence 目录被要求，但 producer lineage 不完整

目标布局要求 `graphrag/runs/` 作为 producer evidence，并在说明中列出
`graph_extract`、`community_report`、`embed`、`query_ready` 等 producer run
证据。该方向符合完整 lineage 的需求。

不足是 Type DD 未定义 run evidence schema。每个 artifact 应能追溯到 producer
run、step、输入文件 hash、上游 artifact hash、tool version、schema version、
生成时间和输出 hash。当前只要求 `producerRunIds`，无法证明某个 parquet 或
LanceDB segment 与对应 producer run 存在可验证绑定，也无法发现“旧 run 残留
artifact 被新 manifest 引用”的情况。

### F4: Lineage 与 files 闭包没有强绑定

`files` section 要求 package-relative path、role、bytes、sha256 和 required。
这能验证文件存在性和内容完整性。

但 files 闭包、`graphrag.requiredArtifacts`、`producerRunIds` 与
`graphrag/runs/` 之间没有规定交叉引用规则。实现者无法判断某个 required artifact
是否必须在 run evidence 中出现，也无法判断 run evidence 声明的 output 是否必须
进入 files 闭包。缺少双向绑定会让 artifact gate 只能做文件校验，不能做 lineage
校验。

### F5: 状态机不足，半包和不兼容包的 query 禁止条件不完整

文档已有若干失败策略：缺失文件、checksum mismatch 进入
`quarantine_mount_candidate`，不兼容 schema 为 `visible_not_query_ready`，复制
目录在 checksum sidecars 通过前被忽略。这些规则保护了 catalog projection。

不足是 artifact gate 状态机仍不完整。设计没有定义 copied、candidate、
manifest_validated、artifact_validated、lineage_validated、mounted、
query-ready、visible_not_query_ready、quarantined 等状态的顺序与转移条件，也未
说明 gate 失败时是否回滚已写 catalog、是否清理全局 qmd projection、是否允许
metadata-only 可见。直接 GraphRAG 查询需要比“挂载候选”更细的禁止查询状态。

### F6: Runtime/schema compatibility 过粗，无法可靠保护查询

`compatibility` 要求 `minQmdGraphRagVersion`、`graphRagArtifactSchema`、
`qmdIndexSchema` 和 `createdBy`，并要求不兼容包不能 query-ready。这个边界是必要
的。

不足是 `minQmdGraphRagVersion` 把多个兼容维度合并在一起。直接 GraphRAG 查询还
需要区分 GraphRAG runtime version、artifact schema、parquet schema、LanceDB
schema、embedding model identity、embedding dimension、tokenizer/context
settings、output manifest schema 和 package layout schema。任一维度不匹配都
可能导致查询结果错误或 runtime failure，不能只用一个版本字段表达。

### F7: 单书查询范围隔离原则有基础，但防串书规则不足

Type DD 将 package root 限定为 `graph_vault/books/{bookId}`，并要求文件条目不
能指向包外。这有助于防止查询读取 sibling roots。

缺口是 GraphRAG 查询上下文没有明确绑定 book identity。文档未规定 artifact 内部
的 document id、sourceHash、bookId、titleSlug 或 collection/table 名称必须与
manifest identity 匹配，也未规定全局 catalog 或 global retrieval projection 中
同名 collection 的隔离策略。若历史残留或其他书 artifact 被误引用，当前设计缺少
可测试的 cross-book contamination gate。

### F8: Provider payload 排除符合要求，但 lineage 证据的脱敏形态未定义

文档明确排除 provider 请求、响应、密钥和日志 payload，并说明 scanner failure
不得修改 provider payload roots。该规则符合本场景的隐私边界。

不足是 producer lineage 仍需要“足够证据”证明 artifact 来源。Type DD 没有说明
脱敏 run manifest 应保存哪些字段，例如 provider family、model identifier、
embedding dimension、input hash、output artifact hash、cost/token summary、
prompt template hash 或 redaction marker。若实现者为了补足 lineage 去读取
provider payload，会违反隐私边界；若完全不记录脱敏 metadata，则 lineage 不足。

### F9: `queryReady` 字段可能成为自声明，而非验证结果

Manifest schema 把 `queryReady` 放入 `graphrag.requiredFields`。这能表达导出者
对查询状态的声明。

风险是文档没有明确 `queryReady` 是导出时声明、挂载时重新计算的派生值，还是两者
都存在。对于外部复制包，接收方不能信任自声明 `queryReady: true`。artifact gate
应把 manifest 中的 `queryReady` 作为期望或导出证据，接收方 mount scan 必须重新
计算 effective query-ready，并把结果写入本地 import diagnostics 或 catalog
projection。

### F10: 测试契约覆盖主路径，但缺少 GraphRAG query gate 专项测试

现有 `testContracts` 包含复制有效目录、删除目录、隐私排除、冲突处理、
`reindex_on_mount` 和旧 manifest 迁移。这些测试适合热插拔基础行为。

缺少本场景的关键测试：挂载后直接 GraphRAG 查询成功；删除一个必要 parquet 后
not query-ready；替换 artifact 但保留文件名后 checksum fail closed；删除
producer evidence 后 lineage gate fail closed；schema/dimension 不兼容后
visible_not_query_ready；包内 artifact 指向其他 book id 后 quarantine；禁用
provider payload 后 gate 仍能完成。

## pass_fail

总体结论：部分通过（partial pass）。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `direct_query_entrypoint` | 未通过 | 挂载权威存在，但直接 GraphRAG 查询 locator、scope 和入口 contract 未定义。 |
| `artifact_minimum_closure` | 部分通过 | 有 `requiredArtifacts` 字段，但未列出最低查询 artifact 集合。 |
| `artifact_gate_state_machine` | 部分通过 | 有 checksum 和 quarantine 规则，但缺少 query gate 状态机。 |
| `producer_lineage_completeness` | 部分通过 | 要求 `graphrag/runs/` 和 producer run ids，但 lineage schema 不完整。 |
| `lineage_artifact_binding` | 未通过 | files、requiredArtifacts 和 producer evidence 缺少可验证双向绑定。 |
| `schema_runtime_compatibility` | 部分通过 | 有兼容字段，但版本维度过粗，不能保护 LanceDB/parquet/embedding 查询。 |
| `query_scope_isolation` | 部分通过 | 包内路径原则明确，但 artifact identity 和 cross-book contamination gate 不足。 |
| `privacy_payload_exclusion` | 通过 | provider payload、secrets 和 logs 明确排除，本审计未读取这些内容。 |
| `recovery_diagnostics` | 部分通过 | 有基础失败策略，但缺少 lineage/gate 失败的稳定诊断和回滚规则。 |
| `executable_contract_tests` | 部分通过 | 基础测试存在，缺少直接 GraphRAG 查询和 lineage/artifact gate 专项测试。 |

## required_design_changes

1. 定义 GraphRAG 直接查询 contract。说明 mount scan 后查询入口如何从
   BOOK_MANIFEST 解析 book-scoped GraphRAG context、output manifest、vector
   store、parquet roots、config/context 和 query scope。

2. 明确 GraphRAG query-ready 最低 artifact 集合。至少应列出 output manifest、
   entities、relationships、text units、communities、community reports、
   embeddings/vector store、stats、GraphRAG config/context 和必要 sidecars 的
   required 条件。

3. 将 `queryReady` 设计为接收方重新计算的 effective state。manifest 可保留导出
   时声明，但 mount scanner 必须基于 checksum、artifact schema、lineage 和 runtime
   compatibility 重新计算并写入本地 projection 或 import diagnostics。

4. 增加 artifact gate 状态机。状态应覆盖 copied、candidate、manifest_validated、
   artifact_validated、lineage_validated、mounted、query-ready、
   visible_not_query_ready 和 quarantined，并定义每个失败状态是否允许 metadata
   可见、是否允许查询、是否更新 catalog projection。

5. 定义 producer run evidence schema。每个 run 至少包含 runId、step、createdAt、
   tool name/version、schema version、input artifact hashes、output artifact
   hashes、sourceHash、bookId、redaction policy 和 provider payload exclusion
   marker。

6. 建立 lineage 与 artifact 的双向绑定。`requiredArtifacts` 中每个查询必需文件
   必须引用 producer evidence；producer evidence 中每个声明 output 必须能在
   files 闭包中找到同 path、bytes、sha256 和 role。

7. 拆分兼容性字段。将 `minQmdGraphRagVersion` 拆为 GraphRAG runtime、
   GraphRAG artifact schema、parquet schema、LanceDB schema、embedding model、
   embedding dimension、output manifest schema、package layout schema 和 migration
   capability。

8. 增加 cross-book contamination gate。校验 artifact 内部 bookId、sourceHash、
   document id namespace、collection/table namespace 与 manifest identity 一致；
   不一致时 quarantine 或 visible_not_query_ready。

9. 定义脱敏 lineage metadata。明确 artifact gate 所需 provider 相关证据只能来自
   脱敏 metadata、hash、model identifier 和 dimension，不得要求读取 provider
   request/response payload。

10. 补充专项测试契约。新增挂载后直接 GraphRAG 查询、必要 artifact 缺失、artifact
    替换、producer evidence 缺失、lineage/hash mismatch、schema 不兼容、跨书污染、
    provider payload 不读取和 queryReady 重算的自动化测试。

## residual_risks

- 即使 lineage 和 checksum 完整，GraphRAG runtime 对旧 parquet 或 LanceDB 的兼容
  行为仍可能随依赖升级漂移，需要保留 migration 或 rebuild 路径。
- embedding model 名称相同不一定代表向量空间完全一致；设计仍需决定是否记录更
  强的 model fingerprint 或 provider-independent embedding profile。
- 直接查询依赖本地 projection 时，projection 写入失败可能让包已 mounted 但不可
  查询，需要用户可理解的诊断和重试入口。
- source-redacted package 若只保留 normalized input 和 GraphRAG output，lineage
  能证明 artifact 来源，但无法重新运行全部 producer steps。
- artifact gate 越严格，历史包迁移失败率越高；需要显式区分 migration repair、
  readonly query 和 quarantine 三类用户体验。
