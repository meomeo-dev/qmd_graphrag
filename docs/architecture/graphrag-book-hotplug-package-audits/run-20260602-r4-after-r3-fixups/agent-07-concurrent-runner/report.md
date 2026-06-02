# R4 复审报告：agent-07-concurrent-runner

## scenario

batch runner 正在构建 `graph_vault/books/{bookId}` 或相邻产物时，另一
流程同时执行 mount scan/import。复审重点是半成品不可见性
（incomplete package invisibility）、原子发布（atomic publish）、catalog
原子投影、锁与租约边界、query-ready 抗竞态、状态隔离和失败恢复。

审计范围仅包括下列规范文档：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- 本目录既有 `baseline.yaml`

本轮未读取 provider payload、secrets、凭据、运行时请求体或响应体。

## reused_fixed_baseline

baseline 文件：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-07-concurrent-runner/baseline.yaml`

baseline SHA-256：
`8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`

复用状态：已复用该目录中既有 fixed baseline。未新增、删除、重排、
重命名维度，未改变任何 `passCriteria`。

固定维度顺序：
CR-01, CR-02, CR-03, CR-04, CR-05, CR-06, CR-07, CR-08, CR-09, CR-10。

## baseline_integrity_check

结果：PASS。

- baseline 文件在复审前存在，且仅作为评价基准读取。
- baseline 维度数量为 10，编号和顺序保持 `CR-01` 至 `CR-10`。
- baseline 中的维度名称和 `passCriteria` 未被本报告改写或替代。
- 本轮只新增 `report.md`，未覆盖 `baseline.yaml`。
- SHA-256 校验值为
  `8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`。

## findings

| id | 维度 | 判定 | 评估 |
| --- | --- | --- | --- |
| CR-01 | 构建中书包不可见 | PASS | 主文档 `atomicPackageLifecycle` 规定仅在 required artifacts、manifest、manifest sidecar 经过原子发布后才 mount-visible，并明确 actively built directories 不得投影到 catalog 或 qmd indexes。`visibilityRule` 要求 scanner 忽略缺少有效 `BOOK_MANIFEST.json`、sidecar 和 `PUBLISH_READY.json` 的目录。 |
| CR-02 | 原子提交协议 | PASS | 主文档定义 `buildStagingRoot`、`importStagingRoot`、manifest 后写、sidecar 后提交、fsync 和 staging root 到 live root 的 atomic rename。失败或不完整状态由 missing marker、missing file、checksum mismatch 等策略 fail closed，未形成可挂载状态。 |
| CR-03 | 导入暂存隔离 | PASS | import 通过 `graph_vault/.staging/imports/{importId}/{bookId}` 写入、校验和发布；正常 scanner 只枚举 live root 并要求 publish marker 与校验通过。direct copy 被限定为 marker/checksum 验证后才可挂载，不完整复制只产生诊断或 quarantine，不进入有效投影。 |
| CR-04 | 扫描快照一致性 | PASS | `mountScanTransactionModel` 使用 scan generation、candidate set、validation results 和 projection plan。changed-set digest 包含 `packageGeneration`、`manifestSha256`、manifest bytes、publish marker sha 和 root mtime；`scanSnapshotChangePolicy` 对 candidate、manifest、publish marker 和 root deletion 变化执行 retry、defer、rebuild plan 或稳定移除，避免混合新旧状态。 |
| CR-05 | Catalog 原子投影 | PASS | 主文档要求 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、`graph-capabilities.yaml` 和 `qmd-projection.yaml` 写入 catalog staging root、checksum/fsync 后原子替换，并最后更新 current-generation pointer。读者只读 last committed generation，不暴露部分投影。 |
| CR-06 | 锁与租约边界 | PASS | 主文档定义 publish、scan、catalog commit、qmd projection 等锁和获取顺序；`concurrencyBoundary` 要求同一 `bookId` 只有一个 writer 发布或替换。`lockLeaseAndStagingCleanup` 定义 lease 字段、TTL、heartbeat、fencing token 和 stale takeover 规则。读者使用 last-good projection，写者冲突产生 retryable diagnostics 或 fail closed。 |
| CR-07 | Query-ready 门禁抗竞态 | PASS | readiness gates 区分 mounted、qmd-ready、GraphRAG-ready 和 query-ready。GraphRAG gate 要求 required artifact closure、producer lineage 和 checksum 绑定；query entrypoint 必须通过 committed projection 解析当前 `packageGeneration` 并拒绝 stale/cross-book artifacts。R3 补充的 qmd idempotency key 和 qmd diagnostics 绑定 `packageGeneration`，使并发构建或导入不能提前置真 query-ready。 |
| CR-08 | 可变状态互不污染 | PASS | 主文档将 build staging、import staging、runtime local state、scan transaction state 和 qmd projection state 分离到不同 root。immutable package policy 要求 runtime writes、local query caches、repair diagnostics 和 import state 不写入 package root。scanner/importer 通过 catalog scan state 或 runtime state 记录诊断，不写 runner 正在使用的 staging checkpoint、artifact 或 run evidence。 |
| CR-09 | 冲突与删除竞态可恢复 | PASS | `deletionAndReplacement` 覆盖 missing root、same-book new generation replacement、failed replacement 和 stale projection cleanup。rollback contract 覆盖 publish 前、publish 后 projection 前和 projection commit 后恢复。quarantine/repair、checksum mismatch、stale lease takeover 和 staging cleanup 规则均要求保留 last-good projection，且 active staging with live lease 不被清理。 |
| CR-10 | 并发测试可实施性 | PASS | 主文档提供 `concurrentTestMatrix`、large-library tests、fault-injection tests 和总 `testContracts`。覆盖 scanner 遇到 publisher staging、rename during enumeration、manifest after validation 变化、root deletion before commit、stale publish lock takeover 成功/失败、catalog staging cleanup、projection swap 中并发 query、scan interruption、projection commit failure 和 last-good preservation。 |

## pass_fail

总体判定：PASS。

10 个固定维度均满足 R4 场景下的 baseline `passCriteria`。主文档已经覆盖
并发构建、导入、扫描和 catalog 投影的核心事务边界；R3 补充文档进一步
加强了身份稳定性、scanner no-read、qmd generation 绑定和诊断约束。

## criteria_delta_from_r3

无 criteria delta。

本轮 R4 复审未调整 baseline 维度、名称、顺序或 `passCriteria`。R3 fixups
仅作为规范性补充证据参与判断，不改变本轮 fixed baseline 的验收标准。

## required_design_changes

无阻塞性 required design changes。

当前 Type DD 与 R3 补充文档已满足 agent-07-concurrent-runner 的固定
10 维并发复审标准。

## residual_risks

- 规格已要求 fsync、atomic rename、current-generation pointer last update
  和 lock fencing；实现阶段仍需按目标文件系统验证这些操作的真实原子性
  （atomicity）和崩溃恢复语义。
- 并发测试合同可实施，但实现时应将 half-build scan 与 half-import scan
  拆成独立 fixture，避免只用通用 publisher staging case 覆盖两类路径。
- direct copy 支持依赖 marker/checksum fail-closed。实现必须保证 scanner
  对半复制但已出现 marker 的目录只产生 incomplete/quarantine 结果，不能
  写入 mounted 或 query-ready 投影。
- stale lock takeover 依赖 PID/session、TTL、heartbeat 和 fencing token 的
  一致实现。若运行环境存在 PID reuse 或跨主机共享目录，应增加更强的
  holder identity。
- R3 no-read 合同已禁止读取 provider roots 和 runtime payload roots；实现
  需把该限制落实为路径 allowlist/denylist 和自动化回归测试。
