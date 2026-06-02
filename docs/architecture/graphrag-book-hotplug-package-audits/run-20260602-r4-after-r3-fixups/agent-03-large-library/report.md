# agent-03-large-library R4 复审报告

## scenario

一个 vault 同时挂载上千本书，mount scan 需要可扩展 (scalable)、
可恢复 (resumable)，并在复制、导入、构建、删除、扫描和查询并发发生时
保持 catalog、qmd projection 与 retrieval projection 的一致性。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

复审未读取 provider payload、secrets、请求响应载荷、密钥或敏感运行时内容。

## reused_fixed_baseline

本轮复审复用 R4 输出目录中已存在的固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-03-large-library/baseline.yaml`

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
| R4 baseline 是否存在 | Pass |
| baseline SHA-256 | `68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe` |
| R4 baseline 与 R3 agent-03 baseline 比较 | Pass，内容一致 |
| R4 baseline 与 R2 agent-03 baseline 比较 | Pass，SHA 一致 |
| R4 baseline 与初始 agent-03 baseline 比较 | Pass，SHA 一致 |
| 维度数量 | Pass，固定为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重排、重命名 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，未覆盖 baseline.yaml |

## findings

### F-01 scale_objectives：Pass

主 Type DD 在 `largeLibraryOperationalBounds` 中声明目标规模：1000 本
mounted book、1500 个 candidate directory、常规扫描 50 本 changed book。
`performanceBudgets` 定义 60 秒 normal scan、10 秒 catalog commit、
1024 MB 内存上限、4 路 changed-book validation 并发，以及 unchanged book
不执行 full checksum read。

`largeLibraryDegradationAndMetrics` 补充最大文件闭包 (maximum file closure)：
单书 25000 files、单书 5 GB、normal scan 最多 50 GB validation bytes、
最多保留 10000 条 quarantine record。候选目录超限、单包文件超限、字节超限、
validation budget 超限、低磁盘空间和锁竞争均有退化策略。

R3 fixups 未削弱这些规模目标；其身份、no-read、qmd 和迁移补充均作为附加
规范约束存在。因此固定判据要求的目标书本数量、最大文件闭包规模、扫描时间、
内存、I/O、并发度、退化策略和实现约束均已覆盖。

### F-02 incremental_change_detection：Pass

`mountScanTransactionModel.changedSetDetection` 使用 `bookId`、
`packageGeneration`、`manifestSha256`、`manifestBytes`、
`publishMarkerSha256` 和 `rootDirectoryMtime` 形成 changed-set digest。
正常扫描只对 unchanged package 执行 digest metadata 校验；新包、变更包、
可疑 metadata、显式 audit mode 和 pre-export audit 才执行 full file checksum。

`largeLibraryDegradationAndMetrics.validationTiers` 将 metadata-only、
manifest-and-sidecars、full-closure 和 periodic-audit 分层。未变更书包不会在
每次扫描中执行完整校验或重建。R3 fixups 的 `qmdAvailabilityAndReexportPolicy`
进一步要求 qmd rebuild 用 `packageGeneration` 与 freshness digest 形成幂等边界，
不会把未变更包误触发为全量重建。

### F-03 atomic_package_visibility：Pass

`atomicPackageLifecycle` 定义 import/build staging root、`PUBLISH_READY.json`、
manifest-last write、checksum-last commit、fsync、atomic rename 和 scanner
visibility rule。scanner 必须忽略缺少有效 `BOOK_MANIFEST.json`、manifest
checksum sidecars 或 `PUBLISH_READY.json` 的目录。

直接复制目录仍被支持，但只有 publish marker、manifest 与 checksum 全部验证
后才进入 mount projection。缺失 required file、checksum mismatch、path
traversal、symlink escape 和 corrupt sidecar 都会 fail closed 或进入
quarantine。R3 fixups 的 repack rule 明确 repack 也是 publish operation，
必须使用 staging 并重新生成 manifest 与 sidecars，进一步保持书包原子可见性。

### F-04 resumable_scan_state：Pass

`mountScanTransactionModel.scanState` 定义持久化 scan state、candidate set、
validation results、projection plan 和 commit record。scan generation 具有
`scanning`、`validating`、`projecting`、`committed`、`failed` 和
`rolled_back` 状态。

`largeLibraryOperationalBounds.resumability` 要求每 25 个 candidate checkpoint，
恢复输入包含 `scanGeneration`、`candidateCursor`、
`validatedCandidateDigests` 和 `failedCandidateDiagnostics`。中断恢复不暴露
partial projection，也不丢弃 last committed generation。

`lockLeaseAndStagingCleanup` 定义 stale staging resume/quarantine/archive 规则。
R3 fixups 未改变该恢复模型。scanner 崩溃、进程中断或机器重启后可从持久化
扫描状态恢复，不需要重新验证全库，也不会丢失上一代可查询投影。

### F-05 bounded_validation_io：Pass

Type DD 区分快速挂载校验、首次深度校验和周期性审计：
`validationTiers.metadataOnly` 用于 unchanged manifest 与 publish marker，
`manifestAndSidecars` 用于 manifest 或 marker 变化，`fullClosure` 用于 new
package、repair、audit、suspicious metadata 和 export，`periodicAudit` 定义
every_30_days_or_100_package_changes cadence。

`maxTotalValidationBytesPerNormalScan`、`unchangedBookFullChecksumReads: 0`、
changed-book validation concurrency 和 `overValidationBudget:
defer_remaining_candidates` 共同约束常规扫描 I/O。R3 fixups 的
`scannerNoReadContracts` 还限制 mount scanner 只读取 manifest、sidecars、
publish marker、文件 metadata 和 checksums，不读取 provider payload roots、
runtime diagnostic payloads 或 credential stores。常规扫描成本与变更书包数量
相关，而不是与全库 qmd、GraphRAG、LanceDB 文件总量相关。

### F-06 transactional_projection：Pass

`mountScanTransactionModel.atomicProjectionCommit` 使用 generation、staging root、
checksum、fsync、atomic replacement 和 current-generation pointer last update。
提交目标包括 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
`graph-capabilities.yaml` 和 `qmd-projection.yaml`。读者只读取 last committed
generation pointer，不读取 partial projection。

`qmdRebuildTransaction` 对 per-book qmd projection 使用独立 staging root、
atomic rename、freshness digest 和 commit record。GraphRAG retrieval/query
能力通过 committed mount projection、`graph-capabilities.yaml`、readiness gates、
artifact metadata 和 `packageGeneration` 绑定。R3 fixups 的
`qmdAvailabilityAndReexportPolicy` 明确 readonly mounted package 的本地 projection
不会原地修改分发包，repack 会生成新的 `packageGeneration`。

catalog、全局 qmd projection 和 retrieval/query projection 均满足 old-or-new
reader view 约束，失败时保留 last-good projection。

### F-07 concurrency_control：Pass

`atomicPackageLifecycle.concurrencyBoundary` 定义 import、export、build publish
和 mount scan 的兼容锁边界，同一 `bookId` 只允许一个 writer publish 或
replace。query/list 使用 last-good catalog projection。

`largeLibraryDegradationAndMetrics.lockCompatibilityMatrix` 明确 publish、scan、
catalog commit、qmd projection、query read 和 repair 的兼容性。
`lockLeaseAndStagingCleanup` 定义 lease 字段、heartbeat、TTL、fencing token、
stale takeover、scan snapshot change policy 和 staging cleanup。锁获取失败产生
retryable diagnostics，并保持 last-good view。

R3 fixups 的 `scannerNoReadContracts` 明确 importer、mount scanner、
compatibility checker 和 query gate 的可读与不可读边界。runner、exporter、
importer、scanner 和 query 的读写边界、锁粒度、冲突处理、超时与 stale recovery
已足以支持上千本书挂载场景。

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

R3 fixups 的 `identityFieldSemantics` 明确 `bookId`、`sourceHash` 和
`packageGeneration` 参与冲突判定，`packageVersion`、`canonicalTitle` 和
`titleSlug` 不作为身份冲突依据。`schemaVersionUpgradeMatrix` 和
`compatibilityDiagnostics` 补强 schema incompatibility 的稳定诊断。
冲突检测结果稳定、可重放，不依赖扫描顺序。

### F-09 diagnostics_quarantine_scale：Pass

`quarantineAndRepairStateMachine` 定义 per-book quarantine state root、状态机、
record schema、stable validator error codes、bounded affected paths、
diagnostic digest、repair attempts 和 clear/archive transition。记录禁止
absolute path、secret text、provider payload 和 raw log content。

`largeLibraryDegradationAndMetrics.metrics` 提供总览计数器，
`diagnosticsRetention` 定义 quarantine record、scan generation 和 metrics 的保留
策略。`ioLimits` 限制每书诊断字节和 affected path 数量。R3 fixups 的
`qmdDiagnosticsSchema` 进一步要求 qmd diagnostics 稳定、有界、package-relative，
且不含 provider payloads 或 absolute paths。

大量坏包进入 quarantine 或 not_query_ready，不会阻塞健康书包挂载，也不会移除
last-good projection。

### F-10 large_library_tests：Pass

Type DD 要求 1000 valid mounted packages normal scan、50 changed packages
bounded validation、中断恢复、projection commit failure、concurrent query
old/new generation、100 package deletion atomic cleanup 等大库测试。

`largeLibraryDegradationAndMetrics.metrics` 和 `progressEvents` 定义 mounted book
count、candidate count、changed count、validation bytes、commit duration、
lock wait、retry count、scan/projection progress events 等观测输出。
`faultInjectionTests` 覆盖 lock contention、scan interruption、fsync failure、
stale lock takeover、validation byte budget、package count over limit 和
quarantine retention cleanup。

`lockLeaseAndStagingCleanup.concurrentTestMatrix` 覆盖 publisher/scanner/query
并发、manifest 变化、root 删除、stale lock 和 staging cleanup。R3 fixups 的
fixture、qmd 诊断和 re-export/repack 测试不会替代大库测试，但增强了相邻状态的
负向覆盖。固定判据要求的大规模 fixture、恢复、并发、性能预算断言、
metrics/progress 和故障注入均已覆盖。

## pass_fail

总体判定：Pass。

主 Type DD 与规范性 R3 fixups 合并评估后，满足 agent-03-large-library 固定
10 维 baseline。R3 已通过的大规模挂载设计在 R4 中未发生回退；R3 fixups 对
身份、no-read、qmd availability、qmd diagnostics 和迁移证据的补充增强了本场景
的冲突稳定性、I/O 边界和诊断边界。

| baseline id | R4 result | 结论 |
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

## criteria_delta_from_r3

baseline 判据变化：无。R4 继续使用与 R3、R2、初始 agent-03 相同的 10 个
dimension id、name 和 passCriteria；没有新增、删除、重排、重命名维度，也没有
改变 passCriteria。

评估结果相对 R3 的变化如下：

| baseline id | R3 result | R4 result | delta |
| --- | --- | --- | --- |
| scale_objectives | Pass | Pass | 无判据变化；R3 fixups 未削弱规模预算 |
| incremental_change_detection | Pass | Pass | 无判据变化；qmd 幂等键增强重建边界 |
| atomic_package_visibility | Pass | Pass | 无判据变化；repack publish rule 增强原子发布 |
| resumable_scan_state | Pass | Pass | 无判据变化；恢复模型保持一致 |
| bounded_validation_io | Pass | Pass | 无判据变化；scanner no-read 合同增强 I/O 边界 |
| transactional_projection | Pass | Pass | 无判据变化；qmd re-export/repack 语义更明确 |
| concurrency_control | Pass | Pass | 无判据变化；actor read/no-read 边界更明确 |
| conflict_indexing | Pass | Pass | 无判据变化；identity semantics 增强冲突稳定性 |
| diagnostics_quarantine_scale | Pass | Pass | 无判据变化；qmd diagnostics schema 增强诊断边界 |
| large_library_tests | Pass | Pass | 无判据变化；补充测试不替代既有大库测试 |

R3 agent-03 总体判定为 Pass；R4 agent-03 总体判定仍为 Pass。

## required_design_changes

无阻断设计变更 (blocking design changes)。

固定 10 维 baseline 下，主 Type DD 与 R3 fixups 已满足大库挂载场景的设计判据。
后续实现必须保持以下已写入 Type DD 的契约，不应在实现中弱化：

1. `largeLibraryDegradationAndMetrics.scaleLimits` 的文件数、字节数、候选目录
   和 validation byte budget。
2. `mountScanTransactionModel.changedSetDetection` 的 unchanged metadata-only
   扫描规则。
3. `mountScanTransactionModel.atomicProjectionCommit` 的 staging、fsync、rename
   和 last-good generation 读模型。
4. `lockLeaseAndStagingCleanup` 的 fencing token、stale takeover 和 staging
   cleanup 规则。
5. `catalogProjectionSchemas.conflictIndex` 与 R3 `identityFieldSemantics` 的
   确定性冲突判定规则。
6. `quarantineAndRepairStateMachine`、`largeLibraryDegradationAndMetrics` 和
   R3 `qmdDiagnosticsSchema` 的有界诊断、保留和恢复入口。

## residual_risks

1. 性能预算是设计合同，尚需实现阶段用真实或 synthetic 1000+ package fixture
   验证 60 秒 normal scan、10 秒 catalog commit、1024 MB 内存上限和 50 GB
   normal validation byte budget。
2. `rootDirectoryMtime` 在不同文件系统、网络盘或批量复制工具下可能不稳定；
   实现需要把 manifest digest、publish marker digest 和 `packageGeneration`
   作为主信号，mtime 只能作为辅助 suspicion trigger。
3. 大规模 lock contention、stale lease takeover 和 projection swap 依赖精确
   fsync/rename 语义；跨平台文件系统差异需要在实现测试中覆盖。
4. 周期性 audit 的抽样策略已定义 cadence 和 scope，但还需要实现时固定抽样
   方法，避免长期遗漏冷门坏包。
5. metrics/progress 已有字段合同，但告警阈值、dashboard 和运维 runbook 尚未
   在 Type DD 中展开；这不是本固定 baseline 的阻断项。
