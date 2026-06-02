# agent-03-large-library R2 复审报告

## scenario

一个 vault 同时挂载上千本书，mount scan 需要可扩展
(scalable)、可恢复 (resumable)，并在导入、构建、复制、删除、扫描和查询
并发发生时保持 catalog、qmd projection 与 retrieval projection 的一致性。

审计对象为
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本复审未读取
provider payload、secrets、请求响应载荷或密钥相关文件。

## reused_fixed_baseline

本复审复用 R2 目录中已存在的固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-03-large-library/baseline.yaml`

该基线来自 R1 `agent-03-large-library/baseline.yaml`，固定 10 个维度：

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
| R2 baseline 是否存在 | Pass |
| R2 baseline 是否复用 R1 固定基线 | Pass |
| R1/R2 baseline SHA-256 | `68e6756cf0b2c2b60f9a6499cace1fa82c3464bf89cae9440798ead974f90afe` |
| R1/R2 baseline 文件比较 | Pass，`cmp` 结果一致 |
| 维度数量 | Pass，仍为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重命名或重排 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，复审未覆盖 baseline.yaml |

## findings

### F-01 scale_objectives：Partial

修订版新增 `largeLibraryOperationalBounds`，明确了 1000 本 mounted book、
1500 个 candidate directory、50 本 normal scan changed books、60 秒 normal
scan、10 秒 catalog commit、1024 MB 内存上限、4 路 changed-book validation
并发，以及 unchanged book 不做 full checksum read。这已经修复 R1 中完全缺少
规模目标的问题。

仍未完全满足固定判据。Type DD 尚未声明最大文件闭包规模
(maximum file closure scale)，例如单书最大文件数、单书最大字节数、
单次 manifest entries 上限、全库 projection 输入上限和超限退化策略。I/O
预算也主要以 `unchangedBookFullChecksumReads: 0` 表达，缺少 changed package
深度校验的字节级或吞吐级约束。退化策略仍停留在 suspicion trigger 与 audit
mode，没有说明超过 1000/1500 目标、内存压力、磁盘慢速或大量坏包时的降级
行为。

### F-02 incremental_change_detection：Pass

修订版在 `mountScanTransactionModel.changedSetDetection` 中定义了
`bookId`、`packageGeneration`、`manifestSha256`、`manifestBytes`、
`publishMarkerSha256` 和 `rootDirectoryMtime` 等 digest input。正常扫描要求
未变更包只通过 digest metadata 校验，新包、变更包、可疑 metadata、显式
audit 和 pre-export audit 才执行 full file checksum verification。

`deletionAndReplacement` 同时覆盖删除、同 bookId 新 generation、失败替换与
stale projection cleanup。该设计满足“只处理新增、删除或变更书包，未变更
书包不得每次完整校验或重建”的固定判据。

### F-03 atomic_package_visibility：Pass

修订版定义了 import/build staging root、`PUBLISH_READY.json`、manifest-last
write、checksum-last commit、fsync、atomic rename 和 scanner visibility
rule。scanner 必须忽略缺少有效 `BOOK_MANIFEST.json`、manifest sidecar 和
`PUBLISH_READY.json` 的目录。

该设计能阻止复制、导入、构建和迁移中的半成品目录进入 catalog 或 qmd
projection，满足固定判据。

### F-04 resumable_scan_state：Pass

修订版在 `mountScanTransactionModel.scanState` 中定义持久化 scan state、
candidate set、validation results、projection plan 和 commit record，并用
scan generation 状态表示扫描、校验、投影、提交、失败和 rollback。

`largeLibraryOperationalBounds.resumability` 要求每 25 个 candidate checkpoint，
并保存 `scanGeneration`、`candidateCursor`、`validatedCandidateDigests` 和
`failedCandidateDiagnostics`。中断后恢复不暴露 partial projection，也不丢弃
last committed generation。该设计满足 scanner 崩溃、中断或重启后的恢复判据。

### F-05 bounded_validation_io：Partial

修订版已经把正常扫描与全量审计分开。正常模式使用 unchanged book digest
metadata，audit mode 才对所有书包做 full checksum；新包、变更包、可疑
metadata 和 pre-export audit 触发深度校验。这使常规扫描成本与变更集相关，
不再与所有 qmd、GraphRAG、LanceDB 文件总量直接相关。

缺口是 Type DD 没有把三个校验层级作为明确契约命名并固化：
快速挂载校验 (fast mount validation)、首次深度校验
(first deep validation)、周期性审计 (periodic audit)。`auditMode` 存在，但
没有审计周期、节流、后台执行、进度输出或与 query-ready 状态的关系。

### F-06 transactional_projection：Pass

修订版定义了 generation-based mount scan transaction、projection staging
root、committed roots、fsync/atomic replacement、current-generation pointer
last update，以及 query/list 只读 last committed generation pointer。

`failureRule` 和 `lastGoodRule` 明确失败时保留 last-good reader view，读者
只能看到完整旧版本或完整新版本。catalog 与 qmd projection 已满足固定判据。
retrieval projection 的细节仍依赖后续实现模块，但 Type DD 已把 query-ready
能力绑定到 committed mount projection 和 packageGeneration。

### F-07 concurrency_control：Partial

修订版补充了 publish lock、scan lock、catalog commit lock、qmd projection
lock、锁获取顺序和 lock acquisition timeout 行为。import、export、build
publish 与 mount scan 需要 compatible locks；query/list 使用 last-good
generation，runtime diagnostics 和 import state 被放到 package root 外部。

仍未完全满足“明确锁粒度和冲突处理”的固定判据。`book-package-publish.lock`
看起来是 vault 级锁，但规则又声明“同一 bookId 只能一个 writer”，两者粒度
不一致。Type DD 也没有定义 compatible lock matrix、query reader pin 细节、
owner/heartbeat/stale lock recovery，或者 runner/exporter/importer/scanner
同时操作不同 bookId 时是否可以并行。

### F-08 conflict_indexing：Partial

修订版保留并补强了冲突枚举：same bookId different sourceHash fail closed、
same sourceHash different bookId report duplicate candidate、missing file 与
checksum mismatch quarantine、incompatible schema visible not query ready。
validation pipeline 也要求校验 identity conflicts 和 schema compatibility。

固定判据要求通过可扩展索引检测 same bookId、same sourceHash、schema
incompatibility 与 duplicate candidate，并保证稳定、可重放、与扫描顺序无关。
Type DD 尚未定义 `bookId -> package digest`、`sourceHash -> bookIds`、
schema compatibility index、stable sort、tie-breaker、上一代保留规则或冲突
诊断的确定性写入顺序。因此该维度仍未通过。

### F-09 diagnostics_quarantine_scale：Partial

修订版新增 quarantine root、incomplete package policy、external runtime
layout、per-package failure rule、readiness state 和 migration residue quarantine。
坏包被标记为 not_mounted 或 not_query_ready，且不得破坏其他有效 package 的
projection。这修复了 R1 中“坏包可能阻塞健康书包”的核心风险。

固定判据还要求 per-book 诊断结构、总览摘要、大小上限、保留策略和恢复入口。
Type DD 目前只说明诊断与 runtime state 的位置，没有 schema、summary index、
retention、size cap、retry/recover command 或大量坏包场景下的诊断写入节流。
该维度仍为部分满足。

### F-10 large_library_tests：Partial

修订版新增了 1000 valid mounted packages normal scan、50 changed packages
bounded validation、mid-validation interruption resume、projection commit
failure preserves last-good generation、concurrent query old/new generation、
100 package deletion atomic cleanup，以及 thousand-book normal scan budget
断言。测试契约比 R1 明显增强。

固定判据还要求 metrics/progress 输出和故障注入用例。当前 Type DD 没有定义
scanner metrics schema、progress event、预算断言的观测点，也没有覆盖 lock
timeout、stale lock、坏包风暴、半包复制风暴、cache corruption、慢磁盘、
read-only package runtime write、concurrent runner/exporter/importer/scanner
等故障注入测试。因此该维度仍未完全满足。

## pass_fail

总体判定：Fail。修订版已经解决 R1 的大多数结构性缺口，但固定 10 维基准中
仍有 6 个维度仅部分满足，尚不能判定为上千本书大库挂载场景的生产级通过。

| baseline id | result | R2 结论 |
| --- | --- | --- |
| scale_objectives | Partial | 有千本级预算，但缺最大文件闭包、字节级 I/O 与退化策略 |
| incremental_change_detection | Pass | changed-set detection 与删除/替换规则满足判据 |
| atomic_package_visibility | Pass | staging、ready marker、manifest-last、atomic rename 满足判据 |
| resumable_scan_state | Pass | scan generation、checkpoint、cursor 与 last-good view 满足判据 |
| bounded_validation_io | Partial | 正常/审计模式已分离，但缺首次深度与周期性审计完整契约 |
| transactional_projection | Pass | generation、staging、fsync/rename、last-good reader view 满足判据 |
| concurrency_control | Partial | 有锁和边界，但锁粒度、兼容矩阵与 stale recovery 不充分 |
| conflict_indexing | Partial | 有冲突结果枚举，但缺可扩展、确定性索引 |
| diagnostics_quarantine_scale | Partial | 坏包不阻塞健康包，但缺 per-book schema、摘要、保留和恢复入口 |
| large_library_tests | Partial | 有千本与恢复测试，但缺 metrics/progress 与充分故障注入 |

## criteria_delta_from_r1

基线判据变化：无。R2 复审使用与 R1 完全相同的 10 个 dimension id、name 与
passCriteria；没有新增、删除、重命名维度，也没有改变 passCriteria。

评估结果相对 R1 的变化如下：

| baseline id | R1 结果 | R2 结果 | 变化 |
| --- | --- | --- | --- |
| scale_objectives | Fail | Partial | 新增千本级预算，但仍缺文件闭包和退化策略 |
| incremental_change_detection | Fail | Pass | 新增 digest metadata changed-set detection |
| atomic_package_visibility | Partial | Pass | 新增 staging、ready marker 与 atomic publish |
| resumable_scan_state | Fail | Pass | 新增 scan generation、checkpoint 与 last-good view |
| bounded_validation_io | Fail | Partial | 新增 normal/audit 模式，但校验层级仍不完整 |
| transactional_projection | Fail | Pass | 新增事务化 projection commit |
| concurrency_control | Fail | Partial | 新增锁文件和顺序，但粒度与兼容矩阵仍不足 |
| conflict_indexing | Partial | Partial | 冲突枚举保留，仍缺可扩展确定性索引 |
| diagnostics_quarantine_scale | Partial | Partial | 隔离增强，但诊断结构和保留策略仍不足 |
| large_library_tests | Fail | Partial | 新增千本和恢复测试，仍缺 metrics/progress 与故障注入 |

## required_design_changes

1. 在 `largeLibraryOperationalBounds` 中补充最大文件闭包规模：单书最大文件数、
   单书最大字节数、单次 manifest entry 上限、全库 candidate/projection 输入
   上限，以及超过上限时的分片扫描、后台队列、跳过策略或 fail-closed 规则。

2. 把 I/O 与退化策略转化为实现约束：changed package 深度校验的最大并发、
   每秒或每轮最大读取字节、慢磁盘节流、内存压力下的 batch size 降级，以及
   超预算时对 query/list reader 的 last-good 行为。

3. 明确 validation levels：`fast_mount_validation`、
   `first_deep_validation`、`periodic_background_audit`。为周期性审计定义
   cadence、throttle、checkpoint、progress、失败诊断和 query-ready 影响。

4. 补充并发锁矩阵：runner、exporter、importer、scanner、qmd reindexer 和
   query reader 的读写锁兼容性、per-book 与 vault-level 粒度、owner、
   heartbeat、timeout、stale lock recovery 和跨 bookId 并行规则。

5. 增加冲突索引契约：`bookId -> packageGeneration/manifestSha256`、
   `sourceHash -> bookIds`、`documentId -> bookId/sourceHash`、schema
   compatibility index、stable sort、tie-breaker、上一代 query-ready 保留
   规则和确定性 conflict diagnostics。

6. 增加大规模 diagnostics/quarantine schema：per-book 状态文件、summary
   index、severity、firstSeen、lastSeen、retryAfter、recoveryAction、最大
   条目数、最大字节数、保留周期、清理策略和恢复命令入口。

7. 扩展测试与可观测性契约：scanner metrics schema、progress event、
   performance budget assertion 的采样点，以及 lock timeout、stale lock、
   cache corruption、半包复制风暴、坏包风暴、慢磁盘、并发
   runner/exporter/importer/scanner 的故障注入用例。

## residual_risks

- 首次导入或首次深度校验 1000 本大书仍可能受磁盘吞吐限制；没有字节级预算
  和后台审计节流时，scanner 可能长时间占用 I/O。
- 当前 publish lock 表述可能导致实现选择 vault 级串行发布，在多书并行导入
  时形成可扩展性瓶颈。
- 如果 vault 位于网络文件系统、云同步目录或外接盘，atomic rename、
  `rootDirectoryMtime` 和 lock heartbeat 的可靠性需要单独约束。
- qmd book index 仍是 open question；大量书包缺失索引时，mount 后 reindex
  队列可能成为新的大库瓶颈。
- 诊断和 quarantine 若没有大小上限与清理策略，坏包风暴会把可恢复性问题转化
  为状态目录膨胀和扫描启动延迟。
