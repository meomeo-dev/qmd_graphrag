# GraphRAG Provider Requests Preflight Quarantine 实施审计 R1

## 结论

PASS。

本轮审计仅使用
`audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open`
作为打开审计目录（open audit directory），并仅按
`agent-a/implementation-criteria-r1.md` 的 10 条固定基准执行核对。
未发现需要映射到固定基准的失败项。

## 审计对象

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `test/graphrag-runner-durable-preflight.test.ts`
- `test/graphrag-runner-status-json-readonly.test.ts`
- `audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/status.json`

## 固定基准逐项结论

1. PASS。审计过程未创建新的 `__open` 目录，且仅写入本报告文件。

2. PASS。`graph_vault/catalog/provider-requests/*.json` 在 target mapping 中被标记为
   `provider_request_fingerprint`、`historical_observation` 与
   `read_only_capped_diagnostic`。`durablePreflightScanDirectory` 对该 scope 进入
   `providerRequestReadOnly` 分支，只读取 target、checksum 与 checksum meta 并
   返回 diagnostic，不调用 writable reconcile。

3. PASS。provider request read-only preflight 返回 diagnostic 后直接返回空 blocker
   列表，不进入普通 JSON reconcile/quarantine 路径。focused test 明确断言
   runner-start 输出和 event log 不包含 `durable_json_target_quarantined`，且
   `request-a.json.corrupt-*` 不存在。

4. PASS。provider request diagnostic 路径只执行 `readFileSync`、`existsSync` 与
   `JSON.parse` 等只读操作，不创建 lock、temp、checksum 或 checksum meta。status-json
   provider request focused test 使用 catalog snapshot 断言运行前后 stateRoot 不变。

5. PASS。runner 主流程先 rediscover EPUB items，再创建或加载 manifest，然后执行
   runner-start preflight。provider request checksum mismatch 被加入 startup diagnostic，
   不作为 blocker 抛出，因此不会作为唯一原因阻止 EPUB rediscovery 或 manifest 创建。

6. PASS。非 `--status-json` 路径在 `durablePreflight("runner_start")` 前调用
   `loadManifest` 和 `writeStartupRecoveryManifest`。startup recovery summary 包含
   `runId`、`stage`、`scopeCount`、`targetCount`、`mutationCount`、`decision`、
   `explicitRepairHint`，并在发现 provider request durable risk 后写入
   `providerRequestDiagnostics`。

7. PASS。provider request summary diagnostic 包含 `scannedTargetCount`、
   `degradedTargetCount`、`sampleTargetLocators`、`diagnosticClass` 与
   `normalRunnerAction`，并记录扫描上限、样本上限与 `maxRunnerStartMutationCount: 0`。

8. PASS。`--status-json` 路径不执行 runner-start writable preflight，而是对同一
   provider request scope 调用 read-only scan，并通过 `recordStatusJsonDurableDiagnostic`
   投影到 `durableStateFailures`。focused test 对 provider request mismatch 断言
   `read_only_capped_diagnostic`、`no_primary_quarantine` 和 stateRoot snapshot 不变。

9. PASS。critical YAML 行为未被放宽。普通 YAML durable target 仍走
   `reconcileDurableYamlTarget`，checksum mismatch 仍会 `quarantineDurableTarget`
   并触发 fail-closed。focused test 覆盖 book-scoped `runs/legacy.yaml` checksum fault，
   断言 `durable_preflight_blocked`、`stop_until_fixed` 与
   `durable_yaml_target_quarantined`。

10. PASS。`reports/status.json` 记录的验证状态为 YAML parse、Node syntax check、
    TypeScript typecheck 与 focused Vitest 均 passed。本地复现实测结果如下：
    - `node --check scripts/graphrag/batch-epub-workflow.mjs`: passed
    - YAML parse for `docs/architecture/graphrag-parallel-runner.type-dd.yaml`: passed
    - `npm run test:types`: passed
    - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts test/graphrag-runner-status-json-readonly.test.ts`:
      passed, 2 test files and 10 tests passed

## 证据摘要

- Type DD 明确将 provider request fingerprint 定义为 historical observation，
  runner-start mutation count 为 0，并禁止 normal runner primary quarantine。
- runner 实现通过 target mapping 派生 provider request preflight scope，未维护独立
  手写目录清单。
- provider request runner-start diagnostic 不进入 `reconcileDurableJsonTarget`，
  因而不触发 checksum backfill、meta backfill、lock、temp 或 quarantine。
- manifest startup recovery 在 runner-start preflight 前写入，provider request
  diagnostic 后续合并进 manifest metadata。
- status-json 使用同 scope read-only projection，并通过测试快照验证无 stateRoot
  mutation。
- book-scoped YAML checksum mismatch 仍 fail-closed 并 quarantine，说明 critical
  YAML 行为没有被 provider request 放宽策略误伤。

## 修复建议

无。
