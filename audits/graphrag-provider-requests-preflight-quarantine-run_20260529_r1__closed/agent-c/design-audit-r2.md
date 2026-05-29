# Agent C Design Audit R2

## 判定

PASS

当前 Type DD 修订已经关闭 R1 固定范围内的问题。设计现在把
`provider-requests` 明确分类为历史观测（historical observation），并把
runner-start 默认行为收敛为只读限量诊断（read-only capped diagnostic），不再允许
普通 runner 在 manifest 创建前对历史 provider request primary target 执行无界
quarantine。

## 发现

1. PASS - provider request durable target 已被一致分类为 historical observation。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`-`249` 规定
     runner_start 必须按 target family 的 `startupCriticality` 选择扫描模式，并且
     `historical_observation` target 不得因出现在 targetMapping 中自动升级为
     runner_start 阻断性写入 preflight。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:476`-`488` 将
     `graph_vault/catalog/provider-requests/*.json` 标为
     `provider_request_fingerprint`、`criticality: historical_observation`、
     `startupCriticality: non_blocking` 与
     `retentionAuthority: cache_like_observation`。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1334`-`1341`
     进一步声明 provider request fingerprint 只用于成本、审计与高成本恢复诊断，
     不是新 batch runner 的 completion authority。

2. PASS - runner_start 对 provider request 的默认处理已改为 read-only capped
   diagnostic。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:784`-`801` 为
     `provider_request_fingerprint` 增加 family override：runner-start preflight
     mode 为 `read_only_capped_diagnostic`，最大扫描 200 个 targets，报告 10 个
     samples，`maxRunnerStartMutationCount: 0`，恢复决策为
     `continue_with_diagnostic_unless_catalog_blocked`。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:797`-`801` 明确规定
     runner_start 发现 provider request checksum mismatch、checksum missing、
     checksum meta missing 或 invalid JSON 时，不得写 checksum、meta、event 或
     quarantine target；只能输出 capped diagnostic，诊断自身不可置信时才
     `stop_until_fixed`，且仍不得 mutate provider-requests primary target。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`-`1280` 再次规定
     historical observation target 在 runner_start 中只能执行 read-only capped
     diagnostic，`mutationCount` 必须为 0，且不得创建 lock、temp、checksum、
     checksum meta、corrupt target 或 provider-requests 目录内 recovery event。

3. PASS - 普通 runner 已禁止 provider request primary quarantine，写入式修复边界已
   限定为 explicit repair 或 migrate-only。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:772`-`777` 规定
     `provider_request_fingerprint` 属于 historical observation；normal
     runner_start 与 normal resume 默认只能执行 read-only/capped diagnostic，
     不得 quarantine primary target；writable checksum backfill、meta backfill
     或 primary quarantine 只能发生在 explicit repair 或 migrate-only 边界内，并
     必须有数量上限与 operator-visible summary。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:486`-`488` 将该 target
     family 的普通 runner mutation policy 固定为 `no_primary_quarantine`，并把
     writable repair boundary 固定为 `explicit_repair_or_migrate_only`。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1346`-`1349` 规定
     explicit repair 每次最多处理 50 个 targets，且必须先写 startup/repair
     summary；normal runner_start 不得对 provider-requests primary target 执行
     primary bundle quarantine。

4. PASS - manifest-before-writable-recovery 与 startup recovery manifest 可观测要求已
   补齐。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1267`-`1272` 规定
     runner_start 必须先创建或加载最小 startup recovery manifest，再执行任何可写
     runner-start recovery；该 manifest 至少包含 runId、stage、scopeCount、
     targetCount、mutationCount、firstSample、lastSample、decision 与
     explicitRepairHint。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`-`1276` 对 critical
     catalog、current run 与 book-scoped target 的 writable repair 设置 fail-fast 与
     目录级默认上限，避免 manifest 创建前无界写入式恢复。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`-`1280` 对
     provider request historical observation 明确要求 `mutationCount` 为 0，禁止在
     provider-requests 目录内写 recovery event，因此 R1 的 manifest 前大量
     quarantine event 路径已被设计禁止。

5. PASS - status-json read-only projection 已与 runner_start provider request scope
   对齐。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1676`-`1684` 定义
     `--status-json` 为严格只读 observer，禁止 repair、writable reconcile、
     quarantine、event append、manifest rebuild、status cache 写入和 recovery
     summary 写入。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1685`-`1690` 规定
     `--status-json` 必须对
     `graph_vault/catalog/provider-requests/*.json` 执行 read-only capped scan，
     使用与 runner_start 相同的 family policy，输出 scannedTargetCount、
     degradedTargetCount、sampleTargetLocators、diagnosticClass 与
     normalRunnerAction；目录过大时报告 `scanTruncated: true`。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1711`-`1717` 为
     `provider_request_durable_degraded` 定义 read-only capped diagnostic、
     `continue_with_diagnostic_unless_catalog_blocked` 与
     `normalRunnerAction: no_primary_quarantine`。

6. PASS - 验收点已覆盖 R1 固定失败的回归边界。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1899` 将
     `runner_start with many historical provider request checksum mismatches` 纳入
     fault injection。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:2071`-`2085` 增加
     `provider_requests_runner_start_read_only_capped` 验收用例，要求多历史
     provider-requests mismatch fixture、startup recovery manifest-before-writable
     recovery、capped count 与 samples、不重命名 primary 到 `.corrupt-*`、不创建
     provider request lock/temp/checksum/checksum meta、status-json 同诊断且无
     stateRoot mutation，并允许 normal runner 在无 critical catalog blocker 时继续
     manifest creation。
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:2086`-`2093` 增加
     `provider_requests_explicit_repair_bounded` 验收用例，要求 explicit repair 或
     migrate-only 边界、max target count、max event count、summary evidence、
     mutationCount、quarantineCount 与 operator-visible repair decision。

## 结论

R2 复审未发现 R1 固定问题仍然开放。当前修订已覆盖分类、启动期只读限量诊断、
普通 runner 禁止 primary quarantine、显式 repair/migrate-only 边界、status-json
只读投影、startup recovery manifest 可观测要求以及验收点。判定为 PASS。
