# agent-03-large-library R6 固定基准复审报告

## scenario

一个 vault 同时挂载上千本书，mount scan 需要可扩展 (scalable)、
可恢复 (resumable)，并在复制、导入、构建、迁移、删除、扫描和查询并发
发生时保持 catalog、qmd projection 与 retrieval/query projection 的一致性。

评估文档：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

复审范围仅限设计文档是否满足固定 baseline 的 10 个 passCriteria。复审未读取
provider payload、secrets、`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

本轮复审复用指定 R6 固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-03-large-library/baseline.yaml`

baseline SHA-256：

`68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe`

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
| R6 baseline 是否存在 | Pass |
| baseline SHA-256 | `68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe` |
| R6 baseline 与 R5 agent-03 baseline 比较 | Pass，SHA 一致 |
| 维度数量 | Pass，固定为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重排、重命名 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，未覆盖 baseline.yaml |

## findings

### F-01 scale_objectives：Pass

主 Type DD 的 `largeLibraryOperationalBounds` 明确目标规模：1000 本 mounted
book、1500 个 candidate directory、常规扫描 50 本 changed book。
`performanceBudgets` 定义 60 秒 normal scan、10 秒 catalog commit、1024 MB
内存上限、4 路 changed-book validation concurrency，以及 unchanged book
不执行 full checksum read。

`largeLibraryDegradationAndMetrics` 补充最大文件闭包 (maximum file closure)：
单书 25000 files、单书 5 GB、normal scan 最多 50 GB validation bytes、
最多保留 10000 条 quarantine record。候选目录超限、单包文件超限、字节
超限、validation budget 超限、低磁盘空间和锁竞争均有退化策略。R3 与 R5
补充没有放松这些规模合同；R5 的 staged import、qmd actor lock、GraphRAG
artifact gate 和迁移重跑条款把相邻流程也绑定到 generation、validation 和
fail-closed 边界。

### F-02 incremental_change_detection：Pass

`mountScanTransactionModel.changedSetDetection` 使用 `bookId`、
`packageGeneration`、`manifestSha256`、`manifestBytes`、
`publishMarkerSha256` 和 `rootDirectoryMtime` 形成 changed-set digest。
正常扫描只对 unchanged package 执行 digest metadata 校验；新包、变更包、
可疑 metadata、显式 audit mode 和 pre-export audit 才执行 full file
checksum。

`largeLibraryDegradationAndMetrics.validationTiers` 将 metadata-only、
manifest-and-sidecars、full-closure 和 periodic-audit 分层。R3 的
`qmdAvailabilityAndReexportPolicy` 与 R5 的 `qmdCanonicalIdempotencyAndDiagnostics`
要求 qmd rebuild 使用 `packageGeneration`、freshness digest、manifest sha256
和 canonical idempotency key，不会把未变更书包误触发为全量重建。

### F-03 atomic_package_visibility：Pass

`atomicPackageLifecycle` 定义 import/build staging root、`PUBLISH_READY.json`、
manifest-last write、checksum-last commit、fsync、atomic rename 和 scanner
visibility rule。scanner 必须忽略缺少有效 `BOOK_MANIFEST.json`、manifest
checksum sidecars 或 `PUBLISH_READY.json` 的目录。

直接复制目录被支持，但只有 publish marker、manifest 与 checksum 全部验证后
才进入 mount projection。R5 的 `importerPrePublishValidationContract` 进一步
要求 staged importer 在 live-root rename 前完成 schema、checksum、path、
required-file、compatibility、identity、sensitivity 和 producer-evidence
validation。导入失败保持 live root 不变，并把有界诊断写到 local runtime
state，而不是分发包内。

### F-04 resumable_scan_state：Pass

`mountScanTransactionModel.scanState` 定义持久化 scan state、candidate set、
validation results、projection plan 和 commit record。scan generation 具有
`scanning`、`validating`、`projecting`、`committed`、`failed` 和
`rolled_back` 状态。

`largeLibraryOperationalBounds.resumability` 要求每 25 个 candidate checkpoint，
恢复输入包含 `scanGeneration`、`candidateCursor`、
`validatedCandidateDigests` 和 `failedCandidateDiagnostics`。中断恢复不暴露
partial projection，也不丢弃 last committed generation。R5 的
`migrationRerunIdempotencyContract` 对迁移重跑也要求从 evidence 和 copy-map
checkpoint 恢复，避免重复移动、覆盖用户 metadata 或改变已验证 package
identity。

### F-05 bounded_validation_io：Pass

Type DD 区分快速挂载校验、首次深度校验和周期性审计：
`metadataOnly` 用于 unchanged manifest 与 publish marker，
`manifestAndSidecars` 用于 manifest 或 marker 变化，`fullClosure` 用于 new
package、repair、audit、suspicious metadata 和 export，`periodicAudit` 定义
every_30_days_or_100_package_changes cadence。

