# agent-07-concurrent-runner R2 复审报告

## scenario

batch runner 正在构建 `graph_vault/books/{bookId}` 或相邻产物时，
另一个流程同时执行 mount scan 或 import。复审重点是避免半成品被投影、
目录竞争、catalog 覆盖、校验竞态和运行状态互相污染。

审计对象为
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。复审未读取
provider payload、secrets、请求响应日志或私有运行载荷。

## reused_fixed_baseline

复审复用 R2 目录中已存在的固定基线文件：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-07-concurrent-runner/baseline.yaml`

固定 10 维如下，未新增、删除、重命名维度，未改变 passCriteria：

| id | name | R2 判定 |
| --- | --- | --- |
| CR-01 | 构建中书包不可见 | 通过 |
| CR-02 | 原子提交协议 | 通过 |
| CR-03 | 导入暂存隔离 | 通过 |
| CR-04 | 扫描快照一致性 | 部分通过 |
| CR-05 | Catalog 原子投影 | 通过 |
| CR-06 | 锁与租约边界 | 通过 |
| CR-07 | Query-ready 门禁抗竞态 | 通过 |
| CR-08 | 可变状态互不污染 | 通过 |
| CR-09 | 冲突与删除竞态可恢复 | 部分通过 |
| CR-10 | 并发测试可实施性 | 部分通过 |

## baseline_integrity_check

- baseline SHA-256:
  `8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`
- baseline 维度数量：10。
- R2 baseline 与 R1 同场景 baseline 字节一致。
- 本次复审未覆盖 `baseline.yaml`，仅新增 `report.md`。
- passCriteria 差异 (criteria delta)：0。

## findings

### CR-01 构建中书包不可见

R2 修订满足基准。`atomicPackageLifecycle.principle` 明确规定书包只有在
所有 required artifact、checksum sidecar 和 `BOOK_MANIFEST.json` sidecar
完成原子发布后才 mount-visible。`writableRoots.buildStagingRoot` 将构建期
输出隔离到 `graph_vault/.staging/builds/{runId}/{bookId}`，
`publishProtocol.requiredOrder` 要求只在 staging root 写入 package files，
完成后再原子 rename 到 live root。该合同防止 batch runner 在构建未完成前把
`BOOK_MANIFEST.json` 暴露为可扫描权威。

### CR-02 原子提交协议

R2 修订满足基准。`publishProtocol.requiredOrder` 已定义临时构建目录、
文件 checksum 生成、`BOOK_MANIFEST.json` 生成、manifest checksum sidecar
生成、`PUBLISH_READY.json` 写入、fsync，以及 staging root 到 live root 的
原子 rename。`manifestLastWriteRule` 和 `checksumLastCommitRule` 明确要求
manifest 及 sidecar 在被引用文件之后提交。失败构建停留在 `.staging` 下，
不会形成 scanner 可投影的完整发布状态。

### CR-03 导入暂存隔离

R2 修订满足基准。`writableRoots.importStagingRoot` 将 import 写入边界固定为
`graph_vault/.staging/imports/{importId}/{bookId}`，并与 build staging、
quarantine、runtime state 分离。`publishProtocol` 同时覆盖 import 和 build
发布，要求完成校验后再原子发布。半复制目录缺少有效 manifest sidecar 或
`PUBLISH_READY.json` 时，scanner 必须按 `visibilityRule` 忽略。

### CR-04 扫描快照一致性

R2 修订部分满足基准。新增 `mountScanTransactionModel`、`scanGeneration`、
`inputDigest`、`changedSetDetection.digestInputs` 和 validation pipeline，
已使 scanner 能按 generation 构造候选集和投影计划。

剩余缺口是稳定快照 (stable snapshot) 合同仍不够硬。Type DD 没有明确要求
scanner 在读取候选前后双读 manifest digest、checksum sidecar、目录 mtime、
`packageGeneration` 或文件闭包，也没有规定扫描期间发生变化时必须重试或跳过
该候选。当前设计可以识别 changed set，但尚不能证明投影一定来自单次稳定快照，
也不能排除 manifest、sidecar 和 required files 混合新旧 generation 的风险。

### CR-05 Catalog 原子投影

R2 修订满足基准。`atomicProjectionCommit` 规定所有 catalog 和 qmd projection
先写入 `graph_vault/catalog/.staging/mount-scan-{scanGeneration}`，完成 checksum
和 fsync 后再原子替换。覆盖对象包括 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和
`qmd-projection.yaml`。`current-generation pointer` 最后更新，
`lastGoodRule` 要求查询和列表命令只读取最后提交的完整 generation。

### CR-06 锁与租约边界

R2 修订满足基准。`concurrencyBoundary` 规定 import、export、build publish 和
mount scan 获取兼容锁，同一 `bookId` 同时只能有一个 writer 发布或替换。
`mountScanTransactionModel.locks` 定义 scan lock、catalog commit lock、
qmd projection lock 和固定获取顺序；锁获取失败生成 retryable diagnostics，
并保持 last-good projection 不变。读者通过最后提交的 generation 读取稳定投影，
不需要持有写锁。

### CR-07 Query-ready 门禁抗竞态

R2 修订满足基准。`readinessGates` 区分 mounted、qmd-ready、
GraphRAG-ready 和 `query_ready`。GraphRAG gate 要求 minimum artifact closure、
producer lineage schema、stage order 和 artifact-lineage binding。
`queryEntrypoint.commandContract` 要求查询通过已提交 mount projection 解析
当前 `packageGeneration`，验证 `query_ready`，并拒绝 stale 或 cross-book
artifacts。`staleProjectionInvalidation` 要求 package generation、manifest
checksum、schema、qmd freshness input 或 lineage binding 变化时，在同一
projection commit 中移除 query-ready capability。

### CR-08 可变状态互不污染

R2 修订满足基准。`writableRoots` 将 live root、import staging、build staging、
quarantine 和 runtime state 分离。`immutablePackagePolicy` 要求 shared package
发布后默认只读，runtime writes、local query caches、repair diagnostics 和
import state 均写入 `runtimeStateRoot` 或 catalog scan state，而不是 package
root。`externalRuntimeLayout` 进一步将 mount scan generation、qmd projection
和 receiver-local runtime state 放在包外路径，降低 scanner/importer 覆盖
runner checkpoint、artifact manifest 或 producer evidence 的风险。

### CR-09 冲突与删除竞态可恢复

R2 修订部分满足基准。设计已覆盖同一 `bookId` 单 writer 发布、
`sameBookIdNewGeneration: replace_after_full_validation`、失败替换保留上一
generation、缺失 book root 在下一次 committed scan 中卸载，以及 stale projection
在同一原子提交中清理。checksum mismatch、缺文件、path traversal 和 symlink
escape 也会进入 quarantine 候选状态。

剩余缺口是锁过期、残留 staging 清理、扫描中 replacement 变化、checksum mismatch
后的恢复路径仍不完整。Type DD 未规定 stale lock 的 lease/heartbeat 判定、
`.staging` 残留目录的清理条件，或清理流程如何证明不会删除仍在运行的有效构建。
与 CR-04 相关，替换期间 scanner 若观察到 generation 改变，也缺少必须重试或
跳过候选的显式恢复规则。

### CR-10 并发测试可实施性

R2 修订部分满足基准。`testContracts` 和 `largeLibraryTests` 已新增或强化以下
可自动化合同：缺少 `PUBLISH_READY.json` 不挂载、staging copy 只在 atomic rename
后可见、scanner crash 保留 last-good generation、catalog/qmd projection 只暴露
旧或新 generation、projection commit failure 保留 last-good generation，以及
并发 query 不读取 partial projection。

剩余缺口是基准要求的若干并发测试尚未逐项落地：半构建扫描、半导入扫描、
并发 scanner 写 catalog、manifest 变化重试、删除时扫描、query-ready 提前置真
竞态、锁过期恢复和残留 staging 清理。当前测试合同可覆盖一部分机制，但不足以
证明 CR-04 和 CR-09 的缺口已被自动化约束。

## pass_fail

总体结论：未完全通过。

R2 修订显著改善了并发设计，CR-01、CR-02、CR-03、CR-05、CR-06、CR-07、
CR-08 已达到固定基准。CR-04、CR-09、CR-10 仍为部分通过，因此本场景不能判定为
生产设计通过。

| baseline id | result | 说明 |
| --- | --- | --- |
| CR-01 | 通过 | 构建期 staging 与原子发布使未完成包不可见 |
| CR-02 | 通过 | 临时目录、manifest/sidecar 顺序、fsync、rename 均已定义 |
| CR-03 | 通过 | import staging 与 quarantine 边界已定义 |
| CR-04 | 部分通过 | 有 scan generation 和 digest inputs，缺变化时重试/跳过硬规则 |
| CR-05 | 通过 | catalog 与 qmd projection 原子提交已定义 |
| CR-06 | 通过 | book 发布与 catalog 写入锁、generation 读取规则已定义 |
| CR-07 | 通过 | query-ready 通过当前 packageGeneration 和 lineage gate 约束 |
| CR-08 | 通过 | build/import/scan/runtime 状态路径已隔离 |
| CR-09 | 部分通过 | 删除/替换有基础规则，缺锁过期与残留 staging 恢复细则 |
| CR-10 | 部分通过 | 有部分并发测试，缺基准列明的完整竞态测试矩阵 |

## criteria_delta_from_r1

固定基准相对 R1 无变化。R2 baseline 与 R1 baseline SHA-256 相同，且字节一致；
维度数量、id、name 和 passCriteria 均未改变。

评估结果相对 R1 的变化如下：

| id | R1 结果 | R2 结果 | 变化 |
| --- | --- | --- | --- |
| CR-01 | 部分通过 | 通过 | 已补充构建 staging 与不可见发布边界 |
| CR-02 | 未通过 | 通过 | 已补充原子发布顺序、manifest/sidecar 最后提交 |
| CR-03 | 未通过 | 通过 | 已补充 import staging、quarantine 和原子发布 |
| CR-04 | 未通过 | 部分通过 | 已补充 scan generation，但缺稳定快照变化处理 |
| CR-05 | 未通过 | 通过 | 已补充 catalog/qmd projection 原子提交 |
| CR-06 | 未通过 | 通过 | 已补充发布锁、scan/catalog/qmd projection 锁和读取规则 |
| CR-07 | 部分通过 | 通过 | 已补充当前 packageGeneration、lineage gate 和失效规则 |
| CR-08 | 部分通过 | 通过 | 已补充包外 runtime、scan 和 qmd projection 状态路径 |
| CR-09 | 未通过 | 部分通过 | 已补充删除/替换基础规则，仍缺 stale lock 与 staging cleanup |
| CR-10 | 未通过 | 部分通过 | 已补充部分并发测试，仍缺完整竞态测试矩阵 |

## required_design_changes

1. 在 `mountScanTransactionModel` 中增加稳定快照读取合同。scanner 读取候选前后
   必须比对 `packageGeneration`、manifest sha256、publish marker sha256、
   root mtime 或等价 generation token；任一输入变化时必须有限重试或跳过候选。

2. 明确 required files 闭包的扫描一致性规则。若 manifest、checksum sidecar、
   required file checksum 或目录 generation 在一次候选验证中变化，scanner 不得
   生成混合投影，必须记录本地诊断并保留 last-good projection。

3. 补充锁租约 (lease) 与 heartbeat 合同。定义 lock owner、lease duration、
   heartbeat file、过期判定、stale lock 接管条件，以及接管失败时的 fail-closed
   行为。

4. 补充残留 staging 清理合同。清理器只能删除无有效 lease、无活跃 owner、超过
   保留期且不在当前 publish transaction 中的 staging/import/build 目录；不得
   删除仍在运行的有效构建或导入。

5. 补充 checksum mismatch 后恢复路径。区分 direct copy 的暂时 mismatch、已发布包
   的持久 mismatch、替换失败和 quarantine 后重拷贝；恢复成功前不得覆盖 last-good
   generation。

6. 扩展 `testContracts`，逐项加入半构建扫描、半导入扫描、manifest 变化重试、
   两个 scanner 并发写 catalog、删除时扫描、替换时扫描、query-ready 竞态、
   stale lock 接管、残留 staging 清理和失败恢复测试。

## residual_risks

1. 文件系统的 rename、fsync 和 lock 语义在本地磁盘、网络盘、容器 volume 与不同
   操作系统上可能不同；实现仍需限定支持环境或提供降级策略。

2. 人工 direct copy 不能强制遵守 staged import。scanner 必须继续把半复制目录
   视为 incomplete candidate，并避免 quarantine 或 diagnostics 产生破坏性副作用。

3. 多文件 catalog 虽有 projection generation，但实现若让查询进程绕过
   current-generation pointer，仍可能读取跨 generation 的混合投影。

4. qmd projection freshness 依赖 normalized hash、schema、tool version 和 embedding
   profile。若实现没有把这些元数据写入 projection record，query-ready gate 仍可能
   被旧 projection 误满足。

5. GraphRAG 或 qmd 工具自身可能在输出目录内非原子写入。runner 必须继续把工具
   输出限制在 attempt/staging 目录，完成后再纳入发布闭包。
