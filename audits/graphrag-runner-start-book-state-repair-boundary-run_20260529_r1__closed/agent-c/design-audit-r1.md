# Agent C Design Audit R1

结论：FAIL

## 审计范围

仅审计 `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 对
`runner_start` 处理 book-scoped durable checksum mismatch 的操作边界
（operation boundary）。未审计源码，未修改源码，未修改 docs，未创建新的
审计基准或新的 open audit 目录。

## 固定审计项

1. `preflight` 的 `mutationCount` 与 `targetCount` 必须准确记录。
2. bounded repair 上限必须可配置，并进入 `manifest` 与
   `recovery-summary`。
3. 失败后不得留下 ambiguous running manifest。
4. next operator action 必须明确。
5. 不得产生多个 open audit 或变化基准。

## 核对结果

1. FAIL - `mutationCount` 与 `targetCount` 被要求出现在 startup recovery
   manifest，但准确性与统计口径未闭合。

   证据：

   - Type DD 要求任何可写 runner-start recovery 前创建或加载最小 startup
     recovery manifest，并包含 `targetCount`、`mutationCount`、样本与
     `decision`。
   - Type DD 要求 book-scoped `beforeResumeBook` preflight 结果写入 event 或
     recovery summary，不能只写 stdout。

   缺口：

   - 未定义 `targetCount` 的口径：是 scanned primary targets、degraded
     targets、eligible repair targets、attempted mutation targets，还是同目录
     capped target 数。
   - 未定义 `mutationCount` 的口径：是 attempted、committed、quarantined、
     backfilled、failed mutation，还是它们的分类合计。
   - 未要求 event、manifest、recovery-summary 三个观测面使用同一统计来源，
     也未要求 mismatch 时 fail closed。

   必须修改的文档点：

   - 在 `durableStatePreflight.runnerStart` 或独立
     `runnerStartPreflightObservability` 中定义 `targetCount` 与
     `mutationCount` 的精确口径。
   - 要求 `scannedTargetCount`、`eligibleRepairTargetCount`、
     `attemptedMutationCount`、`committedMutationCount`、
     `quarantineCount`、`backfillCount`、`failedMutationCount` 与
     `scanTruncated` 在 startup recovery manifest、event 与
     recovery-summary 中同源记录。
   - 要求计数字段不一致时分类为 `local_state_integrity` 且
     `recoveryDecision: stop_until_fixed`。

2. FAIL - book-scoped bounded repair 有默认值，但没有形成可配置上限
   （configurable limit）与观测面闭包。

   证据：

   - Type DD 对 critical catalog、current run、book-scoped target 规定
     runner_start 可执行 bounded writable repair；每个目录默认最多扫描 200 个
     primary targets、报告 10 个样本、执行 1 个 writable quarantine，超过上限
     必须 `stop_until_fixed`。
   - 配置契约只列出并发类 CLI/config 项，例如 `--book-concurrency` 与 provider
     concurrency；未列出 runner-start durable repair 上限。
   - `recoverySummaryRequiredFields` 未包含 runner-start repair limit、
     limit source、limit hit reason 或 cap decision 字段。

   缺口：

   - “默认最多”不是可配置契约，操作者无法在配置层审计或调整 book-scoped
     repair 上限。
   - 上限未要求进入 manifest 与 recovery-summary，因此无法验证失败是因为
     target 真实不可修复，还是因为扫描、样本或 mutation cap 被触发。

   必须修改的文档点：

   - 在 `configurationContract` 增加 runner-start durable repair 上限配置，
     至少包括 `maxRunnerStartScannedTargetsPerDirectory`、
     `maxRunnerStartReportedSamplesPerDirectory`、
     `maxRunnerStartWritableMutationsPerDirectory` 与
     `maxRunnerStartRepairEvents`。
   - 规定配置优先级（CLI > environment > config > default）与合法范围。
   - 在 manifest 与 recovery-summary 字段契约中加入
     `repairLimitSource`、`repairLimitConfig`、`repairLimitHit`、
     `repairLimitReason`、`targetCount`、`mutationCount` 与分类计数字段。

3. FAIL - 失败后不得留下 ambiguous running manifest 的设计要求不足。

   证据：

   - Type DD 规定 manifest/status 是派生缓存，event/checkpoint 是故障证据主链。
   - Type DD 规定 resumed coordinator 会扫描 checkpoints/events 重建 manifest，
     expired running items 变为可恢复状态。
   - Type DD 要求 runner_start 先创建或加载 startup recovery manifest。

   缺口：

   - 未明确规定 runner_start book-scoped preflight 在 fail-fast 或
     `stop_until_fixed` 后，manifest 必须进入哪个非歧义终态。
   - 未禁止在 preflight blocker 已触发时保留 `running` item、live lease 或
     `stage: running` 的 startup manifest。
   - 未要求失败 manifest 写入 `failedStage: runner_start_preflight`、
     `blockedBookId`、`blockedTargetLocator` 与 `resumeAllowed: false`。

   必须修改的文档点：

   - 在 `durableStatePreflight.runnerStart` 增加 failure publication rule：
     book-scoped preflight blocker 后必须发布 `blocked`、`stopped` 或
     `failed_stop_until_fixed` 之一，禁止留下 ambiguous `running` manifest。
   - 要求 startup recovery manifest 与 batch manifest 同步记录
     `failedStage: runner_start_preflight`、`recoveryDecision:
     stop_until_fixed`、`resumeAllowed: false`、`blockedBookId`、
     `blockedTargetLocator` 与 next action。

4. FAIL - next operator action 没有被字段化。

   证据：

   - Type DD 的 startup manifest 最小字段包含 `explicitRepairHint`。
   - provider request 路径中有 operator-visible summary 的要求。
   - book-scoped durable mismatch 路径只要求 `repair/quarantine/stop_until_fixed`
     与 recovery summary，没有统一 next action 字段。

   缺口：

   - `explicitRepairHint` 是提示，不是可机器验证的 operator action contract。
   - 未要求区分 `run_status_json`、`run_explicit_repair`、
     `run_migrate_only`、`manual_restore_from_backup`、`delete_quarantined_bundle`
     或 `rerun_book` 等下一步动作。
   - 未要求 next action 进入 manifest、recovery-summary 与 audit status。

   必须修改的文档点：

   - 增加 `nextOperatorAction` 枚举与 `operatorActionReason` 字段。
   - 要求 book-scoped checksum mismatch 的 stop path 必须在
     startup recovery manifest、recovery-summary 和 final failure event 中输出
     `nextOperatorAction`。
   - 要求不能决定下一步动作时 fail closed，并输出
     `nextOperatorAction: inspect_recovery_summary`。

5. PASS - 单 open audit 与基准冻结规则在 Type DD 中已经存在，本次目录状态也符合。

   证据：

   - `auditStateContract.lifecycle.singleOpenInvariant` 要求真实 Runner 阻塞修复时
     audits 根目录只能保留当前阻塞项的一个 `__open` 目录。
   - `statusSuffixConsistency` 要求 status 字段与目录后缀一致，不一致时先做
     audit state reconciliation。
   - `implementationBaseline.freezePoint` 与 `driftRule` 禁止返修过程中变化实施
     审计基准；设计变更必须回到设计审计循环。
   - 当前审计目录检查结果只存在
     `graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open`
     一个 open audit 目录。

   非阻塞说明：

   - 本轮是设计审计，不创建实施审计 criteria。后续若进入实施审计，必须先在
     对应 agent 目录冻结 10 条固定 criteria，再开始实现审计。

## 必须修改的文档点汇总

1. 在 Type DD 中新增或补强 runner-start book-scoped preflight observability
   contract，定义 `targetCount` 与 `mutationCount` 的准确口径和同源校验规则。
2. 在 `configurationContract` 中加入 book-scoped runner-start bounded repair
   上限配置，并规定优先级、默认值与合法范围。
3. 将 bounded repair 上限、实际计数、limit hit 状态与样本写入 startup
   recovery manifest、batch manifest durable failure summary 与
   recovery-summary。
4. 增加 runner-start preflight blocker 的 failure publication rule，禁止留下
   ambiguous running manifest。
5. 增加 `nextOperatorAction` 与 `operatorActionReason` 字段，要求
   `stop_until_fixed` 路径必须给出可执行下一步。

## 结论

当前 Type DD 已具备 targetMapping 派生扫描、book-scoped preflight、默认 bounded
repair、single-open audit 与基准冻结规则，但对本轮固定审计对象仍未形成完整
设计闭包。尤其是准确计数、可配置上限、manifest/recovery-summary 观测面、
失败终态与 operator action 仍不足以验证真实 runner_start 修复边界。

本轮判定为 FAIL。进入实现或恢复真实 EPUB runner 前，必须先补齐上述 Type DD
设计点，并重新进行设计审计。
