# agent-03-large-library audit report

## scenario

一个 vault 同时挂载上千本书，mount scan 需要可扩展
(scalable)、可恢复 (resumable)，并且在复制、删除、导入、扫描和查询并发
发生时保持 catalog、qmd projection 与 retrieval projection 的一致性。

审计对象为 `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
本审计不读取 provider payload、secrets、请求响应日志或私有运行载荷。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

| id | name | 判定重点 |
| --- | --- | --- |
| scale_objectives | 规模目标与资源预算 | 千本级目标、时间、内存、I/O、并发和退化约束 |
| incremental_change_detection | 增量变更检测 | 未变更书包不做完整校验或重建 |
| atomic_package_visibility | 书包原子可见性 | 半包目录不被 scanner 误挂载或反复隔离 |
| resumable_scan_state | 可恢复扫描状态 | 中断后从 cursor/cache/generation 恢复 |
| bounded_validation_io | 有界校验 I/O | 常规扫描成本与变更量相关 |
| transactional_projection | 目录与索引事务化投影 | catalog/index 只暴露完整旧版或新版 |
| concurrency_control | 并发与锁定协议 | runner/importer/scanner/query 的边界和锁明确 |
| conflict_indexing | 冲突与重复检测索引 | 冲突检测可扩展、稳定、可重放 |
| diagnostics_quarantine_scale | 大规模诊断与隔离 | 坏包不阻塞健康书包，诊断有保留策略 |
| large_library_tests | 大规模测试与可观测性 | 千本 fixture、恢复、并发、性能与故障注入测试 |

## findings

### F-01 规模目标缺失，Type DD 不能约束实现

Type DD 记录当前 72 个 book 目录和 38 本完成书，但没有定义上千本库的
目标规模、扫描耗时、内存上限、I/O 上限、并发度、单书最大 artifact
闭包或降级策略。`book-mount-scanner.mjs` 的责任只描述为扫描 manifests
并生成投影，未形成可测试的规模契约。

影响：实现可能做成全量、同步、无预算扫描，在 1000 本以上和大型
GraphRAG/LanceDB artifact 下不可预测。

### F-02 mount scan 被描述为全目录输入，缺少增量索引

`targetContract.mountScanner.authoritativeInput` 使用
`graph_vault/books/*/BOOK_MANIFEST.json`，并要求 checksum 验证后才可
修改 catalog projection。Type DD 没有定义 manifest digest cache、目录
generation、per-book scan state、delete tombstone 或 changed-set 发现机制。

影响：每次扫描可能重新打开并验证所有书包；删除、新增和少量更新不能限制在
变更集内处理。

### F-03 checksum 契约过强但没有校验层级，常规扫描 I/O 不受控

manifest `files` section 要求每个 required file 都列出 bytes 和 sha256，
`checksums` 又要求 mutation 前强制校验。若按字面实现，scanner 为挂载
1000 本书会反复读取 qmd、parquet、LanceDB、reports 等大文件。

影响：正确性目标和性能目标冲突。设计应区分快速校验
(manifest + sidecar + cached digest)、首次深度校验 (deep verification)
和后台审计 (background audit)。

### F-04 半包可见性未封闭，复制中断会污染大库扫描

生命周期写明复制完整目录后 scanner 验证 manifest 和 checksums；冲突处理
把缺文件和 checksum mismatch 归为 quarantine candidate。设计没有要求
staging 目录、ready marker、manifest-last 写入、atomic rename 或 import
commit protocol。

影响：用户普通复制时，如果 `BOOK_MANIFEST.json` 先于大文件出现，scanner
会把半包当作失败候选。千本库中批量复制或同步会产生大量误隔离和诊断噪声。

### F-05 scanner 可恢复性不足

Type DD 只要求 scanner failures 作为 mount diagnostics 报告。它没有定义
scan session、cursor、checkpoint、per-book validation cache、last-good
projection 或失败恢复入口。

影响：scanner 在第 900 本书后崩溃时，下一次可能重扫全库；更严重的是，
如果已经局部写入 catalog 或 global index，读者可能看到不完整投影。

### F-06 derived projection 缺少事务提交协议

catalog 被定义为可重建投影，全局 qmd 和 retrieval indexes 被定义为 cache
或 projection，这是正确方向。但设计没有说明这些投影如何提交：没有
generation id、临时文件、fsync/rename、双缓冲、rollback、reader view
或 stale projection 清理规则。

影响：删除一本书、加入一本书或处理冲突时，`books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和全局索引可能
处于不同代 (generation)，导致查询层看到撕裂状态。

### F-07 mutable import/state 位于 package root，readonly 语义矛盾

manifest `mount` contract 规定 shared packages 默认 readonly，运行态写入
应隔离在 `import/` 或 `state/runtime` 并从 checksum 排除；同时目录布局把
`import/` 和 `state/` 列为 package root 下 required directory。对于通过
复制获得的只读书包，scanner 若在 `import/` 写入兼容性检查和导入诊断，会
直接修改 package root。

影响：readonly package、checksum closure 和 mount diagnostics 三者边界
不清。千本库会放大这种问题，因为扫描过程会对大量书包目录产生写放大
(write amplification)。

### F-08 并发协议不足

Type DD 未定义 runner 构建书包、exporter 生成 manifest、importer staging、
scanner 投影和 query 读取之间的锁粒度、锁文件位置、超时、优先级和失败
恢复。`copied book directory is ignored until BOOK_MANIFEST.json and its
checksum sidecars pass validation` 不能替代并发协议。

影响：scanner 可能读取 runner 正在移动的 output/runs，query 可能读取正在
替换的 global index，importer 可能与 scanner 同时写同一本书的 import
状态。

### F-09 冲突处理有结果枚举，但缺少可扩展、确定性索引

`sameBookIdDifferentSourceHash`、`sameSourceHashDifferentBookId` 等结果已
列出，但没有定义 bookId index、sourceHash index、tie-breaker、稳定排序、
上一代 mounted state 保留规则或冲突诊断结构。

影响：千本库扫描顺序不同可能造成不同候选被保留或隔离；重复 sourceHash 的
检测也可能退化为全量比较。

### F-10 大规模诊断、quarantine 和测试契约不足

设计要求失败报告为 mount diagnostics，并把坏包归为 quarantine candidate，
但没有定义 per-book diagnostics 文件、摘要索引、保留上限、清理策略或恢复
命令。测试契约只覆盖单书复制、删除、provider 排除、冲突、reindex 和迁移，
没有千本级 fixture、故障注入、并发扫描、中断恢复或性能断言。

影响：大量坏包会阻塞或拖慢健康书包挂载；实现缺少可观测性
(observability) 和回归保护。

## pass_fail

总体判定：Fail。Type DD 对单本书热插拔边界基本充分，但对“上千本同时
挂载、扫描可扩展且可恢复”的场景不充分。

| baseline id | result | 说明 |
| --- | --- | --- |
| scale_objectives | Fail | 没有千本级性能、资源和退化预算 |
| incremental_change_detection | Fail | 没有 changed-set、cache 或 generation 设计 |
| atomic_package_visibility | Partial | 要求校验 manifest/sidecar，但没有原子发布协议 |
| resumable_scan_state | Fail | 没有 scan checkpoint、cursor 或 last-good view |
| bounded_validation_io | Fail | checksum 必验可能导致每次全量读大文件 |
| transactional_projection | Fail | derived catalog/index 没有事务化提交规则 |
| concurrency_control | Fail | runner/importer/scanner/query 锁边界未定义 |
| conflict_indexing | Partial | 有冲突结果枚举，无稳定索引和顺序规则 |
| diagnostics_quarantine_scale | Partial | 有 diagnostics/quarantine 名称，无结构和保留策略 |
| large_library_tests | Fail | 缺少千本级、恢复、并发和性能测试契约 |

## required_design_changes

1. 增加 `largeLibraryContract`，声明至少 1000 本 mounted book 的扫描目标：
   warm scan、cold scan、单次变更扫描耗时、内存上限、最大并发、I/O 预算、
   失败隔离目标和 metrics 输出。

2. 增加 `mountScanState` 设计：持久化 scan generation、per-book manifest
   digest、validatedAt、artifact validation mode、lastSeen、lastGoodStatus、
   failure reason 和 delete detection。常规扫描只处理 digest 变化、新增和
   删除书包。

3. 增加 `validationLevels`：`fast_manifest_check`、`deep_artifact_check`、
   `background_audit`。mount projection 只依赖快速校验和可信 cache；深度
   sha256 校验用于首次导入、digest 变化或后台审计。

4. 增加原子发布协议 (atomic publish protocol)：外部复制进入
   `graph_vault/import-staging/` 或 `{bookId}.staging`，通过全部校验后以
   atomic rename 发布到 `books/{bookId}`；或者要求 `BOOK_MANIFEST.json`
   和 sidecar 最后写入，并提供 `PACKAGE_READY` marker。

5. 增加事务化投影协议：catalog 和全局索引写入
   `catalog/.generations/{generationId}/`，校验完成后原子切换 current
   pointer。失败时保留上一代 reader view，并记录 failed generation。

6. 把 mount diagnostics 和 runtime import state 从可分发 package closure
   中分离。推荐放到 `graph_vault/mount_state/books/{bookId}/`；若必须保留
   package root 下 `import/`，必须明确其不参与 package checksum、可在
   readonly mount 时重定向到本地状态根。

7. 定义并发锁：vault-level scan lock、per-book import/build lock、
   projection generation write lock 和 query reader generation pin。每个锁
   需要 owner、createdAt、heartbeat、timeout 和 stale-lock recovery。

8. 定义冲突索引：`bookId -> package digest`、`sourceHash -> bookIds`、
   `documentId -> bookId/sourceHash`。冲突处理必须稳定排序，并规定冲突出现
   时上一代 query-ready package 是否保持可查询。

9. 定义 diagnostics/quarantine schema：per-book 状态文件、全局摘要、
   severity、firstSeen、lastSeen、retryAfter、recoveryAction、保留上限和
   清理规则。坏包不得阻塞健康书包 projection。

10. 扩展 `testContracts`：加入 1000/5000 synthetic package scan、单书变更
    warm scan、中断后恢复、半包复制、并发 runner+scanner、projection
    rollback、坏包风暴、duplicate sourceHash 和 metrics 断言。

## residual_risks

- 即使加入增量扫描，首次导入 1000 本大书仍可能受磁盘吞吐和 checksum 成本
  限制，需要后台审计和进度报告降低阻塞。
- qmd book index 是否作为默认包 artifact 仍是 open question；若大量书包
  缺失 qmd index，`reindex_on_mount` 可能形成长时间队列。
- GraphRAG/LanceDB artifact 的内部 schema 和跨版本兼容性会影响快速校验的
  可信度，需要与版本升级设计共同收敛。
- 如果 vault 位于网络文件系统或云同步目录，atomic rename、mtime/inode
  cache 和 lock heartbeat 的可靠性需要单独限定。
- source-redacted package 会改变 query-ready 与 rebuild 能力，可能要求为
  大库维护不同的 validation profile。