`maxTotalValidationBytesPerNormalScan`、`unchangedBookFullChecksumReads: 0`、
changed-book validation concurrency 和 `overValidationBudget:
defer_remaining_candidates` 共同约束常规扫描 I/O。R3 的 `scannerNoReadContracts`
限制 mount scanner 只读取 manifest、sidecars、publish marker、文件 metadata
和 checksums；R5 的 manifest-first direct query 同样禁止 provider payload
roots、provider logs、raw prompts、raw completions、secrets 和 absolute local
paths 参与 readiness 判定。

### F-06 transactional_projection：Pass

`mountScanTransactionModel.atomicProjectionCommit` 使用 generation、staging root、
checksum、fsync、atomic replacement 和 current-generation pointer last update。
提交目标包括 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
`graph-capabilities.yaml` 和 `qmd-projection.yaml`。读者只读取 last committed
generation pointer，不读取 partial projection。

`qmdRebuildTransaction` 对 per-book qmd projection 使用独立 staging root、
atomic rename、freshness digest 和 commit record。R5 的
`qmdReindexActorLockMatrix` 要求 committed qmd projection 记录 bookId、
packageGeneration、idempotencyKey、freshnessDigest、writerActor、fencingToken、
committedAt 和 source manifest sha256，读者必须忽略与当前 package 不匹配的
projection。R5 的 GraphRAG artifact gate 对 rollback 规定 preserve
last-good generation，满足完整旧版本或完整新版本的读视图。

### F-07 concurrency_control：Pass

`atomicPackageLifecycle.concurrencyBoundary` 定义 import、export、build publish
和 mount scan 的兼容锁边界，同一 `bookId` 只允许一个 writer publish 或
replace。query/list 使用 last-good catalog projection。

`largeLibraryDegradationAndMetrics.lockCompatibilityMatrix` 明确 publish、scan、
catalog commit、qmd projection、query read 和 repair 的兼容性。
`lockLeaseAndStagingCleanup` 定义 lease 字段、heartbeat、TTL、fencing token、
stale takeover、scan snapshot change policy 和 staging cleanup。R5 的
`qmdReindexActorLockMatrix` 将 mount scanner、importer、batch runner、
explicit rebuild command 和 query reader 的 enqueue/build/commit 权限固定成
actor 矩阵，避免 scanner 或 reader 覆盖运行态状态。

### F-08 conflict_indexing：Pass

`catalogProjectionSchemas.conflictIndex` 定义
`graph_vault/catalog/book-conflicts.yaml`，包含 `byBookId`、`bySourceHash` 和
`byBookIdAndSourceHash` 索引，并用 `sourceHash`、`bookId`、
`packageGeneration`、`manifestSha256` 作为 deterministic ordering。

R3 的 `identityFieldSemantics` 明确 `bookId`、`sourceHash` 和
`packageGeneration` 参与冲突判定，`packageVersion`、`canonicalTitle` 和
`titleSlug` 不作为身份冲突依据。R5 的 `migrationConflictDecisionTable`
补充 same bookId different sourceHash、same sourceHash different bookId、
target live root exists、manifest identity mismatch 和 generation conflict 的
fail-closed 默认结果与 manual decision record。冲突检测稳定、可重放，不依赖
扫描顺序。

### F-09 diagnostics_quarantine_scale：Pass

`quarantineAndRepairStateMachine` 定义 per-book quarantine state root、状态机、
record schema、stable validator error codes、bounded affected paths、
diagnostic digest、repair attempts 和 clear/archive transition。记录禁止
absolute path、secret text、provider payload 和 raw log content。

`largeLibraryDegradationAndMetrics.metrics` 提供总览计数器，
`diagnosticsRetention` 定义 quarantine record、scan generation 和 metrics 的
保留策略。`ioLimits` 限制每书诊断字节和 affected path 数量。R5 的
`graphRagArtifactGateStateMachine` 要求 checksum mismatch、unsafe path、
corrupt sidecar 或 payload leak 进入 quarantined，并保留 stable diagnostic
code 与 quarantine record。大量坏包不会阻塞健康书包挂载，也不会移除
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
quarantine retention cleanup。R5 的 `fixedBaselineTestContracts` 增补 staged
import、direct copy fail closed、runner staging invisibility、publish fencing、
qmd concurrent reindex、manifest-first query、artifact gate 和 migration
cleanup 的可执行 fixture 合同，没有替代或削弱千本库测试要求。

## pass_fail

总体判定：Pass。

