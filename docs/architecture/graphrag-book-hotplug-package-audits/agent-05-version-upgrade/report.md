# agent-05-version-upgrade 审计报告

## scenario

旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema。输入可能是当前
`distribution_manifest.json` 书目录、历史不完整 book 目录、旧 qmd index、旧
GraphRAG output 布局，或未来旧版 `BOOK_MANIFEST.json`。目标是升级为新
`BOOK_MANIFEST.json` 权威包，并在兼容时成为 query-ready。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `legacy_version_detection`: 旧版本识别。
2. `migration_path_matrix`: 升级路径矩阵。
3. `artifact_schema_conversion`: Artifact schema 转换。
4. `identity_stability`: 身份稳定性。
5. `checksum_reclosure`: 校验闭包重建。
6. `rollback_atomicity`: 原子升级与回滚。
7. `compatibility_diagnostics`: 兼容诊断。
8. `producer_lineage_preservation`: Producer lineage 保全。
9. `privacy_preservation`: 隐私排除保持。
10. `upgrade_testability`: 升级可测试性。

## findings

### F1: Type DD 有迁移入口，但没有跨版本升级矩阵

文档已定义从当前 `distribution_manifest.json` 到 `BOOK_MANIFEST.json` 的迁移规则，
包括移动 source、GraphRAG output、producer run evidence、state 文件，以及重建
package-relative file entries 和 checksums。这能覆盖当前完成书目录到热插拔包的
初始升级。

不足是它只描述“当前 distribution manifest”到新布局的一条路径，没有定义旧
`BOOK_MANIFEST.json`、旧 `layoutVersion`、旧 `graphRagArtifactSchema`、旧
`qmdIndexSchema` 或历史不完整目录的版本矩阵。跨版本升级需要知道哪些版本可直接
重写、哪些必须重建、哪些只能 visible_not_query_ready、哪些必须 fail closed。

### F2: 兼容字段存在，但粒度不足以驱动 artifact schema 升级

`compatibility` section 要求 `minQmdGraphRagVersion`、
`graphRagArtifactSchema`、`qmdIndexSchema` 和 `createdBy`，并声明不兼容包不能投影
为 query-ready。这个方向正确。

缺口是 `minQmdGraphRagVersion` 把多个兼容面合并到一个字段。qmd CLI、qmd index
schema、GraphRAG parquet schema、LanceDB schema、embedding dimension、embedding
model identity、manifest schema 和迁移工具能力可能分别兼容或不兼容。若不拆分，
升级器无法判断是转换 artifact、重建 index、降级为不可查询，还是拒绝升级。

### F3: GraphRAG artifact 转换策略未定义

文档要求 GraphRAG output 位于 `graphrag/output/`，producer evidence 位于
`graphrag/runs/`，并要求 query readiness 通过验证。但跨版本场景下，旧 parquet、
LanceDB、reports、stats 和上下文文件是否可原样搬迁没有规则。

如果 GraphRAG artifact schema 改变，设计没有说明 artifact 应被 schema-aware
converter 重写、从 normalized input 重新运行 producer、仅保留为 legacy evidence，
还是标记为 incompatible。缺少该策略会导致升级实现只能做目录搬迁，无法保证新
schema 下查询语义正确。

### F4: qmd index 升级状态机不完整

Type DD 允许包内 qmd index 缺失时声明 `reindex_on_mount`，这对旧 index schema
不兼容很有用。

但文档没有定义旧 qmd index 存在但 schema 过旧时的行为。它是删除并重建、保留为
legacy evidence、写入新 index，还是让整包 not query-ready，均未明确。也未规定
重建输出是否进入新包 checksum 闭包，或只作为接收方本地投影。这是跨版本升级的
核心遗漏。

### F5: 身份稳定性有基础规则，但缺少升级审计记录

文档规定同 `bookId` 不同 `sourceHash` fail closed，同 `sourceHash` 不同
`bookId` 报告 duplicate candidate；`identity` section 也要求 bookId、
sourceHash、canonicalTitle、titleSlug、createdAt 和 packageVersion。

