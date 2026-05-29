# Batch Command Heartbeat Observability Audit - Agent B

## 结论

总体结果：FAIL。

当前补丁在 checkpoint、manifest、`--status-json` 只读行为
(read-only behavior)、日志隔离 (log isolation)、heartbeat interval option
和新增行为测试上基本满足基准要求。阻断问题是 recovery summary contract
对旧 `recovery-summary.json` 不兼容：新增的
`retryPolicy.heartbeatIntervalSeconds` 被定义为必填字段。

## 固定 Criteria 审计

1. PASS - 新 checkpoint 字段为 optional，不破坏既有 item JSON。
   `currentCommand` 和 `currentCommandStartedAt` 在 runner-local schema 与
   public contract 中均为 optional：
   `scripts/graphrag/batch-epub-workflow.mjs:395`、
   `scripts/graphrag/batch-epub-workflow.mjs:396`、
   `src/contracts/batch-run.ts:104`、
   `src/contracts/batch-run.ts:105`。

2. FAIL - 新 recovery summary item 字段为 optional，但新增 retry policy 字段
   不是 optional，破坏既有 recovery summary consumers。
   `currentCommand` 与 `currentCommandStartedAt` 在 item summary 中为 optional，
   但 `retryPolicy.heartbeatIntervalSeconds` 在 runner-local 和 public contract
   中均为必填：
   `scripts/graphrag/batch-epub-workflow.mjs:566`、
   `src/contracts/batch-run.ts:283`。
   只读契约探针确认旧 summary 缺少该字段时解析失败：
   `retryPolicy.heartbeatIntervalSeconds: Invalid input: expected number,
   received undefined`。

3. PASS - 新 manifest policy 字段对 legacy manifests 为 optional，并在新写入
   manifest 中出现。schema 定义为 optional：
   `scripts/graphrag/batch-epub-workflow.mjs:473`、
   `src/contracts/batch-run.ts:187`。新建、加载后协调、更新 manifest 时写入
   `heartbeatIntervalSeconds`：
   `scripts/graphrag/batch-epub-workflow.mjs:1116`、
   `scripts/graphrag/batch-epub-workflow.mjs:1144`、
   `scripts/graphrag/batch-epub-workflow.mjs:2609`。

4. PASS - public TypeScript contract 与 runner-local schemas 保持镜像。
   checkpoint、manifest、recovery summary item 和 retry policy 的新增字段在
   两侧均存在且 optional/required 形态一致。注意：criterion 2 的修复必须同步
   改两侧 schema。

5. PASS - `--status-json` 仍为只读，且不会启动 heartbeat monitors。
   `startCommandHeartbeatMonitor` 在 `statusJson` 下直接返回 `null`：
   `scripts/graphrag/batch-epub-workflow.mjs:1350`。`event` 与
   `writeTypedJson` 在 `statusJson` 下不写文件：
   `scripts/graphrag/batch-epub-workflow.mjs:964`、
   `scripts/graphrag/batch-epub-workflow.mjs:983`。主流程在打印 status 后返回：
   `scripts/graphrag/batch-epub-workflow.mjs:3932`。

6. PASS - redaction 与 log-root isolation 规则保持有效。
   `ensureDirs` 继续拒绝位于 `graph_vault` 内或 realpath 后落入
   `graph_vault` 的 `--log-root`：
   `scripts/graphrag/batch-epub-workflow.mjs:864`、
   `scripts/graphrag/batch-epub-workflow.mjs:892`。命令 stdout/stderr 仍通过
   `redactLog` 写入：
   `scripts/graphrag/batch-epub-workflow.mjs:3041`、
   `scripts/graphrag/batch-epub-workflow.mjs:3042`。

7. PASS - stop files 与 heartbeat metadata 未发现泄露 source paths、secrets
   或 raw GraphRAG content。stop file 名称只包含 item id、sanitized command
   name 与 runner session id：
   `scripts/graphrag/batch-epub-workflow.mjs:1351`-
   `scripts/graphrag/batch-epub-workflow.mjs:1356`。checkpoint metadata 只写入
   internal command name 与 timestamp：
   `scripts/graphrag/batch-epub-workflow.mjs:1331`-
   `scripts/graphrag/batch-epub-workflow.mjs:1333`。

8. PASS - `--heartbeat-interval-seconds` 有安全默认值和下界。
   CLI 默认值为 `30` 秒：
   `scripts/graphrag/batch-epub-workflow.mjs:70`。解析后使用 `Math.max(1, ...)`
   限制为至少 1 秒：
   `scripts/graphrag/batch-epub-workflow.mjs:123`-
   `scripts/graphrag/batch-epub-workflow.mjs:126`。

9. PASS - typed validation 仍会捕获 malformed running checkpoints。
   runner-local 与 public contract 仍要求 running checkpoint 具备
   `runnerSessionId`、`runnerHost`、`runnerPid` 和 `runnerHeartbeatAt`：
   `scripts/graphrag/batch-epub-workflow.mjs:420`-
   `scripts/graphrag/batch-epub-workflow.mjs:435`、
   `src/contracts/batch-run.ts:133`-
   `src/contracts/batch-run.ts:148`。只读契约探针确认缺少这些字段的 running
   checkpoint 被拒绝。

10. PASS - 测试覆盖 static contract presence 与真实 long-command heartbeat
    behavior。静态测试检查新增 option、monitor 函数和字段：
    `test/cli.test.ts:1436`-
    `test/cli.test.ts:1446`。真实长命令 heartbeat 测试覆盖 checkpoint 更新：
    `test/cli.test.ts:1508`。

## 发现的问题

1. Legacy recovery summary contract 不兼容。
   位置：
   `scripts/graphrag/batch-epub-workflow.mjs:566`、
   `src/contracts/batch-run.ts:283`。
   影响：旧版 `recovery-summary.json` 的 `retryPolicy` 没有
   `heartbeatIntervalSeconds` 时，新 schema 解析失败。这违反 criterion 2
   对 recovery summary optional fields 与 existing consumers 的要求。

## 建议修复

- 将 `BatchRecoverySummarySchema.retryPolicy.heartbeatIntervalSeconds` 在
  runner-local schema 和 public contract 中改为 optional，或提供 legacy-safe
  default。若遵循固定基准，优先使用 optional；生成的新 summary 仍可继续写入
  该字段。
- 增加 regression test：构造不含 `retryPolicy.heartbeatIntervalSeconds` 的旧
  recovery summary，断言 public contract 能解析；同时断言新生成的 summary
  仍包含该字段。

## 执行的只读命令与测试

- `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs src/contracts/batch-run.ts test/cli.test.ts`
  通过。
- `npm run test:types` 通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"`
  通过：49 passed，132 skipped。
- `node --import tsx --input-type=module ...` 契约探针：
  legacy manifest 解析通过，legacy recovery summary 解析失败，malformed
  running checkpoint 被拒绝。
