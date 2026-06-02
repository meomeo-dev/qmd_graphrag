# agent-07-concurrent-runner R3 复审报告

## scenario

batch runner 正在构建 `graph_vault/books/{bookId}` 或相邻产物时，
另一个流程同时执行 mount scan/import。复审重点是确认修订后的
Type DD 是否避免半成品被投影、目录竞争、catalog 覆盖、校验竞态
和运行状态互相污染。

审计对象为
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
本次复审未读取 provider payload、secrets、请求响应日志或私有运行载荷。

## reused_fixed_baseline

复审复用 R3 输出目录中已存在的固定基线文件：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-07-concurrent-runner/baseline.yaml`

固定 10 维如下，未新增、删除、重排、重命名维度，未改变
`passCriteria`：

| id | name | R3 判定 |
| --- | --- | --- |
| CR-01 | 构建中书包不可见 | 通过 |
| CR-02 | 原子提交协议 | 通过 |
| CR-03 | 导入暂存隔离 | 通过 |
| CR-04 | 扫描快照一致性 | 通过 |
| CR-05 | Catalog 原子投影 | 通过 |
| CR-06 | 锁与租约边界 | 通过 |
| CR-07 | Query-ready 门禁抗竞态 | 通过 |
| CR-08 | 可变状态互不污染 | 通过 |
| CR-09 | 冲突与删除竞态可恢复 | 通过 |
| CR-10 | 并发测试可实施性 | 通过 |

## baseline_integrity_check

- baseline SHA-256:
  `8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`
- baseline 维度数量：10。
- R3 baseline 与 R2 agent-07 baseline 字节一致，SHA-256 相同。
- baseline 中 `id`、`name`、顺序和 `passCriteria` 均保持不变。
- 本次复审未覆盖 `baseline.yaml`，仅写入 `report.md`。
- passCriteria 差异 (criteria delta)：0。

## findings

### CR-01 构建中书包不可见

判定：通过。

`atomicPackageLifecycle` 明确规定书包只有在所有 required artifact、
checksum sidecar 和 `BOOK_MANIFEST.json` sidecar 完成原子发布后才
mount-visible。`writableRoots.buildStagingRoot` 将 batch runner 的构建期
输出固定在 `graph_vault/.staging/builds/{runId}/{bookId}`，而 scanner 的
可见根仍是 live root。`visibilityRule` 还要求缺少有效 manifest、manifest
sidecar 或 `PUBLISH_READY.json` 的目录必须被忽略。该组合满足构建未完成前
不得暴露可扫描权威的基准。

### CR-02 原子提交协议

判定：通过。

`publishProtocol.requiredOrder` 定义了 staging 目录写入、文件 checksum
生成、`BOOK_MANIFEST.json` 生成、manifest checksum sidecar 生成、
`PUBLISH_READY.json` 写入、fsync，以及 staging book root 到 live root 的
原子 rename。`manifestLastWriteRule` 和 `checksumLastCommitRule` 明确要求
manifest 与 sidecar 在被引用文件之后提交。失败构建停留在 `.staging`
边界内，不形成可挂载状态。

### CR-03 导入暂存隔离

判定：通过。

导入流程由 `writableRoots.importStagingRoot` 隔离到
`graph_vault/.staging/imports/{importId}/{bookId}`。同一发布协议要求 import
先完成复制、checksum、manifest、sidecar、publish marker 和验证，再通过
原子发布进入 `books/{bookId}`。半复制目录缺少完整发布标记或校验闭包时，
scanner 只能产生 incomplete/quarantine 诊断，不得投影为 mounted book。

### CR-04 扫描快照一致性

判定：通过。

R3 修订补足了 R2 的稳定快照缺口。`mountScanTransactionModel` 以
`scanGeneration`、`inputDigest`、candidate set、validation results 和
projection plan 组成一次扫描事务。`changedSetDetection.digestInputs`
覆盖 `bookId`、`packageGeneration`、`manifestSha256`、manifest bytes、
`publishMarkerSha256` 和 root mtime。

`lockLeaseAndStagingCleanup.scanSnapshotChangePolicy` 进一步规定候选变化时
有限重试后 defer、manifest 验证后变化时标记 changed 并重试、publish marker
提交前变化时重建 projection plan、root 删除时只在稳定后移出候选集，重复变化
则推迟到下一 scan generation。该规则满足扫描期间 manifest、checksum、
目录 mtime、generation 或文件闭包变化时重试或跳过候选的基准。

### CR-05 Catalog 原子投影

判定：通过。

`atomicProjectionCommit` 将 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和可选
`qmd-projection.yaml` 写入
`graph_vault/catalog/.staging/mount-scan-{scanGeneration}`，完成 checksum、
fsync 后再原子替换。`current-generation pointer` 最后更新，
`lastGoodRule` 要求查询和列表命令只读最后提交的完整 generation。
并发扫描不会暴露部分更新或跨 generation 的混合 catalog。

### CR-06 锁与租约边界

判定：通过。

`concurrencyBoundary` 规定 import、export、build publish 和 mount scan
必须获取兼容锁，同一 `bookId` 同时只能有一个 writer 发布或替换。R3 新增
`lockLeaseAndStagingCleanup.leases`，定义 `leaseId`、`lockName`、
`holderPid`、`holderSessionId`、`bookId`、`scanGeneration`、
`packageGeneration`、heartbeat、TTL 和 fencing token。stale lease 只有在
过期、holder 不再有效且 fencing token 匹配时才可接管，否则 fail closed 并保留
last-good view。该设计满足 writer 冲突 fail closed 或重试、reader 读取稳定
投影的基准。

### CR-07 Query-ready 门禁抗竞态

判定：通过。

`readinessGates` 将 mounted、qmd-ready、GraphRAG-ready 和 `query_ready`
分离。qmd freshness inputs 包含 `bookId`、`sourceHash`、normalized hash、
qmd schema、tool version、embedding profile 和 required artifacts。
GraphRAG gate 要求 minimum artifact closure、producer lineage、stage order
和 artifact-lineage binding。

`queryEntrypoint.commandContract` 要求查询通过 committed mount projection
解析当前 `packageGeneration`，验证 `query_ready`，并拒绝 stale 或 cross-book
artifact。`staleProjectionInvalidation` 要求 generation、manifest checksum、
schema、qmd freshness input 或 lineage 变化时，在同一 projection commit 中
移除 query-ready capability。因此并发 build/import 不能提前置真 query-ready。

### CR-08 可变状态互不污染

判定：通过。

`writableRoots` 将 live root、import staging、build staging、quarantine 和
runtime state 分离。`immutablePackagePolicy` 要求发布后的 shared package
默认只读，runtime writes、local query caches、repair diagnostics 和 import
state 写入 `runtimeStateRoot` 或 catalog scan state，而不是 package root。
`externalRuntimeLayout` 又将 mount scan generation、qmd projection 和本地运行
状态放在包外路径。scanner/importer 没有写入 runner checkpoint、artifact 或
producer evidence 的合同入口。

### CR-09 冲突与删除竞态可恢复

判定：通过。

R3 修订补齐了 R2 剩余的恢复规则。并发 build/import 由同一 `bookId`
single-writer 发布锁约束；替换由
`deletionAndReplacement.sameBookIdNewGeneration: replace_after_full_validation`
和 `failedReplacement: keep_previous_generation_if_present` 约束；删除时扫描由
`onRootDeletedBeforeCommit: remove_from_candidate_set_if_stable` 处理。

checksum mismatch、缺文件、path traversal、symlink escape 和 sidecar 损坏进入
quarantine。`quarantineAndRepairStateMachine.repairClosure` 要求修复只有在
同一 validator pipeline 全量通过并提交新 projection generation 后才成功。
`lockLeaseAndStagingCleanup.stagingCleanup` 规定 active staging with live lease
不得被触碰，过期 lease 加有效 checkpoint 可恢复，缺 checkpoint 才进入
quarantine，清理永不删除 live package root 或 last-good projection。该设计满足
锁过期、残留 staging 清理和不会删除仍在运行有效构建的基准。

### CR-10 并发测试可实施性

判定：通过。

R3 Type DD 已提供可自动化并发测试合同。`lockLeaseAndStagingCleanup.concurrentTestMatrix`
覆盖 scanner 看到 publisher 写 staging、publisher 在候选枚举期间 rename、
manifest 验证后变化、root 在 projection commit 前删除、stale publish lock
接管成功/失败、stale catalog staging cleanup，以及 projection swap 期间并发
query。结合 `largeLibraryDegradationAndMetrics.faultInjectionTests` 和
`implementationPlan.testContracts`，已覆盖半构建/半导入扫描、并发 catalog
写入锁竞争、manifest 变化重试、删除竞态、query-ready 竞态、锁过期和失败恢复。

## pass_fail

总体结论：通过。

修订后的 Type DD 已在固定 10 维基准下闭合本场景。R2 的三个剩余缺口
CR-04、CR-09、CR-10 已由 `lockLeaseAndStagingCleanup`、
`quarantineAndRepairStateMachine`、`largeLibraryDegradationAndMetrics`
和扩展后的测试合同补足。

| baseline id | result | 说明 |
| --- | --- | --- |
| CR-01 | 通过 | 构建期 staging 与发布标记规则防止半成品可见 |
| CR-02 | 通过 | manifest、sidecar、fsync、rename 的原子发布顺序已定义 |
| CR-03 | 通过 | import staging/quarantine 与 live root 扫描边界已定义 |
| CR-04 | 通过 | scan generation、digest inputs 和变化策略满足稳定快照要求 |
| CR-05 | 通过 | 多文件 catalog/qmd projection 通过 generation 原子提交 |
| CR-06 | 通过 | book 发布、scan、catalog/qmd projection 锁和 lease 已定义 |
| CR-07 | 通过 | query-ready 绑定当前 package generation、artifact closure 和 lineage |
| CR-08 | 通过 | build/import/scan/runtime 状态路径隔离 |
| CR-09 | 通过 | 删除、替换、checksum mismatch、锁过期和 staging 清理可恢复 |
| CR-10 | 通过 | 并发和失败恢复测试矩阵已覆盖基准要求 |

## criteria_delta_from_r2

基准差异：0。R3 baseline 与 R2 baseline 字节一致，SHA-256 均为
`8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`。
固定维度、顺序、名称和 `passCriteria` 未变化。

评估结果相对 R2 的变化如下：

| id | R2 结果 | R3 结果 | 变化 |
| --- | --- | --- | --- |
| CR-01 | 通过 | 通过 | 无变化 |
| CR-02 | 通过 | 通过 | 无变化 |
| CR-03 | 通过 | 通过 | 无变化 |
| CR-04 | 部分通过 | 通过 | 已补充 scan snapshot change policy |
| CR-05 | 通过 | 通过 | 无变化 |
| CR-06 | 通过 | 通过 | 已由 lease/fencing token 进一步强化 |
| CR-07 | 通过 | 通过 | 无变化 |
| CR-08 | 通过 | 通过 | 无变化 |
| CR-09 | 部分通过 | 通过 | 已补充 stale lock、staging cleanup 和 repair closure |
| CR-10 | 部分通过 | 通过 | 已补充并发测试矩阵和故障注入合同 |

## required_design_changes

固定基准下无阻塞性设计变更。

实现阶段应将以下内容作为验收跟踪项，而非本轮 Type DD 阻塞项：

1. 将通用 publisher staging 测试拆成 build publisher 与 import publisher 两组
   fixture，避免实现只覆盖其中一路。
2. 在实现文档中限定支持的 filesystem atomic rename、fsync 和 lock 语义，
   对网络盘或不支持可靠 rename 的 volume 给出 fail-closed 降级。
3. 强制所有 query/list reader 只通过 current-generation pointer 读取 catalog，
   不允许直接读取正在提交的 staging projection。

## residual_risks

1. 文件系统原子 rename、fsync、进程存活检测和 advisory lock 语义在本地磁盘、
   网络盘、容器 volume 与跨平台环境上可能不同；实现需要明确支持矩阵。
2. 人工 direct copy 无法强制遵守 staged import。scanner 必须继续以
   publish marker、checksum、stable snapshot 和 quarantine 规则防止半复制目录
   产生破坏性副作用。
3. lease 接管依赖 holder liveness 与 fencing token 实现质量。若 owner 检测过于
   宽松，仍可能误接管活跃发布；若过于保守，可能产生较长时间 lock contention。
4. 多文件 catalog 的一致性依赖所有 reader 遵守 generation pointer。任何绕过
   projection API 的实现都会重新引入跨 generation 读取风险。
5. GraphRAG 和 qmd 工具自身若在输出目录内非原子写入，runner 仍必须把工具输出
   约束在 attempt/staging 目录，完成后再纳入 package generation 闭包。