跨版本升级还需要记录 identity migration。旧 manifest 可能缺少
`canonicalTitle`、`titleSlug`、`normalizedHash` 或使用不同规范化算法。Type DD
没有要求保存旧值、新值、派生方法、规范化工具版本和冲突原因，因此升级后 identity
变化难以审计。

### F6: 校验闭包重建方向正确，但旧校验的地位不清楚

迁移规则要求所有移动完成后重新生成 package-relative file entries 和 checksums。
这是新包可挂载的必要条件。

仍需明确旧 `distribution_manifest.json.sha256`、旧 sidecar、旧 artifact checksum
和旧 qmd build manifest 的地位。它们应作为 legacy evidence 保留，不能授权新
`BOOK_MANIFEST.json` 挂载。Type DD 目前只说保留 `distribution_manifest.json` 直到
下一次成功 audit，但没有定义“成功 audit”的判定字段和记录位置。

### F7: 原子升级和半迁移隔离缺失

文档有 `book-package-import.mjs`、`book-package-export.mjs` 和 mount scanner，但没有
定义升级器如何在 staging 中生成新布局，再原子替换或发布。跨版本升级会移动文件、
重建 checksum、可能重建 qmd index 或 GraphRAG artifact，失败概率高于普通 copy。

如果升级直接在 `graph_vault/books/{bookId}` 内原地移动，mount scanner 可能看到
半迁移目录，并错误产生 derived catalog projection。当前 Type DD 只规定缺文件和
checksum mismatch 会 quarantine mount candidate，未规定 upgrade-in-progress 的
显式状态、锁文件、staging 根或回滚协议。

### F8: Producer lineage 保全原则存在但不足

文档要求 `graphrag/runs/` 保存 graph_extract、community_report、embed、
query_ready 等 producer run 证据，并将 `createdBy` 纳入 compatibility。这保护了
部分 provenance。

但升级本身也是 producer-like transformation。Type DD 未要求记录迁移工具版本、
输入 manifest digest、输出 manifest digest、转换步骤、跳过 artifact、重建 artifact
和不可验证旧 evidence。没有这类 migration evidence，升级后的包难以说明哪些产物
来自旧 producer，哪些来自升级器，哪些由 mount scanner 重建。

### F9: 隐私边界覆盖导出，但升级扫描边界还需显式化

文档明确排除 provider requests、provider responses、`.env`、logs、corrupt
artifacts 和 recovery payload，并说明 scanner 不得修改 provider payload roots。
这符合“不读取 provider payload/secrets”的边界。

跨版本升级应进一步规定升级器不得读取这些路径的内容。旧目录可能把 provider
payload 或 logs 混在 `runs/`、`output/` 或 recovery 文件中。仅声明导出排除不足以
约束升级扫描实现；设计应要求按路径和类型跳过、只报告存在性或摘要诊断，并禁止把
这些文件加入新 manifest 闭包。

### F10: 测试契约缺少版本升级专项用例

现有 test contracts 包含从当前 `distribution_manifest.json` 生成 draft
`BOOK_MANIFEST.json`，这是升级相关测试的起点。

但跨版本升级需要更细测试：旧 schema 可升级、旧 schema 不支持、GraphRAG artifact
schema incompatible、qmd index schema incompatible 后 reindex、checksum mismatch、
升级失败回滚、半迁移 scanner 隔离、provider payload exclusion 和 migration
evidence 生成。Type DD 尚未给出这些测试契约。

## pass_fail

