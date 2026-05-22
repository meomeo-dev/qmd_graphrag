# 书级作业状态设计（Book Job State Design）

## 目标

为 `qmd_graphrag` 增加书级状态层，使批量处理、多阶段恢复、成本控制、
一致性和容错不再完全依赖上游 `GraphRAG` workflow 本身。

该状态层不替代 `GraphRAG` 的输出目录与请求级 cache，而是在其之上提供：

- 书级主键（book-level identity）
- 阶段级检查点（stage-level checkpoints）
- 产物清单（artifact manifest）
- 运行记录（run records）

## 最小单位

三种最小单位需要严格区分：

- 业务单位（business unit）：
  一本书。
- 恢复单位（recovery unit）：
  一本书的一个 stage。
- 成本去重单位（cost deduplication unit）：
  一个规范化后的 LLM 请求哈希。

因此：

- 不以整个 `inbox` 作为最小重跑单位。
- 不以整个 `graph_vault` 作为最小恢复单位。
- 不以“所有书共享一个大 pipeline”作为默认执行模型。

## 状态模型

### BookJob

代表一本书的主记录。

核心字段：

- `bookId`
- `sourcePath`
- `sourceHash`
- `normalizedContentHash`
- `configFingerprint`
- `promptFingerprint`
- `modelFingerprint`
- `currentStage`
- `overallStatus`
- `lastSuccessRunId`
- `updatedAt`

### StageCheckpoint

代表一本书在某一 stage 的执行状态。

核心字段：

- `bookId`
- `stage`
- `status`
- `attemptCount`
- `startedAt`
- `finishedAt`
- `inputFingerprint`
- `artifactIds`
- `errorSummary`

`status` 建议值：

- `pending`
- `running`
- `succeeded`
- `failed`
- `abandoned`

### ArtifactManifest

代表某个 stage 产出的稳定产物。

核心字段：

- `artifactId`
- `bookId`
- `stage`
- `kind`
- `path`
- `contentHash`
- `producerRunId`
- `createdAt`

## Stage 定义

当前统一定义如下：

1. `ingest`
2. `normalize`
3. `graph_extract`
4. `community_report`
5. `embed`
6. `query_ready`

说明：

- `ingest` 负责源文件登记与 `bookId` 建立。
- `normalize` 负责 EPUB 到标准 markdown/text 的转换。
- `graph_extract` 对应 `GraphRAG` 的图抽取与社区构建前半段。
- `community_report` 对应 community reports 生成。
- `embed` 对应向量写入。
- `query_ready` 表示该书可被查询消费。

`lancedb_index` 不是“目录存在”即可满足。当前 GraphRAG 查询至少依赖
`entity_description.lance`、`community_full_content.lance` 和
`text_unit_text.lance` 三张 LanceDB 表。只有三张表均包含非空 data 文件与
正行数 sidecar 时，`embed` 才能提升为成功产物。

每张 LanceDB 表还必须有正行数 sidecar（positive row-count sidecar）。
同步层从 LanceDB 读取表行数并写入 `<table>.lance/qmd_row_count.json`。
validator 必须拒绝缺少该 sidecar 或 `rowCount <= 0` 的表。LanceDB
manifest 内容不是 qmd_graphrag 的稳定契约，不作为通过条件。

## 一致性策略

一致性边界为：

- `bookId + stage`

每个 stage 的写入规则：

1. 先写临时产物。
2. 校验通过后再提升为正式 artifact。
3. 成功前不得覆盖最近一次成功产物。
4. 失败时只更新 checkpoint，不提升 artifact。

这意味着即使网络波动、429、502 或进程中断：

- 已成功的 stage 仍然有效。
- 失败 stage 可以单独重试。
- 不会因为一次失败把整本书打回初始状态。

## 恢复策略

恢复流程：

