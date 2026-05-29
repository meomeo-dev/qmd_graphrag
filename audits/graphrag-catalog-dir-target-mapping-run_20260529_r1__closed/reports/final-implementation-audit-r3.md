# Implementation Audit R3 Final Report

## Status

PASS

## Scope

本报告关闭
`graphrag-catalog-dir-target-mapping-run_20260529_r1` 的固定 R3
implementation audit。R3 criteria 未修改，审计目录内没有创建新的 R4
基准。

## Agent Results

- `agent-a`: PASS
- `agent-b`: PASS
- `agent-c`: PASS

## Closure Evidence

- `graph_vault/catalog`、batch-run、book output、DSPy 与 `.qmd`
  directory fsync scope 均按显式 target mapping fail-closed。
- 派生 parent directory fsync 保留 primary/sidecar operation 的 lane、
  owner、target mapping pattern、primary locator、sidecar locator、
  `sidecarKind` 与 `primaryDurableKind`。
- checksum sidecar 与 checksum meta sidecar parent fsync evidence 分别保留
  `sidecarKind: checksum` 与 `sidecarKind: checksum_meta`。
- `--status-json` read-only projection 不写入 state，并使用同一 directory
  fsync projection rule。
- book-scoped non-catalog output 覆盖 `context.json`、`stats.json` 与
  nested `lancedb/*.lance/qmd_row_count.json`。
- qmd index lock release 与 stale cleanup 使用 owner operation 做 strict
  directory fsync，`durableLocator` 不再把 `..` 误投影为 `graph_vault/..`。

## Verification

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `npm run test:types -- --pretty false`
- YAML parse `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `npx vitest run test/book-job-state.test.ts -t "shared durable publish reports checksum sidecar directory fsync evidence|qmd index lock release reports directory fsync evidence" --reporter=verbose --testTimeout=120000`
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts --reporter=verbose --testTimeout=150000`
- `npx vitest run test/graphrag-runner-durable-preflight.test.ts --reporter=verbose --testTimeout=120000`
- `npx vitest run test/integrations/contracts.test.ts -t "batch execution bus envelopes|durable schema closure" --reporter=verbose`
- `npx vitest run test/cli.test.ts -t "directory fsync failure blocks completed publication with evidence|durable state classifier preserves local failure classes|durable reconcile commits matching pending checksum metadata|durable preflight blocks partial checksum sidecar crash window|runner-start preflight blocks book YAML temp from target mapping|all batch qmd commands acquire the qmd index file lock" --reporter=verbose --testTimeout=180000`
- `npx vitest run test/cli.test.ts -t "before-claim preflight blocks nested book output durable sidecar temp" --reporter=verbose --testTimeout=120000`

## Runner Decision

不恢复真实 EPUB runner。当前用户指令要求审计最终 close 时停止。
