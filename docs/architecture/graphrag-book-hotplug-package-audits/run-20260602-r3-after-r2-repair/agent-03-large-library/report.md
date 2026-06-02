# agent-03-large-library R3 复审报告

## scenario

一个 vault 同时挂载上千本书，mount scan 需要可扩展
(scalable)、可恢复 (resumable)，并在复制、导入、构建、删除、扫描和查询并发
发生时保持 catalog、qmd projection 与 retrieval projection 的一致性。

审计对象：
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`

复审范围未读取 provider payload、secrets、请求响应载荷、密钥或敏感运行时
内容。

## reused_fixed_baseline

本轮复审复用 R3 输出目录中已存在的固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-03-large-library/baseline.yaml`

baseline SHA-256：

`68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe`

固定基线包含 10 个维度：

| 序号 | id | name |
| --- | --- | --- |
| 1 | scale_objectives | 规模目标与资源预算 |
| 2 | incremental_change_detection | 增量变更检测 |
| 3 | atomic_package_visibility | 书包原子可见性 |
| 4 | resumable_scan_state | 可恢复扫描状态 |
| 5 | bounded_validation_io | 有界校验 I/O |
| 6 | transactional_projection | 目录与索引事务化投影 |
| 7 | concurrency_control | 并发与锁定协议 |
| 8 | conflict_indexing | 冲突与重复检测索引 |
| 9 | diagnostics_quarantine_scale | 大规模诊断与隔离 |
| 10 | large_library_tests | 大规模测试与可观测性 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R3 baseline 是否存在 | Pass |
| baseline SHA-256 | `68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe` |
| R3 baseline 与 R2 agent-03 baseline 比较 | Pass，内容一致 |
| R3 baseline 与初始 agent-03 baseline 比较 | Pass，内容一致 |
| 维度数量 | Pass，固定为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重排、重命名 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，未覆盖 baseline.yaml |

## findings

### F-01 scale_objectives：Pass

修订后的 Type DD 在 `largeLibraryOperationalBounds` 中声明目标规模：
1000 本 mounted book、1500 个 candidate directory、常规扫描 50 本 changed
book。`performanceBudgets` 定义 60 秒 normal scan、10 秒 catalog commit、
1024 MB 内存上限、4 路 changed-book validation 并发，以及 unchanged book
不执行 full checksum read。

R2 后新增的 `largeLibraryDegradationAndMetrics` 补齐了最大文件闭包
(maximum file closure)：单书 25000 files、单书 5 GB、normal scan 最多
50 GB validation bytes、最多保留 10000 条 quarantine record。该块还定义
候选目录超限、单包文件超限、字节超限、validation budget 超限、低磁盘空间
和锁竞争时的退化策略，并由
`scripts/graphrag/book-large-library-scan-policy.mjs` 承接实现边界。

固定判据要求的目标书本数量、文件闭包规模、扫描时间、内存、I/O、并发度、
退化策略和实现约束均已覆盖。

### F-02 incremental_change_detection：Pass

`mountScanTransactionModel.changedSetDetection` 使用 `bookId`、
`packageGeneration`、`manifestSha256`、`manifestBytes`、
`publishMarkerSha256` 和 `rootDirectoryMtime` 形成 changed-set digest。
正常扫描只用 digest metadata 校验 unchanged package；新包、变更包、可疑
metadata、显式 audit mode 和 pre-export audit 才执行 full file checksum。

`deletionAndReplacement` 明确删除、同 bookId 新 generation、失败替换和 stale
projection cleanup。`largeLibraryDegradationAndMetrics.validationTiers` 进一步
把 unchanged、changed、new、repair、audit 等路径分层处理。未变更书包不会在
每次扫描中执行完整校验或重建。

### F-03 atomic_package_visibility：Pass

`atomicPackageLifecycle` 定义 import/build staging root、`PUBLISH_READY.json`、
manifest-last write、checksum-last commit、fsync、atomic rename 和 scanner
visibility rule。scanner 必须忽略缺少有效 `BOOK_MANIFEST.json`、manifest
checksum sidecars 或 `PUBLISH_READY.json` 的目录。

直接复制目录仍被支持，但只有 publish marker、manifest 与 checksum 全部验证
后才进入 mount projection。缺失 required file、checksum mismatch、path
traversal、symlink escape 和 corrupt sidecar 都会 fail closed 或进入
quarantine。半成品复制、导入、构建和迁移目录不会被 scanner 当作可挂载书包。

### F-04 resumable_scan_state：Pass

`mountScanTransactionModel.scanState` 定义持久化 scan state、candidate set、
validation results、projection plan 和 commit record。scan generation 有
`scanning`、`validating`、`projecting`、`committed`、`failed` 和
`rolled_back` 状态。

`largeLibraryOperationalBounds.resumability` 要求每 25 个 candidate checkpoint，
恢复输入包含 `scanGeneration`、`candidateCursor`、
`validatedCandidateDigests` 和 `failedCandidateDiagnostics`。中断恢复不暴露
partial projection，也不丢弃 last committed generation。
`lockLeaseAndStagingCleanup` 还补充了 stale staging resume/quarantine/archive
规则。scanner 崩溃、进程中断或机器重启后不需要重新验证全库。

