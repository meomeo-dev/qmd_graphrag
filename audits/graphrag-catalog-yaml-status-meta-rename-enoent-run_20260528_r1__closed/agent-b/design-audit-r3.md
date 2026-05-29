# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R3

## 结论

PASS。

R3 复审确认，`docs/architecture/graphrag-parallel-runner.type-dd.yaml`
已经闭合 R2 唯一阻塞项：sidecar-only quarantine 与 primary bundle
quarantine 的边界现在由 `checksumCommit.sidecarQuarantineDecisionTable`
和 `sidecarQuarantineRule` 明确约束，并在
`durableStateAcceptanceMatrix.sidecar_only_quarantine_boundary` 中形成可测试
验收断言。

关键状态的隔离对象和恢复决策已经足够可实现、可测试：

- meta missing：保留 primary 与 checksum，status-json 只读降级
  `metadata_missing_read_only`，repair writer 可回填 meta。
- meta invalid：保留 primary 与 checksum，仅隔离 checksum meta sidecar，
  repair writer 回填 committed meta；sidecar repair 失败则 stop_until_fixed。
- meta conflict：保留 primary 与 checksum，仅隔离 checksum meta sidecar，
  repair writer 回填 committed meta；sidecar repair 失败则 stop_until_fixed。
- checksum sidecar invalid：target 有效时保留 primary，仅隔离 checksum
  sidecar 与已存在的 meta sidecar，随后回填两类 sidecar；repair 失败则
  stop_until_fixed。
- target checksum mismatch：隔离 primary bundle，checksum 与 meta 随 bundle
  隔离，恢复决策为 stop_until_fixed。
- target invalid：隔离 primary bundle，checksum 与 meta 随 bundle 隔离，
  恢复决策为 stop_until_fixed。

同时，新增规则没有破坏两条既有边界：`--status-json` 仍是严格只读观测入口
（strict read-only observer），checksum meta 缺失只能投影为
`read_only_degraded`；repair writer 写 checksum meta sidecar 时发生 rename
`ENOENT` 仍必须 fail-closed 为 `durable_temp_rename_enoent` 与
`stop_until_fixed`，且在 primary 与 checksum 匹配时不得隔离 primary。

因此，允许进入实现。

## 审计范围

- 复审文件：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- R2 参考文件：
  `audits/graphrag-catalog-yaml-status-meta-rename-enoent-run_20260528_r1__open/agent-b/design-audit-r2.md`
- 专项关注：
  R2 第 10 条 `Sidecar quarantine 合同`，包括 meta missing、meta invalid、
  meta conflict、checksum sidecar invalid、target checksum mismatch、
  target invalid 的 quarantine 对象和恢复决策。

未读取或打印 `.env`，未运行真实 EPUB runner，未修改源码、测试或设计文档。

## 固定设计审计基准

1. **Rename ENOENT 总分类闭合**

   判定：PASS。

   Type DD 仍要求 atomic rename `ENOENT` 归入
   `local_state_integrity`、`durable_temp_rename_enoent`、
   `stop_until_fixed`，且不得降级为 unknown、provider transient 或业务失败。
   本轮新增 sidecar quarantine 决策表没有放松该分类。

2. **Rename cause matrix 完整性**

   判定：PASS。

   `renameCause` 仍必须从 `temp_collision`、
   `reconciler_mistaken_deletion`、`concurrent_takeover`、
   `generation_advanced`、`filesystem_or_external_mutation` 中选择；证据不足时
   使用 `filesystem_or_external_mutation` 并保持 fail-closed。sidecar evidence
   继续要求 `primaryTargetLocator`、`sidecarTargetLocator` 与 `sidecarKind`。

3. **Checksum crash window 基础规则**

   判定：PASS。

   `checksumCommit.crashWindows` 继续覆盖 target/checksum/meta 的不完整提交窗口。
   `checksum_meta_missing` 与 `checksum_meta_backfill_rename_enoent` 仍分别约束
   read-only degraded 与 repair writer fail-closed，不允许在 commit 证据不足时
   发布 completed。

4. **Durable failure 观测面一致性**

   判定：PASS。

   checkpoint、event、status-json 与 recovery summary 仍共享稳定分类字段。
   status-json 自身发现 fail-closed durable failure 时，仍应输出可解析 JSON
   投影，不依赖写 checkpoint、event、status.json 或 recovery-summary.json。

