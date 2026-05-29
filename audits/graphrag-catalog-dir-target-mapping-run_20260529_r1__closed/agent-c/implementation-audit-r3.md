# Implementation Audit R3 - Agent C

## Verdict

PASS

## Baseline

固定基准：
`audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-c/implementation-criteria-r3.md`。

`git diff -- audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-c/implementation-criteria-r3.md`
无输出，criteria 未修改。

## Findings

无阻断问题。

上一轮 `FAIL` 的阻断项已解除：`before-claim preflight blocks nested book
output durable sidecar temp` 当前复测通过，非 catalog
`graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json` temp
不再先命中 `context.json` mapping missing。

## Criteria Review

1. PASS - `graph_vault/catalog/books.yaml` checksum meta backfill 的 parent
   directory fsync 映射到 `graph_vault/catalog`，read-only 与 repair writer
   路径均有验证。
2. PASS - 派生 parent directory fsync 保留 primary 或 sidecar operation 的
   `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind`、lane、
   owner 与 `primaryDurableKind`；runner 以 operation evidence 优先。
3. PASS - checksum sidecar 与 checksum meta sidecar 分别投影
   `sidecarKind: checksum` 与 `sidecarKind: checksum_meta`。
4. PASS - 裸 `fsyncDirectory` 使用显式 directory scope；生产目录缺映射时
   fail closed 为 `durable_target_mapping_missing`。
5. PASS - directory fsync failure evidence 包含 `directoryTargetLocator`、
   `directoryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
   `completedPublishRule`、lane 与 owner。
6. PASS - `fsyncErrno` sentinel 路径保留
   `unavailableFieldSentinels: ["fsyncErrno"]`；read-only projection 使用
   `not_attempted_read_only` sentinel。
7. PASS - `--status-json` 保持 read-only，不写 lock、temp、checksum、
   checksum meta、event、manifest、status 或 recovery summary。
8. PASS - read-only durable diagnostics 按同一 directory fsync rule 投影
   directory locator、directory durable kind、primary durable kind、lane、
   owner、fsync sentinel 与 repair gate。
9. PASS - `src/contracts/batch-run.ts` 与 runner 内部 schema 接受并保留目录
   fsync closure 字段，覆盖 command check、checkpoint、event、manifest、
   status-json 与 recovery summary。
10. PASS - 回归测试覆盖 catalog parent fsync、read-only projection、
    checksum sidecar evidence、非 catalog directory scope、shared durable
    store parity 与 contract closure；本轮复测的非 catalog `qmd_row_count.json`
    preflight 与 qmd index lock 用例均通过。

## Evidence

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:514` 与
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:520` 明确
  `graph_vault/books/{bookId}/output/context.json` 与 `stats.json` target
  mapping；`docs/architecture/graphrag-parallel-runner.type-dd.yaml:526`
  保留 book-scoped `qmd_row_count.json` mapping。
- `scripts/graphrag/batch-epub-workflow.mjs:431`、`:440`、`:449`
  分别映射 `context.json`、`stats.json` 与 book-scoped
  `qmd_row_count.json`。
- `src/job-state/durable-state-store.ts:207`、`:213`、`:218`
  在 shared durable store 中保持同等 mapping。
- `scripts/graphrag/batch-epub-workflow.mjs:2667` 至 `2688` 避免 `..`
  被误投影到 `graph_vault/..`，并正确投影 qmd index parent directory。
- `scripts/graphrag/batch-epub-workflow.mjs:3412` 至 `3441` 的
  `directoryFsyncEvidence()` 保留 operation-derived lane、owner、
  primary locator、sidecar locator、sidecar kind 与 primary durable kind。
- `scripts/graphrag/batch-epub-workflow.mjs:3450` 至 `3472` 在目录
  fsync failure evidence 中保留 target、platform、errno、sentinel 与
  `completedPublishRule`。
- `scripts/graphrag/batch-epub-workflow.mjs:4860` 至 `4891` 的 read-only
  projection 保留 directory locator、directory durable kind、primary
  durable kind、lane、owner、sentinel 与 `repairAllowed: false`。
- `scripts/graphrag/batch-epub-workflow.mjs:3895` 至 `3905`、`:3931`
  至 `3935` 在 qmd index stale cleanup 与 release 中用 owner operation
  执行 strict directory fsync。
- `src/contracts/batch-run.ts:66` 至 `87`、`:215` 至 `234`、`:438`
  至 `457` 等 schema 保留 directory fsync closure 字段。
- `test/graphrag-runner-status-json-readonly.test.ts:270` 至 `312` 覆盖
  status-json read-only projection 与 sentinel。
- `test/graphrag-runner-status-json-readonly.test.ts:418` 至 `435` 覆盖
  checksum meta sidecar directory fsync failure evidence。
- `test/graphrag-runner-status-json-readonly.test.ts:493` 至 `507` 覆盖
  checksum sidecar directory fsync failure evidence。
- `test/cli.test.ts:3480` 至 `3625` 覆盖非 catalog nested book output
  sidecar temp，断言 `before_claim`、`durable_preflight_unresolved_temp`
  与 `qmd_row_count.json` target。当前文件行尾仍显示 `30000` ms timeout，
  但本轮该用例实际在约 11.5s 内通过。
- `test/cli.test.ts:5382` 至 `5429` 覆盖所有 batch qmd commands 获取和
  释放 qmd index file lock，并断言 `qmdIndexWriterLane` 与 owner `qmd`。
- `test/integrations/contracts.test.ts:1812` 至 `1890` 覆盖 durable schema
  closure payloads across batch contracts。

## Verification

本轮复审执行并通过：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
  - 结果：通过。
- `npm run test:types -- --pretty false`
  - 结果：通过。
- `node --input-type=module -e "import { readFileSync } from 'node:fs'; import YAML from 'yaml'; YAML.parse(readFileSync('docs/architecture/graphrag-parallel-runner.type-dd.yaml', 'utf8')); console.log('YAML parse OK');"`
  - 结果：通过，输出 `YAML parse OK`。
- `npx vitest run test/cli.test.ts -t "before-claim preflight blocks nested book output durable sidecar temp" --reporter=verbose --testTimeout=120000`
  - 结果：通过，1 passed。
- `npx vitest run test/cli.test.ts -t "directory fsync failure blocks completed publication with evidence|durable state classifier preserves local failure classes|durable reconcile commits matching pending checksum metadata|durable preflight blocks partial checksum sidecar crash window|runner-start preflight blocks book YAML temp from target mapping|all batch qmd commands acquire the qmd index file lock" --reporter=verbose --testTimeout=180000`
  - 结果：通过，6 passed。
- `npx vitest run test/book-job-state.test.ts -t "shared durable publish reports checksum sidecar directory fsync evidence|qmd index lock release reports directory fsync evidence" --reporter=verbose --testTimeout=120000`
  - 结果：通过，2 passed。
- `npx vitest run test/graphrag-runner-durable-preflight.test.ts --reporter=verbose --testTimeout=120000`
  - 结果：通过，1 passed。
- `npx vitest run test/integrations/contracts.test.ts -t "batch execution bus envelopes|durable schema closure" --reporter=verbose`
  - 结果：通过，2 passed。
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts --reporter=verbose --testTimeout=150000`
  - 结果：通过，7 passed。

未运行真实 EPUB Runner，未处理 `inbox` 下真实书籍，未读取 `.env`、密钥或凭据。