### F-05 bounded_validation_io：Pass

Type DD 已区分快速挂载校验、首次深度校验和周期性审计：
`validationTiers.metadataOnly` 用于 unchanged manifest 与 publish marker，
`manifestAndSidecars` 用于 manifest 或 marker 变化，
`fullClosure` 用于 new package、repair、audit、suspicious metadata 和 export，
`periodicAudit` 定义 every_30_days_or_100_package_changes cadence。

`maxTotalValidationBytesPerNormalScan`、`unchangedBookFullChecksumReads: 0`、
changed-book validation concurrency 和 `overValidationBudget:
defer_remaining_candidates` 共同约束常规扫描 I/O。常规扫描成本与变更书包数量
相关，而不是与全库 qmd、GraphRAG、LanceDB 文件总量相关。

### F-06 transactional_projection：Pass

`mountScanTransactionModel.atomicProjectionCommit` 使用 generation、
staging root、checksum、fsync、atomic replacement 和 current-generation pointer
last update。提交目标包括 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和
`qmd-projection.yaml`。读者只读取 last committed generation pointer，不读取
partial projection。

`qmdRebuildTransaction` 对 per-book qmd projection 使用独立 staging root、
atomic rename、freshness digest 和 commit record。GraphRAG retrieval/query
能力通过 committed mount projection、`graph-capabilities.yaml`、
readiness gates、artifact metadata 和 packageGeneration 绑定。删除书包时，
全局 qmd 与 retrieval projection 在同一提交中 remove 或 invalidate。

catalog、全局 qmd projection 和 retrieval/query projection 均有 old-or-new
reader view 约束，失败时保留 last-good projection。

### F-07 concurrency_control：Pass

`atomicPackageLifecycle.concurrencyBoundary` 定义 import、export、build publish
和 mount scan 的兼容锁边界，同一 bookId 只允许一个 writer publish 或 replace。
query/list 使用 last-good catalog projection。

R2 后新增的 `largeLibraryDegradationAndMetrics.lockCompatibilityMatrix` 明确
publish、scan、catalog commit、qmd projection、query read 和 repair 的兼容性。
`lockLeaseAndStagingCleanup` 定义 lease 字段、heartbeat、TTL、fencing token、
stale takeover、scan snapshot change policy 和 staging cleanup。锁获取失败
产生 retryable diagnostics，并保持 last-good view。

runner、exporter、importer、scanner 和 query 的读写边界、锁粒度、冲突处理、
超时与 stale recovery 已足以支持上千本书挂载场景。

### F-08 conflict_indexing：Pass

`catalogProjectionSchemas.conflictIndex` 定义
`graph_vault/catalog/book-conflicts.yaml`，包含 `byBookId`、`bySourceHash` 和
`byBookIdAndSourceHash` 索引，并用 `sourceHash`、`bookId`、
`packageGeneration`、`manifestSha256` 作为 deterministic ordering。

same bookId different sourceHash、same sourceHash different bookId、same title
different sourceHash 和 manual decision required 均有稳定 outcome。
`sources.yaml` 以 `sourceHash` 为 record key 保存 duplicate status，
`document-identity-map.yaml` 绑定 documentId、bookId、sourceHash 与
packageGeneration。

schema incompatibility 由 `compatibilityStatus`、readiness gate 的
`schema_incompatible` 状态、`compatibilityDiagnostics` 和
`artifactSchemaConversionMatrix` 共同检测并稳定输出。
`manualConflictDecisionWorkflow` 要求 ambiguous identity、duplicate source 和
migration promotion fail closed，且决策记录可审计、可回滚。冲突检测结果不依赖
扫描顺序，可重放。

### F-09 diagnostics_quarantine_scale：Pass

`quarantineAndRepairStateMachine` 定义 per-book quarantine state root、状态机、
record schema、stable validator error codes、bounded affected paths、diagnostic
digest、repair attempts 和 clear/archive transition。记录禁止 absolute path、
secret text、provider payload 和 raw log content。

`largeLibraryDegradationAndMetrics.metrics` 提供总览计数器，
`diagnosticsRetention` 定义 quarantine record、scan generation 和 metrics 的保留
策略。`ioLimits` 限制每书诊断字节和 affected path 数量。大量坏包进入
quarantine 或 not_query_ready，不会阻塞健康书包挂载，也不会移除 last-good
projection。

### F-10 large_library_tests：Pass

Type DD 要求 1000 valid mounted packages normal scan、50 changed packages
bounded validation、中断恢复、projection commit failure、concurrent query old/new
generation、100 package deletion atomic cleanup 等大库测试。

R2 后新增的 `largeLibraryDegradationAndMetrics.metrics` 和 `progressEvents`
定义 mounted book count、candidate count、changed count、validation bytes、
commit duration、lock wait、retry count、scan/projection progress events 等观测
输出。`faultInjectionTests` 覆盖 lock contention、scan interruption、fsync
failure、stale lock takeover、validation byte budget、package count over limit
和 quarantine retention cleanup。