1. 读取 `BookJob`。
2. 读取该书全部 `StageCheckpoint`。
3. 读取该书 `ArtifactManifest`。
4. 根据 fingerprint 和 artifact 可达性判断哪些 stage 仍有效。
5. 从第一个失效、失败或 artifact 缺失 stage 继续。

失效规则：

- `sourceHash` 变化：整书失效。
- `promptFingerprint` 变化：相关 stage 及其下游失效。
- `modelFingerprint` 变化：相关 stage 及其下游失效。
- `configFingerprint` 变化：按受影响 stage 失效。
- 必需 artifact 在 manifest 或磁盘中缺失：对应 stage 失效。
- 半成品 LanceDB 目录不得满足 `lancedb_index` 需求。

`bookId` 是稳定身份，格式为
`book-<first_12_hex_chars_of_source_hash>`，只由源文件内容哈希派生，
不来源于宿主机绝对路径或源文件名。这样 `graph_vault` 从 A 设备拷贝到
B 设备后，同一本源文件仍然映射到同一个状态目录。若同一路径的书籍内容
变化，会形成新的 `bookId`。

为了保证 `graph_vault` 可迁移，源 EPUB 在 ingest 阶段需要物化到
`graph_vault/sources/<book_id>/`。`BookJob.sourcePath` 和
`ArtifactManifest.path` 使用 vault-relative path。`BookJob.metadata` 不保存
宿主机绝对路径；审计和追踪应基于 vault-relative artifact、run record 和
内容哈希（content hash）。

`artifactId` 由 `bookId + stage + kind + contentHash + stageFingerprint +
providerFingerprint` 派生，不包含 `producerRunId`、artifact path 或 run
locator。因此同一高成本产物被 bootstrap 或恢复同步多次发现时，manifest
不会因为运行 ID 或设备路径变化而重复膨胀。

## 成本控制

成本控制依赖三层复用：

- 书级复用：同一本书不重复跑已成功 stage。
- 阶段级复用：失败只补失败 stage。
- 请求级复用：同 fingerprint 的 LLM 调用走 cache。

对 20 本书的处理方式应是：

- 每本书独立建 `BookJob`。
- 调度器逐书推进。
- 任一本失败，不影响其他书继续。

## 存储布局

建议目录结构：

```text
graph_vault/
  sources/
    <book_id>/
      source.epub
  books/
    <book_id>/
      source/
      artifacts/
        ingest/
        normalize/
        graph_extract/
        community_report/
        embed/
        query_ready/
      cache/
      runs/
  catalog/
    books.yaml
    runs.yaml
```

## 与 GraphRAG 的关系

该状态层不替代 `GraphRAG`：

- `GraphRAG` 继续负责图构建、社区报告、向量化。
- `qmd_graphrag` 新增的 Job State 层负责：
  - 书级 identity
  - stage checkpoint
  - artifact traceability
  - resume / retry 决策

这样可以保持上游 `GraphRAG` 同步成本较低，同时把恢复语义掌握在本仓库。

## 可迁移性策略

`graph_vault` 是最小可迁移单元。跨设备迁移时，应拷贝完整
`graph_vault`，并在目标设备提供运行时环境和 `.env`。

可迁移性规则：

- `settings.yaml` 内部路径保持相对路径。
- `source_epub` artifact 指向 `sources/<book_id>/...`。
- `normalized_markdown` artifact 指向 `input/...`。
- `lancedb_index` artifact 指向 `output/lancedb`。
- 状态判断只读取 vault-relative artifact，不读取原始 inbox。
- `BookJob.metadata` 不保存原始设备上的绝对路径。
- `books/` 与 `sources/` 的 active 区只保留 canonical `book-<sourceHash>`
  目录。
- 同一 `sourceHash` 的 legacy book 目录必须合并到 canonical 目录；合并后旧
  目录移动到 `archive/legacy-books/` 或 `archive/legacy-sources/`。
- legacy 合并必须重写 job、checkpoint、artifact、run record、run catalog
  与 typed catalog 中的 `bookId` 和 artifact 引用。
