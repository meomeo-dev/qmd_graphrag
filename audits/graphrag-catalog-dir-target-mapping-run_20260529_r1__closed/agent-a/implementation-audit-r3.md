# Implementation Audit R3 - Agent A

## Verdict

PASS

## Baseline

本轮增量复核使用固定基准：

`audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-a/implementation-criteria-r3.md`

criteria 本轮未修改。`git diff -- .../implementation-criteria-r3.md`
无输出。相关设计文档为
`docs/architecture/graphrag-parallel-runner.type-dd.yaml`。

## Findings

无阻断问题

## Criteria Review

1. PASS - `graph_vault/catalog/books.yaml` checksum meta backfill 的 parent
   directory fsync 映射到 `graph_vault/catalog`，directory scope 表覆盖
   catalog 目录，checksum meta sidecar 写入后以同一 operation 执行 parent
   fsync。

2. PASS - 派生 parent directory fsync 保留 primary 或 sidecar write
   operation 的 locator、`sidecarKind`、lane、owner 与
   `primaryDurableKind`。runner `directoryFsyncEvidence` 继承 operation 并
   补齐 directory closure；shared durable store 执行同等投影。

3. PASS - checksum sidecar 与 checksum meta sidecar 分别记录
   `sidecarKind: checksum` 与 `sidecarKind: checksum_meta`。runner 与
   shared durable store 均有独立 sidecar evidence 生成逻辑。

4. PASS - 裸 `fsyncDirectory` 只使用显式 directory scope；生产目录缺映射
   fail closed。runner 对 `directory-fsync` 走
   `durableDirectoryFsyncMapping`。`context.json` 与 `stats.json` 已在
   Type DD、runner 与 shared durable store 中映射到 `checkpointWriterLane`
   / `graphOutputProducer`
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:514`,
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:520`;
   `scripts/graphrag/batch-epub-workflow.mjs:431`,
   `scripts/graphrag/batch-epub-workflow.mjs:448`;
   `src/job-state/durable-state-store.ts:207`,
   `src/job-state/durable-state-store.ts:216`)。`durableLocator` 对 `..`
   与 `../` 做边界判断，避免 stateRoot 或 qmdRoot 外路径误归入 durable
   scope (`scripts/graphrag/batch-epub-workflow.mjs:2667`,
   `scripts/graphrag/batch-epub-workflow.mjs:2688`)。

5. PASS - 目录 fsync failure evidence 包含 `directoryTargetLocator`、
   `directoryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
   `completedPublishRule`、lane 与 owner。runner、shared durable store 与
   qmd index lock failure path 均保留这些字段。runner qmd index file lock
   release 与 stale cleanup 删除 lock 后调用 strict directory fsync
   (`scripts/graphrag/batch-epub-workflow.mjs:3895`,
   `scripts/graphrag/batch-epub-workflow.mjs:3935`)。

6. PASS - `fsyncErrno` 使用 sentinel 时同步保留
   `unavailableFieldSentinels: ["fsyncErrno"]`。runner、shared durable store
   与 read-only projection 均保留该 sentinel 约束。

7. PASS - `--status-json` 保持 read-only。runner 在 `statusJson` 下不执行
   真实 directory fsync；回归测试确认缺失 checksum meta 时不产生 lock、
   temp、checksum meta、event、manifest、status 或 recovery summary mutation。

8. PASS - read-only durable diagnostics 按同一 directory fsync rule 投影
   directory locator、directory durable kind、primary durable kind、lane、
   owner、fsync sentinel 与 repair gate。`inspectDurableSerializedTargetReadOnly`
   设置 `repairAllowed: false`、`fsyncErrno: not_attempted_read_only` 与
   sentinel。

9. PASS - `src/contracts/batch-run.ts` 与 runner 内部 schema 接受并保留目录
   fsync closure 字段，覆盖 command check、checkpoint、event、manifest、
   status-json 与 recovery summary。

10. PASS - 回归测试覆盖 catalog parent fsync、read-only projection、checksum
    sidecar evidence、非 catalog directory scope、shared durable store parity
    与 contract closure。覆盖点包括 nested book output preflight
    (`test/cli.test.ts:3480`, `test/cli.test.ts:3624`) 与 qmd lock command
    coverage (`test/cli.test.ts:5382`, `test/cli.test.ts:5429`)。

## Verification

本轮执行并通过：

- `git diff -- audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-a/implementation-criteria-r3.md --`
- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `npm run test:types -- --pretty false`
- YAML parse `docs/architecture/graphrag-parallel-runner.type-dd.yaml`

本轮静态复核确认：

- runner 与 shared durable store 已包含 `context.json` / `stats.json`
  targetMapping。
- `durableLocator` 已排除 `..` 与 `../` 越界投影。
- runner qmd index file lock release/stale cleanup 删除 lock 后执行 strict
  directory fsync。

本轮新增聚焦测试复跑：

- `npx vitest run test/cli.test.ts -t "before-claim preflight blocks nested book output durable sidecar temp|all batch qmd commands acquire the qmd index file lock" --reporter=verbose --testTimeout=180000`：
  nested book output sidecar temp 用例通过；all-qmd-lock 用例在测试自身
  180000ms 上限处超时。
- `npx vitest run test/cli.test.ts -t "all batch qmd commands acquire the qmd index file lock" --reporter=verbose --testTimeout=360000`：
  单独复跑仍在测试自身 180000ms 上限处超时；未出现断言失败。超时前事件日志
  已出现多条 `qmd_index_file_lock_acquired` 与
  `qmd_index_file_lock_released`，metadata 包含 `qmdIndexWriterLane`、
  `targetMappingOwner: "qmd"`、generation、fencing token hash 与 operation id。

沿用已通过的 R3 验证集合：

- `npx vitest run test/book-job-state.test.ts -t "shared durable publish reports checksum sidecar directory fsync evidence|qmd index lock release reports directory fsync evidence" --reporter=verbose --testTimeout=120000`
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts --reporter=verbose --testTimeout=150000`
- `npx vitest run test/graphrag-runner-durable-preflight.test.ts --reporter=verbose --testTimeout=120000`
- `npx vitest run test/integrations/contracts.test.ts -t "batch execution bus envelopes|durable schema closure" --reporter=verbose`
- `npx vitest run test/cli.test.ts -t "directory fsync failure blocks completed publication with evidence|durable state classifier preserves local failure classes|durable reconcile commits matching pending checksum metadata|durable preflight blocks partial checksum sidecar crash window|runner-start preflight blocks book YAML temp from target mapping" --reporter=verbose --testTimeout=180000`

未运行完整测试套件，原因是本任务限定为固定 R3 implementation re-audit。
未启动真实 EPUB Runner，未处理 `inbox` 下真实书籍，未读取或输出 `.env`、
密钥或凭据。