`lockLeaseAndStagingCleanup.concurrentTestMatrix` 与顶层 `testContracts` 进一步
覆盖 publisher/scanner/query 并发、manifest 变化、root 删除、stale lock 和
staging cleanup。固定判据要求的大规模 fixture、恢复、并发、性能预算、metrics、
progress 和故障注入均已覆盖。

## pass_fail

总体判定：Pass。

R3 修订版满足 agent-03-large-library 固定 10 维 baseline。Type DD 已把 R2
剩余的 Partial 项补为明确设计契约，尤其是最大文件闭包、validation tiers、
lock compatibility matrix、conflict index、quarantine retention、metrics、
progress events 和 fault injection tests。

| baseline id | R3 result | 结论 |
| --- | --- | --- |
| scale_objectives | Pass | 规模、文件闭包、资源预算和退化策略已声明 |
| incremental_change_detection | Pass | changed-set digest 与 unchanged skip 已覆盖 |
| atomic_package_visibility | Pass | staging、ready marker、manifest-last 和 rename 已覆盖 |
| resumable_scan_state | Pass | scan state、checkpoint、cursor 和 last-good view 已覆盖 |
| bounded_validation_io | Pass | metadata、sidecar、full closure、periodic audit 已分层 |
| transactional_projection | Pass | catalog、qmd、retrieval/query projection 有事务边界 |
| concurrency_control | Pass | 锁矩阵、lease、heartbeat、stale recovery 已覆盖 |
| conflict_indexing | Pass | identity、source、duplicate、schema 冲突可稳定检测 |
| diagnostics_quarantine_scale | Pass | per-book 诊断、摘要、保留、恢复入口已覆盖 |
| large_library_tests | Pass | 千本测试、metrics/progress、故障注入已覆盖 |

## criteria_delta_from_r2

baseline 判据变化：无。R3 继续使用与 R2、R1 相同的 10 个 dimension id、name 和
passCriteria；没有新增、删除、重排、重命名维度，也没有改变 passCriteria。

评估结果相对 R2 的变化如下：

| baseline id | R2 result | R3 result | delta |
| --- | --- | --- | --- |
| scale_objectives | Partial | Pass | 新增文件闭包上限、字节预算和退化策略 |
| incremental_change_detection | Pass | Pass | 无实质变化，继续通过 |
| atomic_package_visibility | Pass | Pass | 无实质变化，继续通过 |
| resumable_scan_state | Pass | Pass | 新增 lock/staging recovery 支撑，继续通过 |
| bounded_validation_io | Partial | Pass | 新增 validation tiers、周期审计和字节预算 |
| transactional_projection | Pass | Pass | 新增 qmd rebuild 与 query gate 绑定，继续通过 |
| concurrency_control | Partial | Pass | 新增锁兼容矩阵、lease、heartbeat、stale takeover |
| conflict_indexing | Partial | Pass | 新增 conflict index、确定性排序和 manual decision workflow |
| diagnostics_quarantine_scale | Partial | Pass | 新增 quarantine schema、I/O 上限、保留策略和恢复状态机 |
| large_library_tests | Partial | Pass | 新增 metrics/progress 与 fault-injection contracts |

R2 总体判定为 Fail；R3 总体判定为 Pass。

## required_design_changes

无阻断设计变更 (blocking design changes)。

固定 10 维 baseline 下，Type DD 已满足大库挂载场景的设计判据。后续实现必须
保持以下已写入 Type DD 的契约，不应在实现中弱化：

1. `largeLibraryDegradationAndMetrics.scaleLimits` 的文件数、字节数、候选目录和
   validation byte budget 必须形成可测试断言。
2. mount scan 必须使用 generation transaction、checkpoint 和 last-good reader
   pointer；失败不得暴露 partial projection。
3. lock lease、fencing token、heartbeat、stale takeover 和 staging cleanup 必须
   覆盖 runner、exporter、importer、scanner、repair 和 query reader。
4. conflict index、quarantine record、metrics 和 progress event 必须使用稳定
   schema，且不得写入 provider payload、secret text 或 absolute local path。

## residual_risks

- Type DD 已通过固定基线，但性能预算仍需在真实磁盘、网络盘、外接盘和云同步
  目录上实测校准；atomic rename、mtime 和 lock heartbeat 的可靠性可能受文件
  系统语义影响。
- 当前目标规模以 1000 mounted book、1500 candidate directory 为明确预算。
  若产品目标扩展到数千到上万本，需要重新审计 batch size、projection 分片、
  metrics 保留和 scan state 存储增长。
- retrieval/query projection 通过 committed catalog generation、readiness gate
  和 packageGeneration 绑定。实现时若引入独立全局 retrieval index，必须沿用
  同一 generation、fsync/rename 和 rollback 规则。
- 大量坏包、慢磁盘和锁竞争已定义退化策略；实现若缺少 backpressure 和后台
  审计节流，仍可能在首次导入或修复风暴中形成 I/O 峰值。
- 设计禁止 provider payload 和 secrets 进入诊断。实现中的日志、support bundle
  和错误报告仍需单独测试，防止敏感内容经 diagnostics 或 metrics 泄漏。
