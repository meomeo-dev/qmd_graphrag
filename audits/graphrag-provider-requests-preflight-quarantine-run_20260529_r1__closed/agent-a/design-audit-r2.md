# GraphRAG Provider Requests Preflight Quarantine R2 设计复审

判定：PASS

## 输入范围

本复审仅覆盖固定审计目录
`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open`
中的 R1 固定范围与 R1 发现。固定范围限定为真实 run
`epub-batch-20260529-post-r3-real-1` 暴露的 runner-start preflight
失败：`graph_vault/catalog/provider-requests/*.json` 在 manifest 创建前被大量
判定为 `durable_checksum_mismatch` 并 quarantine
（`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/design-audit-scope-r1.md:5`）。
固定问题要求检查 runner-start 可扫描与可写恢复目标、provider-requests
criticality、历史 checksum 状态分类、启动前恢复上限、manifest 前恢复可观测性、
status-json 与 normal runner-start 一致性、显式 repair 边界和验收点
（`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/design-audit-scope-r1.md:15`）。

## 发现

1. PASS - Type DD 已把 provider-requests 分类为历史观测
   （historical observation），不再因 targetMapping 成员身份自动升级为
   runner-start 阻断性写入 preflight。

   证据：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241` 规定
   runner_start 必须按 target family 的 `startupCriticality` 选择扫描模式，
   且 `historical_observation` target 不得因出现在 targetMapping 中自动升级为
   阻断性写入 preflight
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:246`）。provider
   request target 显式声明 `targetFamily: provider_request_fingerprint`、
   `criticality: historical_observation`、`startupCriticality: non_blocking` 与
   `retentionAuthority: cache_like_observation`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:476`）。
   专属规则进一步声明历史 provider request fingerprint 记录只用于成本、审计与
   高成本恢复诊断，不是新 batch runner 的 completion authority
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1334`）。

2. PASS - runner-start 对 provider request 的策略已变为 read-only capped
   diagnostic，并禁止 normal runner primary quarantine。

   证据：targetMapping 对 provider request 声明
   `runnerStartPreflightMode: read_only_capped_diagnostic`、
   `normalRunnerMutationPolicy: no_primary_quarantine` 与
   `writableRepairBoundary: explicit_repair_or_migrate_only`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:482`）。family override
   要求 `runnerStartPreflightMode: read_only_capped_diagnostic`、
   `normalRunnerPrimaryQuarantine: forbidden`、`maxRunnerStartMutationCount: 0`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:784`），并规定
   runner_start 遇到 checksum mismatch、checksum missing、checksum meta missing
   或 invalid JSON 时，不得写 checksum、meta、event 或 quarantine target，只能输出
   capped diagnostic
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:797`）。

3. PASS - normal runner 与 explicit repair/migrate-only 的写入边界已被拆开。

   证据：checksum reconcile 的 `repairWriter` 规则仍保留 normal resume、
   migrate-only 或显式 repair command 的通用许可，但明确 target family 可收窄该
   许可；`provider_request_fingerprint` 在 normal runner_start 与 normal resume
   默认只能执行 read-only/capped diagnostic，不得 quarantine primary target
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:767`）。同一段要求对该
   family 的 writable checksum backfill、meta backfill 或 primary quarantine 只能
   在 explicit repair 或 migrate-only 边界内发生，并必须有数量上限与 operator-visible
   summary（`docs/architecture/graphrag-parallel-runner.type-dd.yaml:775`）。专属规则
   把 explicit repair 限制为每次最多 50 个 target，并要求先写 startup/repair
   summary（`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1346`）。

4. PASS - status-json read-only projection 已覆盖同一 provider-requests scope，
   且不会隐藏 normal runner-start 风险。

   证据：`statusJsonReadOnlyContract` 禁止 status-json 执行 repair、writable
   reconcile、quarantine、event append、manifest rebuild、status cache 写入或
   recovery summary 写入
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1676`）。新增
   `providerRequestProjectionRule` 要求 status-json 对
   `graph_vault/catalog/provider-requests/*.json` 执行 read-only capped scan，使用与
   runner_start 相同的 family policy，并输出 `scannedTargetCount`、
   `degradedTargetCount`、样本、诊断类别与 `normalRunnerAction`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1685`）。诊断表把
   provider request durable degradation 投影为 `read_only_capped_diagnostic`，
   `normalRunnerAction: no_primary_quarantine`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1711`）。

5. PASS - startup recovery manifest 与 manifest-before-writable-recovery 的
   可观测要求已闭合。

   证据：`durableStatePreflight.runnerStart` 要求先创建或加载最小 startup recovery
   manifest，再执行任何可写 runner-start recovery；该 manifest 至少包含 runId、
   stage、scopeCount、targetCount、mutationCount、firstSample、lastSample、
   decision 与 explicitRepairHint
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1267`）。同一段规定
   provider_request_fingerprint 等 historical_observation target 在 runner_start
   只能执行 read-only capped diagnostic，`mutationCount` 必须为 0，且不得创建 lock、
   temp、checksum、checksum meta、corrupt target 或 provider-requests 目录内
   recovery event（`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`）。

6. PASS - 启动前恢复的数量、scope 与事件损伤边界已对固定问题形成约束。

   证据：critical catalog、current run 与 book-scoped target 的 runner_start
   writable repair 被限定为 bounded writable repair，且每个目录默认最多扫描 200 个
   primary targets、报告 10 个样本、执行 1 个 writable quarantine，超过任一上限
   必须 `stop_until_fixed`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`）。provider request
   family 另设 `maxRunnerStartScannedTargets: 200`、
   `maxRunnerStartReportedSamples: 10`、`maxRunnerStartMutationCount: 0`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:792`），关闭了 R1 中
   manifest 创建前无界 quarantine loop 的设计许可。

7. PASS - 验收点已覆盖 provider-requests runner-start read-only capped 行为、
   explicit repair 边界和 status-json 同步投影。

   证据：新增验收用例 `provider_requests_runner_start_read_only_capped` 要求 fixture
   构造多个历史 provider-requests checksum mismatch 或 checksum metadata 缺失目标，
   runner_start 在任何 writable recovery 前创建或加载 startup recovery manifest，
   输出 capped 诊断，不把 primary target rename 为 `.corrupt-*`，不创建 provider
   request lock、temp、checksum 或 checksum meta，并允许 normal runner 在无 critical
   catalog blocker 时继续创建 manifest
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:2071`）。新增
   `provider_requests_explicit_repair_bounded` 要求 explicit repair 或 migrate-only
   才能允许 provider request primary quarantine，并要求 max target count、max event
   count 与 summary file evidence before mutation
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:2086`）。

## 结论

当前 Type DD 修订已关闭 R1 固定发现。设计层面已经把 provider-requests 从
runner-start 阻断性写入恢复对象收窄为 cache-like historical observation，并把普通
runner-start 的行为限定为 read-only capped diagnostic；写入式 backfill/quarantine
被限定在 explicit repair 或 migrate-only 边界内，status-json 以同 scope 只读投影风险，
startup recovery manifest 和新增验收点也覆盖了 manifest 创建前无界 quarantine 的回归
场景。