5. **Checksum meta sidecar ENOENT 专项语义**

   判定：PASS。

   repair writer 已进入 checksum meta backfill 并遇到 rename `ENOENT` 时，仍必须
   分类为 `local_state_integrity`、`durable_temp_rename_enoent` 与
   `stop_until_fixed`。当 primary target 与 checksum 匹配时，不得隔离 primary；
   诊断必须指向 sidecar target 并保留 `primaryTargetLocator`。

6. **Status-json 只读边界**

   判定：PASS。

   `statusJsonReadOnlyContract` 仍声明 `--status-json` 为
   `no_state_root_mutation`：不得获取写锁、创建/删除 lock、temp、owner，不得写
   checksum、checksum meta，不得 quarantine、append event、写 manifest/status 或
   recovery summary。新增 quarantine 决策表没有授权 status-json 执行写操作。

7. **Fail-closed 与 read-only degraded 决策矩阵**

   判定：PASS。

   meta missing 的只读路径被明确建模为
   `target_valid_checksum_matches_meta_missing`：保留 primary 与 checksum，
   status-json 动作为 `read_only_degraded`，恢复决策为
   `metadata_missing_read_only`。repair writer 写 meta sidecar 失败时仍进入
   `durable_temp_rename_enoent` 与 `stop_until_fixed`，两条路径没有混淆。

8. **Sidecar target mapping 继承规则**

   判定：PASS。

   `derivedSidecarRule` 仍明确 `{target}.sha256` 与
   `{target}.sha256.meta.json` 继承 primary target 的 lane、owner、timeout、
   releaseOn、durableMode 与 preflight scope，并禁止 sidecar 递归生成新的
   checksum sidecar。新增 quarantine 规则继续基于 primary target lock 执行，
   未引入新的 primary target 类型。

9. **Preflight sidecar scope**

   判定：PASS。

   sidecar 仍纳入由 targetMapping 派生的 preflight scan scope。
   `durableStatePreflight` 继续要求覆盖 nested durable targets 与 sidecars。
   新增验收用例只增加 sidecar quarantine 边界断言，没有缩小 preflight 范围。

10. **Sidecar quarantine 合同**

    判定：PASS。

    R2 阻塞项已闭合。`sidecarQuarantineDecisionTable` 已将关键状态拆成可实现、
    可测试的隔离对象和恢复决策：

    - `target_valid_checksum_matches_meta_missing`：保留 primary 与 checksum；
      repair writer 可回填 meta；status-json 只能 read-only degraded。
    - `target_valid_checksum_matches_meta_invalid`：保留 primary 与 checksum；
      仅隔离 checksum meta sidecar；repair writer 回填 committed meta；
      sidecar repair 失败则 stop_until_fixed。
    - `target_valid_checksum_matches_meta_conflict`：保留 primary 与 checksum；
      仅隔离 checksum meta sidecar；repair writer 回填 committed meta；
      sidecar repair 失败则 stop_until_fixed。
    - `checksum_sidecar_invalid_or_unparseable`：target 有效时保留 primary；
      仅隔离 checksum sidecar 与已存在的 meta sidecar；随后回填 checksum 与
      meta；sidecar repair 失败则 stop_until_fixed。
    - `target_valid_checksum_mismatch`：隔离 primary bundle；checksum 与 meta
      随 primary bundle 隔离；恢复决策为 stop_until_fixed。
    - `target_invalid_or_unparseable`：隔离 primary bundle；checksum 与 meta 随
      primary bundle 隔离；恢复决策为 stop_until_fixed。

    `sidecarQuarantineRule` 进一步规定 sidecar-only quarantine 必须持有
    primary target lock，并保留 `primaryTargetLocator`、
    `sidecarTargetLocator`、`sidecarKind`、`checksumExpected`、
    `checksumActual` 与 `checksumRecoveryDecision`。只有 target invalid、
    target checksum mismatch 或 primary 解析不可置信时，才能 quarantine
    primary bundle。

    `durableStateAcceptanceMatrix.sidecar_only_quarantine_boundary` 已覆盖：
    meta invalid/conflict 保留 primary 与 checksum、只隔离 meta sidecar；
    checksum sidecar invalid 且 target 有效时只隔离 sidecars 并回填；
    target invalid 或 checksum mismatch 时隔离 primary bundle；观测面必须命名
    quarantine object 为 `sidecar` 或 `primary_bundle`。该矩阵足以指导实现和
    回归测试。

## 剩余阻塞问题

无。

## 是否允许进入实现

允许。

当前 R3 状态为 PASS。
