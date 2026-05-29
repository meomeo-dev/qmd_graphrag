# GraphRAG Provider Requests Preflight Quarantine R2 设计复审

判定：PASS

本复审仅覆盖固定审计范围：真实 run
`epub-batch-20260529-post-r3-real-1` 暴露的 runner-start preflight
失败，即 `graph_vault/catalog/provider-requests/*.json` 在 manifest 创建前被大量
判定为 `durable_checksum_mismatch` 并 quarantine。固定范围与固定问题见
`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/design-audit-scope-r1.md:5`
至
`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/design-audit-scope-r1.md:34`。

## R2 复审发现

1. PASS - provider-requests historical observation 分类已经补齐。

   证据：Type DD 在 target mapping 中将
   `graph_vault/catalog/provider-requests/*.json` 绑定为
   `provider_request_fingerprint`，并明确标注
   `criticality: historical_observation`、`startupCriticality: non_blocking`、
   `runnerStartPreflightMode: read_only_capped_diagnostic`、
   `normalRunnerMutationPolicy: no_primary_quarantine`、
   `writableRepairBoundary: explicit_repair_or_migrate_only` 与
   `retentionAuthority: cache_like_observation`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:476`-
   `488`）。恢复章节进一步规定其 authority 为 historical observation，且不是
   新 batch runner 的 completion authority
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1334`-
   `1341`）。

2. PASS - runner_start read-only capped diagnostic 已被定义为 provider request
   的正常启动行为。

   证据：preflight scope 规则要求 runner_start 按 target family 的
   startupCriticality 选择扫描模式，并声明 historical_observation target 不得因
   出现在 targetMapping 中自动升级为阻断性写入 preflight
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`-
   `249`）。provider request family override 要求 runner_start 发现 checksum
   mismatch、checksum missing、checksum meta missing 或 invalid JSON 时不得写
   checksum、meta、event 或 quarantine target，只能输出 capped diagnostic
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:783`-
   `801`）。

3. PASS - normal runner no primary quarantine 边界已经闭合。

   证据：repair writer 通用许可被 target family 收窄，provider request 在 normal
   runner_start 与 normal resume 中默认只能执行 read-only/capped diagnostic，不得
   quarantine primary target
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:767`-
   `777`）。durableStatePreflight 进一步规定 runner_start 对
   provider_request_fingerprint 的 mutationCount 必须为 0，且不得创建 lock、temp、
   checksum、checksum meta、corrupt target 或 provider-requests 目录内 recovery
   event（`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`-
   `1280`）。

4. PASS - explicit repair/migrate-only 边界已经明确。

   证据：provider request 的 writable checksum backfill、meta backfill 或 primary
   quarantine 只能发生在 explicit repair 或 migrate-only 边界内，并必须有数量上限
   与 operator-visible summary
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:775`-
   `777`）。恢复规则规定 explicit repair 每次最多 50 个 target，并且必须先写
   startup/repair summary
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1344`-
   `1348`）。

5. PASS - status-json read-only projection 与 normal runner-start 风险呈现已经对齐。

   证据：status-json 合同声明其为严格只读 observer，禁止 repair、writable
   reconcile、quarantine、event append、manifest rebuild、status cache 写入或
   recovery summary 写入
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1676`-
   `1684`）。providerRequestProjectionRule 要求 status-json 对
   `graph_vault/catalog/provider-requests/*.json` 执行 read-only capped scan，使用
   与 runner_start 相同的 family policy，并输出 scannedTargetCount、
   degradedTargetCount、sampleTargetLocators、diagnosticClass 与 normalRunnerAction
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1685`-
   `1690`）。对应诊断类将 normalRunnerAction 固定为
   `no_primary_quarantine`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1711`-
   `1717`）。

6. PASS - startup recovery manifest 与 manifest-before-writable-recovery
   可观测要求已经补齐。

   证据：durableStatePreflight 规定必须先创建或加载最小 startup recovery
   manifest，再执行任何可写 runner-start recovery；该 manifest 至少包含 runId、
   stage、scopeCount、targetCount、mutationCount、firstSample、lastSample、
   decision 与 explicitRepairHint
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1267`-
   `1272`）。同一段还规定 provider request historical_observation 在
   runner_start 中只能 read-only capped diagnostic，mutationCount 必须为 0
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`-
   `1280`）。

7. PASS - 启动期恢复上限和大规模 quarantine 防扩散约束已经覆盖固定问题。

   证据：critical catalog、current run、book-scoped target 的 runner_start
   writable repair 被限制为 bounded repair，且每目录默认最多扫描 200 个 primary
   targets、报告 10 个样本、执行 1 个 writable quarantine，超过任一上限必须
   stop_until_fixed
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`-
   `1276`）。provider request family override 另设
   `maxRunnerStartScannedTargets: 200`、`maxRunnerStartReportedSamples: 10` 与
   `maxRunnerStartMutationCount: 0`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:788`-
   `795`）。

8. PASS - 共享 durable adapter 的 providerRequestFingerprint 所属关系已经补齐。

   证据：single durable boundary 要求 YAML/JSON durable replace、
   read-before-reconcile、checksum backfill、quarantine、temp cleanup 与 lock
   recovery 必须通过一个共享契约或经适配器声明等价，并把
   `providerRequestFingerprint` 纳入 owningModules
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:625`-
   `639`）。

9. PASS - 验收点已经覆盖 R1 固定失败的防回归场景。

   证据：fault injection 列入 `runner_start with many historical provider request
   checksum mismatches`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1895`-
   `1900`）。acceptance matrix 新增
   `provider_requests_runner_start_read_only_capped`，要求构造多个历史
   provider-requests checksum mismatch 或 checksum metadata 缺失，验证
   runner_start 创建或加载 startup recovery manifest、输出 capped diagnostic、
   不 rename primary target、不创建 provider request lock/temp/checksum/meta，并且
   normal runner 可继续 manifest creation，除非 critical catalog target 也 blocked
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:2071`-
   `2085`）。同一矩阵还新增
   `provider_requests_explicit_repair_bounded`，要求 explicit repair 或 migrate-only
   后才允许 provider request primary quarantine，并有 max target count、max event
   count 与 summary evidence
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:2086`-
   `2093`）。

## 结论

当前 Type DD 修订已经关闭 R1 固定发现：provider request 被一致建模为
cache-like historical observation；runner_start 与 status-json 均采用相同 scope
的 read-only capped diagnostic；normal runner 不再拥有 provider request primary
quarantine 权限；primary quarantine 被限制在 explicit repair 或 migrate-only
边界；manifest 创建前的可写 recovery 被 startup recovery manifest 与上限约束
保护；验收矩阵包含固定失败的防回归用例。
