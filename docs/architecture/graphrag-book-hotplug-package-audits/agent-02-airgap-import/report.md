# scenario

离线机器导入书包。导入机器只能接收
`graph_vault/books/{bookId}` 书包目录，不能访问 provider，不能读取或依赖
原始 batch catalog。导入后的系统必须能仅凭书包 manifest 和包内文件完成
验证、catalog 投影、索引投影或本地重建，并给出 query-ready 判定。

# fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

| id | name | result |
| --- | --- | --- |
| AIG-01 | 离线闭包完整性 | 部分通过 |
| AIG-02 | 挂载权威唯一性 | 通过 |
| AIG-03 | 原始 batch catalog 独立性 | 部分通过 |
| AIG-04 | Provider 隔离 | 部分通过 |
| AIG-05 | 校验与失败关闭 | 部分通过 |
| AIG-06 | 路径可移植性 | 部分通过 |
| AIG-07 | 离线兼容性判定 | 部分通过 |
| AIG-08 | 查询就绪门槛 | 部分通过 |
| AIG-09 | 导入状态隔离 | 部分通过 |
| AIG-10 | 可实施流程与测试 | 部分通过 |

# findings

## F-01 离线闭包方向正确，但闭包清单仍不够可执行

Type DD 明确 `graph_vault/books/{bookId}` 是权威根目录，并要求包内包含
validate、query、export、remount 所需文件。这满足离线导入的核心方向。
但 `files.required` 只规定每项有 `path`、`role`、`bytes`、`sha256` 和
`required`，没有定义目录递归、空目录、sidecar、LanceDB 多文件目录、
parquet 分区目录、封面等复合产物如何进入闭包。

离线导入实现若只按文件列表校验，可能无法判定 GraphRAG 输出目录是否缺失
内部 shard、索引元数据或上下文文件。设计需要把 file closure 扩展为可验证
的 artifact closure（产物闭包），至少定义目录型 artifact 的枚举规则、
必需模式和禁止模式。

## F-02 不依赖原始 batch catalog 的原则明确，重建字段不足

文档声明 catalog 与全局索引是可重建投影，mount scanner 的输入仅为
`books/*/BOOK_MANIFEST.json`。这符合 airgap 导入原则。

不足是 derived catalog 的字段来源没有完全映射。`books.yaml`、
`sources.yaml`、`document-identity-map.yaml` 和
`graph-capabilities.yaml` 应由 manifest 哪些字段生成尚未定义。尤其是
document identity 需要 sourceHash、normalizedHash、GraphRAG document id、
qmd document id、chunk id 或 stable locator 的关系；当前 manifest schema
没有显式要求这些离线重建字段。

## F-03 Provider payload 排除明确，但 provider 不可达时的行为未闭合

scope 和 exclusions 明确排除 provider 请求、响应、密钥、日志 payload。
这是必要条件。

矛盾点在于 GraphRAG 的 `producerRunIds` 和 `producer evidence` 被列为
query readiness 条件，但设计没有说明这些 evidence 是否必须只包含无
provider payload 的摘要证据。若 evidence 需要引用 provider 响应路径、
token 日志或外部 run payload，离线导入会无法校验。Type DD 还需要声明
provider 不可达不是导入失败原因；只有缺少已声明的包内 artifact 或
sanitized evidence 才导致 not query-ready。

## F-04 路径边界有要求，但 package-relative 规则需要更硬

`files.contract` 要求条目不得指向书包外，source/input contract 也将外部
路径降级为 provenance 或 compatibility metadata。这是正确约束。

遗漏是 manifest 其他字段未统一受 package-relative 约束，例如
`mount.packageRoot`、`qmd.buildManifestPath`、`graphrag.outputManifestPath`、
`source.sourcePath`、`input.canonicalNormalizedPath`、producer run locator
和 metadata 引用。离线机器上绝对路径或旧 batch 路径不可用，Type DD 应
统一规定所有可定位字段必须是 package-relative，并定义拒绝 `..`、
symlink escape 和 absolute path 的验证规则。

## F-05 校验顺序合理，但原子导入和部分投影回滚未定义

文档要求 manifest 与 checksum 通过后才能投影 catalog，并把缺文件、
checksum mismatch 和 schema 不兼容映射为 quarantine 或 not query-ready。

不足是离线导入的原子性（atomicity）未定义。若扫描过程中部分写入
`catalog/books.yaml` 后发现后续索引失败，设计没有说明 catalog、qmd 投影
和 retrieval projection 如何回滚或以 generation 方式替换。airgap 导入常见
输入是手工复制目录，必须避免半挂载状态变成可查询状态。

## F-06 qmd 索引缺失时允许重建，但离线重建前提不完整

Type DD 允许缺少 book-scoped qmd index 时通过 `reindex_on_mount` 本地重建。
这适合离线导入。

问题是 qmd 重建需要的最低输入没有完全列明。除 normalized input 外，还可能
需要 qmd build manifest、parser/version config、document identity seed、
chunking 参数、embedding 或检索 schema。若这些参数来自原始 batch catalog
或 runner 配置，离线机器无法复现。设计应把 qmd 重建配置纳入 manifest 或
包内 `qmd/build_manifest` 的必需闭包。

## F-07 GraphRAG query-ready 条件存在，但 artifact gate 不够细

文档要求 GraphRAG output 在 `graphrag/output/`，producer evidence 在
`graphrag/runs/`，并声明 query readiness 需要完整 GraphRAG output。

