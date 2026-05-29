# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R2

## 结论

FAIL。

R2 复审确认，主线程对
`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 的更新已经闭合 R1
的大部分核心缺口：`--status-json` 被定义为严格只读观测入口
（strict read-only observer）；checksum meta 缺失在只读模式下投影为
`metadata_missing_read_only`；repair writer 写
`{target}.sha256.meta.json` 时若 temp rename 返回 `ENOENT`，必须
fail-closed 为 `local_state_integrity`、
`durable_temp_rename_enoent`、`stop_until_fixed`；sidecar 也已继承 primary
target 的 lane、owner、timeout、releaseOn、durableMode 与 preflight scope。

剩余阻塞点集中在 sidecar-only primary quarantine 边界。当前 Type DD 明确了
checksum 匹配且 meta backfill rename `ENOENT` 时不得隔离 primary target，但对
meta 冲突、meta 损坏、checksum sidecar 损坏、primary checksum mismatch 等场景
仍用泛化的 `quarantine` 表述，未形成可测试的 primary/sidecar 隔离决策表
（quarantine decision table）。实现仍可能在有效 `books.yaml` 仅受 meta
sidecar 污染时隔离 primary，或者在 primary 已不可置信时只隔离 sidecar。

因此，不允许进入实现。

## 审计范围

- 复审文件：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- R1 参考文件：
  `audits/graphrag-catalog-yaml-status-meta-rename-enoent-run_20260528_r1__open/agent-b/design-audit-r1.md`
- 关注问题：
  durable failure 分类与恢复决策、checksum meta sidecar temp rename
  `ENOENT`、status-json read-only degraded、sidecar mapping/preflight/evidence
  继承、sidecar-only primary quarantine 边界。

未读取或打印 `.env`，未运行真实 EPUB runner，未修改源码、测试或设计文档。

## 固定设计审计基准

1. **Rename ENOENT 总分类闭合**

   判定：PASS。

   Type DD 仍要求任何 atomic rename `ENOENT` 分类为
   `local_state_integrity`、`durable_temp_rename_enoent`、
   `stop_until_fixed`，且不得降级为 unknown、provider transient 或业务失败。
   `failurePolicy.renameEnoent` 也保持 `retryable: false`。

2. **Rename cause matrix 完整性**

   判定：PASS。

   `renameCause` 必须从 `temp_collision`、
   `reconciler_mistaken_deletion`、`concurrent_takeover`、
   `generation_advanced`、`filesystem_or_external_mutation` 中选择；证据不足时
   使用 `filesystem_or_external_mutation`，并保持 fail-closed。

3. **Checksum crash window 基础规则**

   判定：PASS。

   `checksumCommit.crashWindows` 覆盖 `target_new_checksum_old`、
   `target_new_checksum_missing`、`checksum_new_parent_fsync_failed`，并新增
   `checksum_meta_missing` 与
   `checksum_meta_backfill_rename_enoent`。无法证明 commit 完整时仍不能发布
   completed。

4. **Durable failure 观测面一致性**

   判定：PASS。

   `durableFailureEventEvidence` 继续要求 checkpoint、event、status-json 与
   recovery summary 使用稳定分类字段；status-json 自身 fail-closed 时新增可解析
   JSON 投影合同，不依赖写 checkpoint、event、status.json 或
   recovery-summary.json。

5. **Checksum meta sidecar ENOENT 专项语义**

   判定：PASS。

   `checksum_meta_backfill_rename_enoent` 已被建模为独立窗口。repair writer
   写 checksum meta sidecar 时发生 rename `ENOENT`，必须是
   `local_state_integrity`、`durable_temp_rename_enoent`、
   `stop_until_fixed`；primary target 与 checksum 匹配时不得隔离 primary，
   诊断必须指向 sidecar target 并保留 `primaryTargetLocator`。

6. **Status-json 只读边界**

   判定：PASS。

   `statusJsonReadOnlyContract` 明确 `--status-json` 是
   `no_state_root_mutation`，禁止获取写锁、创建/删除 lock、temp、owner、
   写 `.sha256`、写 `.sha256.meta.json`、quarantine、append event、
   写 manifest/status/recovery-summary。验收矩阵也要求缺失
   `books.yaml.sha256.meta.json` 时不创建、删除或 rename 任何相关文件。

7. **Fail-closed 与 read-only degraded 决策矩阵**

   判定：PASS。

   Type DD 已区分两类状态：primary target 有效且 checksum 匹配但 meta 缺失时，
   status-json 只能输出 `read_only_degraded` 与
   `metadata_missing_read_only`；repair/backfill writer 写 meta sidecar 时 rename
   `ENOENT`，则必须 fail-closed 为 `durable_temp_rename_enoent` 与
   `stop_until_fixed`。

8. **Sidecar target mapping 继承规则**

   判定：PASS。

   `derivedSidecarRule` 明确每个 durable YAML/JSON primary target 隐式拥有
   `{target}.sha256` 与 `{target}.sha256.meta.json`，并继承 primary target 的
   lane、owner、laneTimeoutMs、releaseOn、durableMode 与 preflight scope。
   同时禁止 sidecar 递归生成 `.sha256.meta.json.sha256`。

9. **Preflight sidecar scope**

   判定：PASS。

   `preflightScopeRule` 要求 scan root 从 `targetMapping` 派生；新增
   `derivedSidecarRule` 将 sidecar 纳入继承范围。`durableStatePreflight`
   也要求递归覆盖 sidecars，包括 `.sha256` 与 `.sha256.meta.json`。

10. **Sidecar quarantine 合同**

    判定：FAIL。

    Type DD 已声明 checksum 匹配且 meta sidecar backfill rename `ENOENT` 时不得
    隔离 primary target，这是必要但不充分的边界。`missingChecksumRule` 仍写着
    “任何 meta 冲突都必须 quarantine 并 stop_until_fixed”，但未说明 quarantine
    的对象是 meta sidecar、checksum sidecar、primary target，还是 primary 与
    sidecar bundle。`shared_store_quarantine_rename_enoent` 也只覆盖 invalid 或
    checksum-mismatch quarantine 的 evidence rename，没有把以下状态拆成可实现、
    可测试的决策表：

    - target 有效、checksum 匹配、meta 缺失；
    - target 有效、checksum 匹配、meta 损坏或 schema invalid；
    - target 有效、checksum 匹配、meta 字段冲突；
    - target 有效、checksum sidecar 损坏或与 target 不匹配；
    - target 内容不可解析或 target checksum mismatch。

    该缺口会影响恢复决策的安全边界：有效 primary 不应因 sidecar-only 污染被
    隔离；primary 不可信时也不应只修 sidecar 后继续读取。

## 剩余阻塞问题

1. **P0：sidecar-only quarantine 边界仍未闭合。**

   需要在 Type DD 中新增明确的 quarantine decision table。该表应按 primary
   target 有效性、checksum sidecar 一致性、checksum meta 存在性、meta schema
   有效性、meta 字段冲突分别规定 quarantine 对象和恢复决策。

2. **P0：`meta conflict` 的 quarantine 对象不明确。**

   “任何 meta 冲突都必须 quarantine”不能指导实现选择 sidecar-only quarantine
   或 primary bundle quarantine。至少应规定：当 primary 内容有效且 checksum
   sidecar 与内容匹配时，meta 文件冲突默认隔离 meta sidecar 或进入
   stop_until_fixed 的 sidecar diagnostic，不得隔离 primary；当 checksum 与
   primary 不匹配或 primary 不可解析时，才进入 primary/bundle quarantine。

3. **P1：验收矩阵缺少 sidecar-only quarantine 用例。**

   现有验收覆盖 status-json meta missing 与 repair writer meta rename
   `ENOENT`，但没有覆盖 meta 损坏、meta 字段冲突、checksum sidecar 损坏、
   primary checksum mismatch 的 quarantine 对象断言。实现前需要把这些边界转成
   durableStateAcceptanceMatrix 用例。

## 是否允许进入实现

不允许。

进入实现前，必须先补齐 sidecar-only quarantine 决策表与验收矩阵。当前 R2
状态为 FAIL。
