# agent-1-fresh-vault 实施审计报告

## 审计边界

本报告仅审计以下材料，不使用其他代码作为判定依据：

- `docs/architecture/graphrag-book-hotplug-package.README.md`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
- `src/cli/qmd.ts`
- `src/integrations/python-bridge.ts`
- `src/graphrag/book-hotplug-catalog.ts`
- `src/graphrag/settings-projection.ts`
- `scripts/graphrag/book-hotplug-package.mjs`
- `scripts/graphrag/backfill-hotplug-packages.mjs`
- `test/cli-graphrag-route.test.ts`
- `test/unified-query.test.ts`

重点场景是：用户将单本书目录复制到 fresh `graph_vault` 后，直接执行
GraphRAG 查询。

## 固定基准复用

- baseline 来源：
  `docs/architecture/graphrag-book-hotplug-package-audits/agent-09-graphrag-query/baseline.yaml`
- 本轮 baseline：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r1__open/agent-1-fresh-vault/baseline.yaml`
- baseline SHA-256：
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

本轮未新增、删除、重排、重命名任何 baseline 维度，也未修改任何
`passCriteria`。

## 执行证据

已执行：

```bash
npx vitest run test/cli-graphrag-route.test.ts test/unified-query.test.ts --testTimeout 120000
```

结果：

- `test/unified-query.test.ts`：36/36 通过。
- `test/cli-graphrag-route.test.ts`：9 个测试中 8 个通过，1 个超时失败。
- 已有 fresh-vault 设置投影测试通过：
  `qmd query --graphrag recreates managed settings projection for a fresh vault`
  见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:846)。

## 总结

总体结论：`partial`

计数：

- `pass`: 1
- `partial`: 6
- `fail`: 3

当前实现尚未达到“复制单本书目录到 fresh `graph_vault` 后，基于热插拔包直接
查询”的闭环要求。最主要的实现阻断有三项：

1. CLI 仍把 GraphRAG 运行目录硬编码到
   `graph_vault/books/{bookId}/output`，而热插拔包规范路径是
   `graph_vault/books/{bookId}/graphrag/output`。
   见 [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3329)
   和 [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3440)，
   对照设计合同
   [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:478)
   与
   [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:955)。
2. hotplug 目录重建的 capability projection 没有保留 artifact 闭包，
   `artifactIds` 被写成空数组。
   见 [src/graphrag/book-hotplug-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:199)-
   [202](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:202)。
3. 现有 CLI 与 unified-query 测试仍主要构造旧布局
   `books/{bookId}/output`，并依赖预写 `catalog/*.yaml`，没有覆盖
   `BOOK_MANIFEST.json + PUBLISH_READY.json + graphrag/output` 的单书复制场景。
   见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:207)-
   [327](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:327)，
   [test/unified-query.test.ts](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:90)-
   [260](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:260)。

## 固定 10 维基准复核

### 1. `direct_query_entrypoint`

- 名称：直接查询入口
- 通过标准：
  挂载扫描完成后，GraphRAG 查询入口能仅凭 `BOOK_MANIFEST.json` 和包内
  artifacts 定位本书查询上下文，不依赖全局 catalog、旧 batch 状态、
  provider payload、发送方绝对路径或人工补参。
- 结论：`fail`
- 依据：
  - 设计已明确 manifest-first direct query，且全局 catalog 只是可重建缓存。
    见
    [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942)-
    [989](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:989)。
  - 实现中 CLI 仍直接把 `dataDir` 指向
    `books/{bookId}/output`，没有从 `BOOK_MANIFEST.graphrag.outputManifestPath`
    或 `graphrag/output` 解析查询入口。
    见 [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3327)-
    [3334](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3334)，
    [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3437)-
    [3440](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3440)。
  - 现有测试也仍写入 `books/{bookId}/output`，没有验证 hotplug 规范目录。
    见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:211)-
    [225](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:225)。

### 2. `artifact_minimum_closure`

- 名称：查询 Artifact 最低闭包
- 通过标准：
  Type DD 明确列出 GraphRAG 查询所需的最低 artifact 集合、文件角色、
  schema version、bytes、sha256 与 required 标记，并说明缺少任一必需
  artifact 时必须 fail closed 为 not query-ready。
- 结论：`partial`
- 依据：
  - 包构造器已枚举最低 GraphRAG 文件集合，并写入
    `graphrag.requiredArtifacts`。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:31)-
    [42](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:42)，
    [523](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:523)-
    [530](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:530)。
  - 校验器也会对 `requiredArtifacts` 缺失 fail closed。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:707)-
    [711](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:711)。
  - 但 capability projection 丢失 `artifactIds`，fresh-vault 自愈后无法从
    projection 侧保留查询闭包。
    见 [src/graphrag/book-hotplug-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:199)-
    [202](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:202)。
  - 审计范围内的实现也没有体现设计合同要求的
    `graphrag/output/artifact-metadata.json` 校验。
    设计要求见
    [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:955)-
    [968](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:968)。

### 3. `artifact_gate_state_machine`

- 名称：Artifact Gate 状态机
- 通过标准：
  设计定义从 copied、candidate、validated、mounted、query-ready、
  visible_not_query_ready 到 quarantined 的状态、转移条件、诊断输出和禁止
  查询条件，artifact gate 通过前不得投影为可查询。
- 结论：`partial`
- 依据：
  - 设计合同已给出完整状态机。
    见
    [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990)-
    [1097](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1097)。
  - 审计范围内实现有最小 gate：
    `BOOK_MANIFEST.json` + `PUBLISH_READY.json` 才会被 catalog self-rebuild
    读取；缺少或校验失败则跳过。
    见 [src/graphrag/book-hotplug-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:104)-
    [115](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:115)，
    [335](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:335)-
    [346](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-catalog.ts:346)。
  - 但实现没有显式持久化 `visible_not_query_ready`、`quarantined`、
    `rolled_back` 等状态，也没有把状态机转移结果公开为稳定结构。
  - `validateBookHotplugPackage()` 只返回布尔值和诊断数组，尚不足以覆盖
    设计中的完整状态机。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:607)-
    [717](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:717)。

### 4. `producer_lineage_completeness`

- 名称：Producer Lineage 完整性
- 通过标准：
  每个查询必需 artifact 均可追溯到 producer run、step、input hash、
  tool version、schema version、生成时间和上游 artifact hash；lineage
  不完整时不得声明 queryReady。
- 结论：`partial`
- 依据：
  - 包构造器为每个 GraphRAG 文件条目附加 `producerRunId`，并汇总
    `producerRunIds`。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:325)-
    [347](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:347)，
    [350](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:350)-
    [363](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:363)。
  - 但审计范围内实现没有读取或验证 `graphrag/runs` 下的 redacted producer
    lineage summaries，也没有核对 input hash、上游 output hash、schema
    version、生成时间等字段。
  - 因此“存在 run id”已具备，但“lineage 完整”尚未闭环。

### 5. `lineage_artifact_binding`

- 名称：Lineage 与 Artifact 绑定
- 通过标准：
  manifest 中 `producerRunIds`、`graphrag/runs` 证据和 `files` 闭包之间有
  可验证引用关系，能证明 artifact 是声明 producer 生成的当前文件，而非
  孤立残留或被替换文件。
- 结论：`fail`
- 依据：
  - 设计合同要求双向 binding。
    见
    [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:610)-
    [613](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:613)。
  - 实现侧虽然为 `files` 写入 `producerRunId`，但 `validateBookHotplugPackage()`
    并未校验这些 `producerRunId` 是否在 `graphrag/runs` 证据中存在并匹配。
  - `book-hotplug-catalog` 也未读取 `graphrag/runs`，因此 fresh-vault 自愈后
    没有实现设计要求的可验证引用关系。

### 6. `schema_runtime_compatibility`

- 名称：Schema 与运行时兼容
- 通过标准：
  设计区分 GraphRAG runtime、parquet schema、LanceDB schema、embedding
  model/dimension、output manifest schema 和 package layout schema，并规定
  兼容失败的 query gate 行为。
- 结论：`partial`
- 依据：
  - `settings-projection` 已把运行时模型和向量维度写入 managed
    `settings.yaml`，可在 fresh-vault 下自修复缺失设置。
    见 [src/graphrag/settings-projection.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:82)-
    [249](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:249)，
    [361](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:361)-
    [440](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:440)。
  - manifest 也有基本兼容字段。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:545)-
    [553](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:553)。
  - 但审计范围内实现没有把设计合同要求的 `parquetSchemaDigest`、
    `lancedbSchemaDigest`、`embeddingDimension` 等作为 query gate 的必检条件。
    设计要求见
    [docs/architecture/graphrag-book-hotplug-package.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:614)-
    [620](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:620)
    和
    [docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1048)-
    [1052](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1052)。

### 7. `query_scope_isolation`

- 名称：单书查询范围隔离
- 通过标准：
  挂载后直接查询只能读取该书包声明的 GraphRAG output、producer evidence
  和必要投影，不能把其他书、历史残留、全局缓存或 sibling roots 混入查询上下文。
- 结论：`partial`
- 依据：
  - CLI 在 graph route 上要求只选择一个 `bookId`，并把
    `selectedBookIds` / `graphCapabilityIds` / `artifactIds` 传入 provider。
    见 [src/cli/qmd.ts](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3421)-
    [3451](/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3451)。
  - 现有测试也验证了 `--graph-book-id` 的单书范围选择。
    见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:827)-
    [843](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:843)。
  - 但该范围隔离仍建立在旧 `books/{bookId}/output` 路径上，而不是
    hotplug manifest 的 package-relative 声明。
  - 同时，审计范围内实现没有针对跨书 artifact 引用做显式 gate。

### 8. `privacy_payload_exclusion`

- 名称：Provider Payload 排除
- 通过标准：
  artifact gate 和 lineage 验证不得读取、要求或分发 provider request、
  provider response、secrets、logs payload 或 recovery payload；需要的证据以
  脱敏 metadata、hash 和 run manifest 表达。
- 结论：`pass`
- 依据：
  - README 已把 provider payload 与私人路径明确列为不得分发内容。
    见 [docs/architecture/graphrag-book-hotplug-package.README.md](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.README.md:43)-
    [48](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package.README.md:48)。
  - 包构造器显式排除 `provider-requests/**`、
    `provider-responses/**`、`logs/**`、`.env` 等路径。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:18)-
    [29](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:29)，
    [503](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:503)-
    [543](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:543)。
  - Python bridge 对 provider payload、secret 和绝对路径做脱敏。
    见 [src/integrations/python-bridge.ts](/Users/jin/projects/qmd_graphrag/src/integrations/python-bridge.ts:198)-
    [235](/Users/jin/projects/qmd_graphrag/src/integrations/python-bridge.ts:235)。

### 9. `recovery_diagnostics`

- 名称：失败恢复与诊断
- 通过标准：
  当 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容或 producer
  evidence 缺失时，设计给出稳定诊断、修复入口、quarantine 行为和 catalog
  projection 回滚规则。
- 结论：`partial`
- 依据：
  - `validateBookHotplugPackage()` 已输出一组稳定诊断码，例如
    `missing_manifest`、`missing_publish_marker`、`manifest_sha256_mismatch`、
    `missing_required_file:*` 等。
    见 [scripts/graphrag/book-hotplug-package.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:607)-
    [717](/Users/jin/projects/qmd_graphrag/scripts/graphrag/book-hotplug-package.mjs:717)。
  - `settings-projection` 也有稳定修复结果：
    `managed_projection_created`、`managed_projection_valid`、
    `managed_projection_rewritten`。
    见 [src/graphrag/settings-projection.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:374)-
    [404](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:404)，
    [420](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:420)-
    [440](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:440)。
  - 但审计范围内实现没有落地设计合同要求的 quarantine record、rolled_back
    状态或 direct query gate 的 lineage/schema 专项诊断。

### 10. `executable_contract_tests`

- 名称：可执行契约测试
- 通过标准：
  Type DD 足够具体，使实现者能编写挂载后 GraphRAG 直接查询、artifact
  缺失、artifact 替换、lineage 缺失、schema 不兼容、跨书污染和 provider
  payload 不读取的自动化测试。
- 结论：`fail`
- 依据：
  - 已有测试覆盖了部分实现点：
    fresh-vault `settings.yaml` 自修复、
    `--graph-book-id` 作用域限制、
    explicit graph route 不依赖 qmd top-k。
    见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:846)-
    [876](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:876)，
    [test/unified-query.test.ts](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:795)-
    [816](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:816)。
  - 但这些测试仍以旧目录 `books/{bookId}/output` 为夹具，不是
    `BOOK_MANIFEST + PUBLISH_READY + graphrag/output` 的热插拔包。
    见 [test/cli-graphrag-route.test.ts](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:207)-
    [327](/Users/jin/projects/qmd_graphrag/test/cli-graphrag-route.test.ts:327)，
    [test/unified-query.test.ts](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:90)-
    [260](/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:260)。
  - 设计合同要求的以下场景，在审计范围内测试尚未体现：
    - 删除 catalog 后的 manifest-first direct query。
    - `graphrag/output/artifact-metadata.json` 缺失。
    - lineage 缺失或 producer output hash 不一致。
    - 跨书 artifact 引用污染。
    - `graphrag/output` 新布局直查。
  - 本轮执行中还存在 1 个 CLI 测试超时，说明当前测试稳定性也未完全闭环。

## 关键实现差距

1. `qmd.ts` 的 GraphRAG `dataDir` 仍是旧路径，必须切到 manifest 驱动的
   `graphrag/output` 解析。
2. hotplug self-rebuild 的 capability projection 不能继续写
   `artifactIds: []`，否则 fresh-vault 下的闭包信息会丢失。
3. `validateBookHotplugPackage()` 需要把 `files.producerRunId` 与
   `graphrag/runs` 证据做真正的双向校验。
4. 现有测试需要改为以 hotplug 包为夹具，而不是旧 `output/` 目录。

## 审计结论表

| baseline id | result |
| --- | --- |
| `direct_query_entrypoint` | `fail` |
| `artifact_minimum_closure` | `partial` |
| `artifact_gate_state_machine` | `partial` |
| `producer_lineage_completeness` | `partial` |
| `lineage_artifact_binding` | `fail` |
| `schema_runtime_compatibility` | `partial` |
| `query_scope_isolation` | `partial` |
| `privacy_payload_exclusion` | `pass` |
| `recovery_diagnostics` | `partial` |
| `executable_contract_tests` | `fail` |
