# GraphRAG Provider Requests Preflight Quarantine Implementation Audit R1

## 审计结论

PASS。

本轮实施审计仅覆盖 provider-requests runner-start preflight quarantine
修复。审计基准固定采用 `agent-c/implementation-criteria-r1.md` 的 10 条，
未扩展、替换或新增标准。被审计实现满足固定基准；未发现需要阻止通过的
实施缺陷。

## 审计范围

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `test/graphrag-runner-durable-preflight.test.ts`
- `test/graphrag-runner-status-json-readonly.test.ts`
- `audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/status.json`

## 固定基准逐项结果

1. PASS。审计仅覆盖本次 provider-requests runner-start preflight
   quarantine 修复。实现、测试与验证记录均围绕
   `graph_vault/catalog/provider-requests/*.json` 的 read-only capped
   diagnostic、normal runner no primary quarantine、status-json read-only
   projection 与 critical durable preflight 保留行为。

2. PASS。非 provider request critical durable preflight 保护未被移除或
   放宽。`graphrag-runner-durable-preflight.test.ts` 保留并通过
   book-scoped run YAML checksum mismatch 阻断用例，断言
   `durable_preflight_blocked`、`stop_until_fixed` 与 YAML primary quarantine。

3. PASS。provider request target mapping 仍保留 lane、owner 与 directory
   fsync 映射。Type DD 将 `graph_vault/catalog/provider-requests/*.json`
   映射到 `catalogWriterLane` 与 `providerRequestFingerprint`；实现中的
   `durableTargetMappingTable` 与 `durableDirectoryFsyncScopeTable` 同步保留
   `catalogWriterLane`、`providerRequestFingerprint` 和
   `graph_vault/catalog/provider-requests` 目录 fsync scope。

4. PASS。provider request normal runner action 明确为
   `no_primary_quarantine`。Type DD 使用
   `normalRunnerMutationPolicy: no_primary_quarantine`；实现诊断字段输出
   `normalRunnerAction: "no_primary_quarantine"`；runner-start 与 status-json
   测试均断言该字段。

5. PASS。read-only diagnostic 未通过 provider request side effect 表达风险。
   provider request 扫描路径只读取 target、checksum 与 checksum meta，生成
   capped diagnostic；runner-start 将结果写入 startup recovery manifest，
   status-json 将结果投影到 stdout。实现未对 provider request primary target
   执行 quarantine、checksum backfill、checksum meta backfill、lock/temp 创建
   或 provider-requests 目录内 recovery event append。

6. PASS。startup recovery metadata 包含固定要求字段。实现的
   `writeStartupRecoveryManifest` 写入 `runId`、`stage`、`scopeCount`、
   `targetCount`、`mutationCount`、`decision` 与 `explicitRepairHint`，并在
   provider request diagnostic 后保持 `mutationCount: 0` 与
   `continue_with_provider_request_diagnostic` decision。

7. PASS。diagnostic samples 受 `maxRunnerStartReportedSamples` 上限约束。
   实现设置 `providerRequestStartupSampleLimit = 10`，summary 使用
   `slice(0, providerRequestStartupSampleLimit)` 生成 `sampleTargetLocators`，
   并输出 `maxRunnerStartReportedSamples: 10`。

8. PASS。provider request diagnostic 保留 target locator。实现为每个
   diagnostic 保留 `targetLocator` 与 `primaryTargetLocator`，summary 保留
   `sampleTargetLocators`。runner-start 与 status-json 测试均断言样本 locator
   包含 `catalog/provider-requests/request-a.json`。

9. PASS。测试覆盖 runner-start 与 status-json 两个入口。
   `graphrag-runner-durable-preflight.test.ts` 覆盖 runner-start provider
   request mismatch without quarantine；
   `graphrag-runner-status-json-readonly.test.ts` 覆盖 status-json provider
   request mismatch without state mutation。

10. PASS。验证命令未出现失败。`reports/status.json` 记录 node syntax、
    YAML parse、typecheck 与 focused Vitest 均为 passed；审计复核命令也全部
    通过。

## 验证复核

审计期间复跑以下命令，结果均通过：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node -e "import('node:fs').then(fs=>import('yaml').then(YAML=>{YAML.parse(fs.readFileSync('docs/architecture/graphrag-parallel-runner.type-dd.yaml','utf8')); console.log('yaml parse ok')}))"`
- `npm run test:types`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts test/graphrag-runner-status-json-readonly.test.ts`

Focused Vitest 结果：2 个测试文件通过，10 个测试通过。

## 残余风险

未发现阻止 PASS 的残余风险。现有测试覆盖了 runner-start 与 status-json 的
provider request read-only capped diagnostic 主路径，并保留了 critical YAML
preflight 阻断行为。后续若扩展 explicit repair 或 migrate-only 的 provider
request 可写修复路径，应另行按固定边界审计其 bounded mutation 与 operator
summary 证据。
