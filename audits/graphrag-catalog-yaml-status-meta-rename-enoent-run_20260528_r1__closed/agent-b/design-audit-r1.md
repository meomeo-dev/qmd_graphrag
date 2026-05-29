# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R1

## 结论

FAIL。

现有 Type DD 对普通 durable replace 的 rename ENOENT 已有 fail-closed
分类，但没有把 checksum meta sidecar 的 status-json 读路径修复写入建模为
独立恢复场景。`--status-json` 应是只读观测入口（read-only observer）。
当 primary target 与 `.sha256` checksum 匹配但 `.sha256.meta.json` 缺失时，
status-json 应输出只读降级诊断（read-only degraded diagnostic），不得尝试
backfill、quarantine、temp cleanup 或 stale lock recovery。若任何 repair/backfill
路径已经尝试写 checksum meta sidecar，且 temp rename 抛 ENOENT，则必须
fail-closed：`failureKind=local_state_integrity`、
`localFailureClass=durable_temp_rename_enoent`、`retryable=false`、
`recoveryDecision=stop_until_fixed`。

## 审计依据

- Type DD 已要求生产 durable target 进入 `targetMapping`，并要求 preflight
  scope 从 mapping 派生；见
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
- Type DD 已定义 checksum commit、missing checksum 回填与 rename ENOENT
  fail-closed 分类；见
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:611`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:641`。
- Type DD 已要求 status-json、event、checkpoint、recovery summary 四个观测面
  对 durable failure 保持一致；见
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1132`。
- 现有 runner 的 `readDurableYamlAfterReconcileUnlocked` 在读取 YAML 前调用
  reconcile，而 `reconcileDurableYamlTargetUnlocked` 在 checksum 匹配但 meta
  缺失时会写入 `.sha256.meta.json`；见
  `scripts/graphrag/batch-epub-workflow.mjs:6547`、
  `scripts/graphrag/batch-epub-workflow.mjs:5111`。

## 固定设计审计基准

1. **Rename ENOENT 总分类闭合**

   判定：PASS。

   任意 durable temp rename ENOENT 已被定义为
   `local_state_integrity`、`durable_temp_rename_enoent`、
   `stop_until_fixed`，且不得降级为 provider transient、unknown 或业务失败。

2. **Rename cause matrix 完整性**

   判定：PASS。

   Type DD 要求 `renameCause` 从 `temp_collision`、
   `reconciler_mistaken_deletion`、`concurrent_takeover`、
   `generation_advanced`、`filesystem_or_external_mutation` 中选择。证据不足时
   使用 `filesystem_or_external_mutation`，分类仍 fail-closed。

3. **Checksum crash window 基础规则**

   判定：PASS。

   Type DD 覆盖 `target_new_checksum_old`、
   `target_new_checksum_missing` 与 `checksum_new_parent_fsync_failed`，并要求
   无法证明 commit 完整时进入 `stop_until_fixed`。

4. **Durable failure 观测面一致性**

   判定：PASS。

   Type DD 要求 checkpoint、event、status-json 与 recovery summary 携带稳定
   durable fields。发现 required fields 缺失时，派生面必须标记
   `local_state_integrity` 与 `stop_until_fixed`。

5. **Checksum meta sidecar ENOENT 专项语义**

   判定：FAIL。

   当前 Type DD 没有把 `.sha256.meta.json` 的 backfill/commit 失败列为
   checksum commit matrix 的独立窗口。`metadata_backfilled` 写入失败时，应明确
   使用 sidecar target 作为 `targetLocator`，同时携带 `primaryTargetLocator`、
   `sidecarTargetLocator`、`checksumRecoveryDecision=metadata_backfill_failed`。

6. **Status-json 只读边界**

   判定：FAIL。

   Type DD 没有规定 `--status-json` 必须使用只读 durable inspection。现有读
   路径可以在 status-json 期间对 checksum meta 做 durable replace，这使一个
   观测命令变成 repair writer，并把原本可报告的 meta 缺失升级成命令失败。

7. **Fail-closed 与 read-only degraded 决策矩阵**

   判定：FAIL。

   Type DD 未区分以下两类状态：

   - primary target 有效，`.sha256` 与内容匹配，meta 缺失：status-json 应
     `read_only_degraded`，记录诊断，不写入、不 fail-closed。
   - repair/backfill writer 尝试写 meta sidecar 且 rename ENOENT：必须
     `local_state_integrity`、`durable_temp_rename_enoent`、`stop_until_fixed`。

8. **Sidecar target mapping 继承规则**

   判定：FAIL。

   Type DD 对 primary YAML/JSON targets 有明确 `targetMapping`，但 checksum
   `.sha256` 与 `.sha256.meta.json` 只零散出现于 lane 描述和 preflight 文字。
   Sidecar 应作为 primary target 的派生 target（derived target）继承 lane、
   owner、timeout、releaseOn 与 durable mode。

9. **Preflight sidecar scope**

   判定：FAIL。

   Type DD 要求 book-scoped output 递归覆盖 sidecars，但没有明确所有
   targetMapping 条目都必须派生 primary、checksum、checksum meta、temp、
   owner 与 lock 的 scan scope。catalog-level `books.yaml.sha256.meta.json`
   因此缺少一等 preflight 合同。

10. **Sidecar quarantine 合同**

    判定：FAIL。

    Type DD 规定 meta 冲突必须 quarantine 并 stop_until_fixed，但没有区分
    sidecar-only quarantine 与 primary target quarantine。对于 checksum 匹配、
    meta 缺失或 meta 文件本身损坏的场景，设计应避免隔离有效
    `books.yaml`；应隔离或重建 sidecar，并保留 primary target 只读。

## 阻塞问题

1. **P0：status-json 不能触发 durable repair 写入。**

   `--status-json` 是派生状态观测入口，不应获取 repair writer 角色。它必须用
   read-only inspection 读取 primary、checksum、meta、temp 与 lock 证据；任何
   backfill、quarantine、temp cleanup、lock recovery 都应由 runner start、
   migrate-only 或显式 repair command 执行。

2. **P0：checksum meta sidecar 不是一等 durable target。**

   `.sha256.meta.json` 必须纳入 target mapping、preflight、failure evidence 与
   quarantine 合同。否则 meta sidecar rename ENOENT 无法稳定归属到 lane、
   owner、release policy 与 primary target。

3. **P1：缺少 status-json 降级诊断 schema。**

   当 primary target 与 checksum 匹配但 meta 缺失时，status-json 应继续输出
   run 状态，并增加 durable diagnostic，而不是写 meta 或退出失败。该诊断需要
   独立字段，避免污染 item failureKind。

4. **P1：sidecar-only quarantine 边界不清。**

   meta 缺失、meta 损坏、meta 与 primary checksum 冲突、primary checksum
   mismatch 应有不同处理。当前设计没有说明何时仅隔离 sidecar，何时隔离
   primary target 与其 sidecar bundle。

## 建议的 Type DD 修改

1. **新增 sidecarTargetContract。**

   在 `productionContract.writerLanes.targetMappingContract` 下增加：

   ```yaml
   sidecarTargetContract:
     rule: >
       每个 durable YAML/JSON primary target 隐式拥有 checksum sidecar
       `{target}.sha256` 与 checksum meta sidecar
       `{target}.sha256.meta.json`。sidecar 必须继承 primary target 的
       lane、owner、laneTimeoutMs、releaseOn 与 durableMode。
     evidenceFields:
       - primaryTargetLocator
       - sidecarTargetLocator
       - sidecarKind
       - targetMappingRule
       - targetMappingPattern
       - lane
       - owner
   ```

2. **新增 statusJsonDurableReadMode。**

   在 `observability` 或 `durableStatePreflight` 下增加：

   ```yaml
   statusJsonDurableReadMode:
     rule: >
       --status-json 必须使用 read-only durable inspection。该模式不得执行
       checksum backfill、checksum meta backfill、quarantine、temp cleanup、
       stale lock recovery、fsync 或 durable replace。
     diagnostics:
       - diagnosticClass: checksum_meta_missing
         condition: target valid and checksum matches but checksum meta missing
         statusJsonDecision: read_only_degraded
         recoveryAction: run repair or normal runner preflight
       - diagnosticClass: checksum_mismatch
         statusJsonDecision: fail_closed_projection
         recoveryDecision: stop_until_fixed
       - diagnosticClass: live_temp_or_unresolved_lock
         statusJsonDecision: fail_closed_projection
         recoveryDecision: stop_until_fixed
   ```

3. **扩展 checksumCommit crashWindows。**

   增加 `checksum_meta_missing` 与 `checksum_meta_backfill_rename_enoent`：

   ```yaml
   - window: checksum_meta_missing
     recovery: >
       repair writer 可在持有 primary target lock 且 target/checksum 匹配时
       backfill meta；status-json 只能记录 read_only_degraded diagnostic。
   - window: checksum_meta_backfill_rename_enoent
     recovery: >
       分类为 local_state_integrity / durable_temp_rename_enoent /
       stop_until_fixed。不得 quarantine checksum 匹配的 primary target；
       必须保留 sidecar temp evidence，并要求人工或 repair command 复核。
   ```

4. **扩展 failurePolicy.renameEnoent requiredEvidence。**

   对 sidecar rename ENOENT 增加条件字段：

   ```yaml
   conditionalFields:
     checksumMetaSidecar:
       - primaryTargetLocator
       - sidecarTargetLocator
       - sidecarKind
       - checksumActual
       - checksumRecoveryDecision
       - statusJsonMode
       - completedPublishRule
   ```

5. **修改 durableStatePreflight scope。**

   将 preflight 规则改为所有 targetMapping 条目统一派生：

   ```yaml
   derivedSidecarScopeRule: >
     每个 targetMapping 条目必须扫描 primary target、checksum sidecar、
     checksum meta sidecar、对应 .tmp-*、.owner.json 与 .lock。该规则适用于
     catalog、batch-run、book-scoped output、dspy 与 settings targets。
   ```

6. **新增 sidecar quarantine 决策矩阵。**

   ```yaml
   sidecarQuarantineDecision:
     - condition: target valid, checksum matches, meta missing
       decision: no_quarantine_read_only_degraded_for_status_json
     - condition: target valid, checksum matches, meta invalid json
       decision: quarantine_sidecar_only_stop_until_fixed
     - condition: target valid, checksum matches, meta checksum conflict
       decision: quarantine_sidecar_only_stop_until_fixed
     - condition: target checksum mismatch and commit evidence invalid
       decision: quarantine_primary_bundle_stop_until_fixed
   ```

7. **补充验收矩阵。**

   增加以下 cases：

   - `status_json_checksum_meta_missing_read_only`
   - `checksum_meta_sidecar_backfill_rename_enoent`
   - `target_mapping_derived_sidecars`
   - `preflight_catalog_yaml_sidecar_scope`
   - `sidecar_only_quarantine_preserves_primary_target`

## 目标设计决策

checksum meta sidecar 的 temp rename ENOENT 应分类为
`local_state_integrity` / `durable_temp_rename_enoent` / `stop_until_fixed`。

status-json 中 checksum 匹配但 meta 缺失应采用 read-only degraded diagnostic，
不得 backfill。status-json 中若发现既有 durable failure event 或 checksum
mismatch，则应 fail-closed projection 到 `stop_until_fixed`。

sidecar meta 必须纳入 target mapping、preflight scope 与 quarantine 合同，可用
primary target 派生 mapping 实现，但设计必须把派生规则、证据字段和隔离边界
写入 Type DD 后再进入实现。