不足是 `requiredArtifacts` 未定义 artifact 类型、schema、最低文件集和
验证方法。GraphRAG 查询常依赖 parquet 表、LanceDB 索引、reports、stats
和上下文文件；Type DD 需要给出 query-ready artifact gate 的结构化规则，
否则实现者只能写路径存在性检查，无法保证离线导入后可查询。

## F-08 兼容性字段存在，但缺少离线决策矩阵

`compatibility.requiredFields` 包含 `minQmdGraphRagVersion`、
`graphRagArtifactSchema`、`qmdIndexSchema` 和 `createdBy`。这为离线版本
判定提供基础。

遗漏是没有定义本机版本低于、等于、高于、不认识 schema、可迁移 schema 的
决策矩阵。离线机器无法联网获取迁移规则，因此 Type DD 应要求包内包含
schema compatibility declaration，或规定 importer 内置表如何把候选包分为
mounted_query_ready、mounted_reindex_required、visible_not_query_ready 和
quarantine。

## F-09 import/ 与 state/ 已分层，但校验排除边界不清

目标布局包含 `import/` 作为 mount 状态和诊断目录，`state/` 作为 runner
state。`mount.contract` 也说明 writable runtime state 应隔离并默认排除
package checksum。

不清楚的是 `import/` 初始是否属于导出包、导入后生成的诊断是否会改变书包
校验、`state/` 下哪些文件是 versioned evidence、哪些是 runtime local state。
离线导入实现需要明确 immutable package area 与 mutable local area 的边界。

## F-10 实施模块方向可行，但测试合同不足以覆盖 airgap

implementationPlan 给出 manifest、scanner、export、import 四个模块，方向
可实施。testContracts 覆盖复制、删除、provider payload 排除、冲突和
reindex_on_mount。

测试遗漏是没有专门覆盖空 vault、无 provider、无原始 batch catalog 的导入。
还缺少使用 package manifest 重建全部 catalog projection、拒绝绝对路径、
拒绝 symlink escape、provider evidence sanitized、GraphRAG artifact gate
失败不投影 query-ready 的测试。

# pass_fail

总体结论：部分通过。

Type DD 对 airgap 导入的核心原则是正确的：书包根目录是权威边界，
`BOOK_MANIFEST.json` 是挂载权威，catalog 和全局索引是可重建投影，provider
payload 被排除，失败关闭策略也已出现。

未达到完全通过的原因是：离线机器所需的 manifest 字段映射、artifact
closure、目录型产物校验、provider 不可达决策、兼容性矩阵、原子投影和
mutable state 边界仍不够具体。当前设计可指导方向，但不足以让实现者在没有
provider、没有原始 batch catalog 的空 vault 上稳定实现导入。

# required_design_changes

1. 增加 airgap import contract，明确导入输入只能是书包目录和本机 importer
   版本，不允许读取 provider、原始 batch catalog 或 sibling roots。
2. 扩展 `bookManifestSchema.files` 为 artifact closure，定义普通文件、
   目录型 artifact、sidecar、parquet 分区、LanceDB 目录和禁止路径的校验
   规则。
3. 为每个 derived catalog 输出定义 manifest 字段映射，特别是
   document identity、source identity、GraphRAG document id、qmd document
   id 与 chunk locator 的离线重建规则。
4. 统一规定所有 locator 字段必须 package-relative；绝对路径、`..`、
   symlink escape 和旧 batch root 只能作为 provenance，不能用于导入定位。
5. 定义 sanitized producer evidence schema，禁止 provider payload 引用成为
   query-ready 必需条件，并说明 provider 不可达时的状态转换。
6. 细化 GraphRAG query-ready artifact gate，列出最低 artifact 类型、schema
   字段、校验方式和失败后的 visible_not_query_ready 行为。
7. 细化 qmd `reindex_on_mount` 所需闭包，把 parser、chunking、identity seed、
   schema 和 build config 固定在 manifest 或包内 build manifest 中。
8. 增加离线兼容性决策矩阵，覆盖本机版本过低、schema 未知、schema 可迁移、
   索引需重建和 GraphRAG artifact 不兼容。
9. 定义 import 原子性：catalog 与索引投影应使用 generation/staging 后替换，
   任何失败不得留下 query-ready 半状态。
10. 明确 `import/`、`state/` 和 `state/runtime` 的可变性、checksum 排除边界
    与导出时是否携带。
11. 增加 airgap 专项测试合同，覆盖空 vault 导入、无 provider、无原始 batch
    catalog、路径逃逸、symlink、损坏目录 artifact 和 query-ready gate。

# residual_risks

1. GraphRAG 与 qmd 的实际 artifact schema 可能随版本变化，若没有稳定的包内
   schema 声明和 importer 兼容表，离线导入仍可能只能做弱校验。
2. 若 producer evidence 过度脱敏，可能不足以解释查询质量或生成 lineage；
   若保留过多 evidence，则有泄露 provider payload 的风险。
3. source-redacted mode 仍是开放问题；若不随包携带原始 EPUB，部分重建和许可
   审计能力会下降。
4. 大型 LanceDB 或 parquet 目录的完整校验成本可能较高，需要在安全性与导入
   性能之间定义可接受策略。
5. 手工复制包目录时仍可能出现半复制窗口；即使 Type DD 定义 quarantine，
   实现也需要 staging 或 ready marker 才能避免 scanner 抢先读取。