主 Type DD、R3 fixups 与 R5 fixups 合并评估后，满足 agent-03-large-library
固定 10 维 baseline。R5 补充没有改变审计维度，而是增强导入、qmd 投影并发、
GraphRAG query gate、artifact readiness、迁移重跑和冲突处理的可执行设计合同。

| baseline id | R6 result | 结论 |
| --- | --- | --- |
| scale_objectives | Pass | 规模、文件闭包、资源预算和退化策略已声明 |
| incremental_change_detection | Pass | changed-set digest 与 unchanged skip 已覆盖 |
| atomic_package_visibility | Pass | staging、ready marker、manifest-last、pre-publish validation 和 rename 已覆盖 |
| resumable_scan_state | Pass | scan state、checkpoint、cursor、last-good view 和迁移重跑恢复已覆盖 |
| bounded_validation_io | Pass | metadata、sidecar、full closure、periodic audit 与 no-read 边界已分层 |
| transactional_projection | Pass | catalog、qmd、retrieval/query projection 有事务边界 |
| concurrency_control | Pass | 锁矩阵、actor 权限、lease、fencing 和 stale recovery 已覆盖 |
| conflict_indexing | Pass | identity、source、duplicate、schema 与 migration conflict 可稳定检测 |
| diagnostics_quarantine_scale | Pass | per-book 诊断、摘要、保留、隔离和恢复入口已覆盖 |
| large_library_tests | Pass | 千本测试、metrics/progress、并发测试和故障注入已覆盖 |

## criteria_delta_from_previous_run

baseline 判据变化：无。R6 baseline 与 R5 agent-03 baseline SHA 一致，继续使用同
一组 10 个 dimension id、name 和 passCriteria；没有新增、删除、重排、重命名
维度，也没有改变 passCriteria。

评估结果相对上一轮 R5 的变化如下：

| baseline id | R5 result | R6 result | delta |
| --- | --- | --- | --- |
| scale_objectives | Pass | Pass | 无判据变化；R5 补充未改变规模预算 |
| incremental_change_detection | Pass | Pass | 无判据变化；R5 补充增强 qmd idempotency 边界 |
| atomic_package_visibility | Pass | Pass | 无判据变化；R5 补充增强 staged import pre-publish validation |
| resumable_scan_state | Pass | Pass | 无判据变化；R5 补充增强 migration rerun checkpoint 语义 |
| bounded_validation_io | Pass | Pass | 无判据变化；R5 补充增强 manifest-first no-read 约束 |
| transactional_projection | Pass | Pass | 无判据变化；R5 补充增强 qmd projection ownership invariant |
| concurrency_control | Pass | Pass | 无判据变化；R5 补充增强 qmd actor lock matrix |
| conflict_indexing | Pass | Pass | 无判据变化；R5 补充增强 migration conflict decision table |
| diagnostics_quarantine_scale | Pass | Pass | 无判据变化；R5 补充增强 GraphRAG gate quarantine 状态 |
| large_library_tests | Pass | Pass | 无判据变化；R5 补充增加 fixed-baseline fixture contracts |

上一轮 agent-03 总体判定为 Pass；本轮 agent-03 总体判定仍为 Pass。

## required_design_changes

无阻断设计变更 (blocking design changes)。

固定 10 维 baseline 下，主 Type DD、R3 fixups 与 R5 fixups 已满足大库挂载
场景的设计判据。后续实现必须保持以下已写入 Type DD 的合同，不应在实现中
弱化：

1. `largeLibraryDegradationAndMetrics.scaleLimits` 的文件数、字节数、候选目录
   和 validation byte budget。
2. `mountScanTransactionModel.changedSetDetection` 的 unchanged metadata-only
   扫描规则。
3. `mountScanTransactionModel.atomicProjectionCommit` 的 staging、fsync、rename
   和 last-good generation 读模型。
4. `lockLeaseAndStagingCleanup` 与 R5 `qmdReindexActorLockMatrix` 的 fencing
   token、stale takeover、actor 权限和 projection ownership invariant。
5. `catalogProjectionSchemas.conflictIndex`、R3 `identityFieldSemantics` 和 R5
   `migrationConflictDecisionTable` 的确定性冲突判定规则。
6. `quarantineAndRepairStateMachine`、`largeLibraryDegradationAndMetrics`、R3
   `qmdDiagnosticsSchema` 和 R5 `graphRagArtifactGateStateMachine` 的有界诊断、
   保留和恢复入口。

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
5. R5 的 manifest-first direct query 放宽了对 catalog cache 的可用性依赖；
   实现需要严格保持 cache mismatch policy，防止 stale cache 覆盖 manifest、
   hash、schema 或 lineage failure。
6. metrics/progress 已有字段合同，但告警阈值、dashboard 和运维 runbook 尚未
   在 Type DD 中展开；这不是本固定 baseline 的阻断项。