总体结论：未通过（fail），但具备可修正的基础。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `legacy_version_detection` | 部分通过 | 能识别当前 `distribution_manifest.json`，但未定义旧 schema/version 分类。 |
| `migration_path_matrix` | 未通过 | 缺少按旧版本、schema 和 artifact 类型展开的升级矩阵。 |
| `artifact_schema_conversion` | 未通过 | GraphRAG parquet、LanceDB、reports、stats 与 qmd index 转换策略未定义。 |
| `identity_stability` | 部分通过 | 有 bookId/sourceHash 冲突规则，缺少升级前后 identity 审计记录。 |
| `checksum_reclosure` | 部分通过 | 要求重建新 checksum，但旧 checksum 的证据地位和 audit 成功条件不清楚。 |
| `rollback_atomicity` | 未通过 | 缺少 staging、锁、原子发布、回滚和 upgrade-in-progress 状态。 |
| `compatibility_diagnostics` | 部分通过 | 有 incompatibleSchema 状态，但诊断类型和机器可读结构不足。 |
| `producer_lineage_preservation` | 部分通过 | producer evidence 目录存在，缺少 migration evidence 契约。 |
| `privacy_preservation` | 部分通过 | provider payload 被排除，但升级扫描不得读取内容的规则不够显式。 |
| `upgrade_testability` | 未通过 | 只有 draft manifest 生成测试，缺少跨版本升级专项测试矩阵。 |

## required_design_changes

1. 增加 `supportedMigrations` 矩阵。按 source manifest kind、manifest schema、
   layoutVersion、qmdIndexSchema、graphRagArtifactSchema、embedding schema 和
   target schema 定义可升级、需重建、只保留 evidence、不可升级的规则。

2. 拆分 compatibility 字段。至少区分 qmd tool version、qmd index schema、
   GraphRAG artifact schema、parquet schema、LanceDB schema、embedding model、
   embedding dimension、manifest schema 和 migration tool version。

3. 定义 artifact 转换决策表。对每类 artifact 标明 `carry_forward`、
   `rewrite_manifest_only`、`schema_convert`、`rebuild_from_input`、
   `legacy_evidence_only`、`incompatible_not_query_ready` 的适用条件。

4. 固化 qmd index upgrade policy。旧 index schema 不兼容时，应明确是
   `reindex_on_upgrade`、`reindex_on_mount`、`drop_projection` 还是
   `visible_not_query_ready`，并定义输出位置和 checksum 归属。

5. 增加 identity migration record。记录旧 identity、新 identity、规范化算法、
   sourceHash/normalizedHash 计算方法、冲突结果和 migration reason。

6. 定义旧 checksum 与 legacy manifest 的证据地位。旧 sidecar 只能作为
   `legacyEvidence`，新挂载必须由 `BOOK_MANIFEST.json` 与新 checksum sidecars
   授权。

7. 规定原子升级协议。使用 staging 目录、upgrade lock、临时 manifest、全量校验、
   原子 rename 或发布标记；失败时保留旧包并写入机器可读诊断。

8. 增加 `migrationEvidence` section。记录 migration tool、startedAt、finishedAt、
   input manifest digest、output manifest digest、steps、converted artifacts、
   rebuilt artifacts、skipped artifacts 和 failure diagnostics。

9. 明确升级隐私扫描边界。升级器不得读取 provider payload、secrets、logs 和
   recovery payload 内容；发现这些路径时只记录排除诊断，不复制到新 manifest
   闭包。

10. 补充升级专项测试。测试应覆盖 supported migration、unsupported migration、
    qmd reindex、GraphRAG schema incompatible、checksum mismatch、rollback、
    scanner ignores upgrade-in-progress、identity conflict 和 privacy exclusion。

## residual_risks

- 某些旧 GraphRAG artifacts 可能没有足够 schema metadata，无法可靠判断是否可
  carry forward，只能保守降级为 not query-ready。
- qmd index 或 GraphRAG output 重建可能需要原始 source、normalized input、模型
  配置和 embedding provider；若 provider payload 被排除且 provider 不可用，升级
  只能生成不可查询包或局部可查询包。
- 旧目录历史残留与当前完成书可能共享 source-hash 前缀，升级器若没有强 identity
  gate，可能把非当前残留误升级为正式包。
- Artifact schema 转换器会扩大实现复杂度；若缺少版本化测试 fixtures，未来 schema
  变更仍可能破坏升级路径。
- 隐私排除依赖路径规则和实现纪律。旧包若把敏感内容伪装成普通 artifact，Type DD
  仍需要配合内容分类或人工审计策略。
