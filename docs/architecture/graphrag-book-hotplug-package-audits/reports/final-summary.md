# GraphRAG 单本书热插拔包设计审计汇总

## 审计对象

- 文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 审计目录：`docs/architecture/graphrag-book-hotplug-package-audits/`
- 审计时间：`2026-06-02`
- 审计方式：10 个独立 Agent，各自固定 10 维审计基准，并基于不同使用
  场景进行模拟评估。

## 结构校验

10 个 Agent 均已完成独立输出：

- `agent-01-portable-sharing/baseline.yaml`
- `agent-01-portable-sharing/report.md`
- `agent-02-airgap-import/baseline.yaml`
- `agent-02-airgap-import/report.md`
- `agent-03-large-library/baseline.yaml`
- `agent-03-large-library/report.md`
- `agent-04-damaged-package/baseline.yaml`
- `agent-04-damaged-package/report.md`
- `agent-05-version-upgrade/baseline.yaml`
- `agent-05-version-upgrade/report.md`
- `agent-06-security-privacy/baseline.yaml`
- `agent-06-security-privacy/report.md`
- `agent-07-concurrent-runner/baseline.yaml`
- `agent-07-concurrent-runner/report.md`
- `agent-08-qmd-index/baseline.yaml`
- `agent-08-qmd-index/report.md`
- `agent-09-graphrag-query/baseline.yaml`
- `agent-09-graphrag-query/report.md`
- `agent-10-migration-cleanup/baseline.yaml`
- `agent-10-migration-cleanup/report.md`

全部 `baseline.yaml` 均可解析为 YAML。全部 `report.md` 均包含
`scenario`、`fixed_baseline`、`findings`、`pass_fail`、
`required_design_changes`、`residual_risks`。

## 场景结论

| Agent | 场景 | 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 部分通过 |
| agent-02 | 离线机器导入，不能访问 provider | 部分通过 |
| agent-03 | 上千本书同时挂载 | 未通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 部分通过 |
| agent-05 | 旧 schema 跨版本升级 | 未通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 部分通过 |
| agent-07 | runner 构建时并发 mount scan/import | 未通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 部分通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 部分通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 部分通过 |

总体结论：未通过生产设计审计。当前 Type DD 的方向正确，已经确立
`BOOK_MANIFEST.json` 权威、单书包根目录、catalog 可重建投影、provider
payload 排除、基础冲突处理和迁移方向。但它仍是草稿，不能直接进入生产实现。

## 共同发现

1. 原子导入与原子发布不足。
   当前文档描述了“复制目录即挂载”，但没有定义 staging 目录、manifest 最后
   写入、checksum 最后提交、atomic rename、构建不可见、半包隔离和
   import-in-progress 状态。

2. mount scan 缺少事务化和可恢复模型。
   文档没有定义扫描 generation、稳定快照、增量 changed-set、checkpoint、
   last-good catalog view、失败重试和 catalog/qmd projection 原子提交。

3. qmd readiness gate 不完整。
   文档已有 `reindex_on_mount` 方向，但缺少 qmd index freshness 判定、
   qmd-ready 状态机、重建输出位置、readonly 包与本地 projection 的边界、
   并发重建幂等键和旧投影失效规则。

4. GraphRAG query readiness gate 不完整。
   文档要求 `requiredArtifacts` 和 producer evidence，但没有列出最低查询
   artifact 集合，也没有定义 artifact 与 producer lineage 的双向绑定、
   query entrypoint、schema/dimension 兼容判定和 gate 失败诊断。

5. 安全模型偏 denylist，缺少 allowlist 和脱敏契约。
   文档排除了 `.env`、provider requests/responses、logs 和 corrupt 文件，
   但没有定义导出 allowlist、secret scan、symlink 检查、路径逃逸检查、
   manifest 字段敏感分级和 producer evidence 脱敏 schema。

6. 版本升级和迁移缺少状态机。
   文档描述了从 `distribution_manifest.json` 迁移到 `BOOK_MANIFEST.json`，
   但没有定义 migration state、upgrade matrix、artifact schema conversion、
   atomic rollback、migration evidence、residue quarantine 和 stale catalog
   cleanup。

7. 大规模场景缺少性能和恢复边界。
   上千本挂载场景要求增量扫描、bounded validation I/O、资源预算、失败恢复、
   并发锁和大规模测试合同；当前草稿没有这些生产约束。

## 下一步行动判断

下一步应先修正设计文档，而不是直接实现。

必须补入 Type DD 的设计块：

1. `atomicPackageLifecycle`
   - staging root
   - publish marker
   - manifest-last-write
   - checksum-last-commit
   - atomic rename
   - incomplete copy quarantine
   - build-in-progress invisibility

2. `mountScanTransactionModel`
   - scan generation
   - changed-set detection
   - scan checkpoint
   - last-good projection
   - catalog atomic replace
   - qmd projection atomic replace
   - lock, lease, CAS, retry rules

3. `readinessGates`
   - qmd-ready state machine
   - GraphRAG query-ready state machine
   - minimum artifact closure
   - producer lineage schema
   - artifact-lineage checksum binding
   - stale projection invalidation

4. `securityExportPolicy`
   - package allowlist
   - denylist as defense-in-depth
   - secret scan fail-closed
   - symlink and path traversal policy
   - diagnostic redaction schema
   - producer evidence redaction schema

5. `versionAndMigrationModel`
   - schema compatibility matrix
   - upgrade/migration state machine
   - migration evidence
   - rollback contract
   - 38 current books versus 34 residue classification
   - residue quarantine/archive/repair policy

6. `largeLibraryOperationalBounds`
   - target scale
   - I/O budget
   - incremental scan strategy
   - resumable scan state
   - bounded validation policy
   - thousand-book test contract

## Recommended Stop/Go

- Design status: stop before implementation.
- Required action: revise `graphrag-book-hotplug-package.type-dd.yaml`.
- Re-audit scope after revision: focus on the 6 shared design blocks above,
  with special attention to agent-03, agent-05, and agent-07 because they
  returned full fail.
- Implementation should start only after the revised Type DD passes a focused
  design audit for atomic import, concurrent scan, qmd readiness, GraphRAG
  readiness, security export, and migration idempotency.
