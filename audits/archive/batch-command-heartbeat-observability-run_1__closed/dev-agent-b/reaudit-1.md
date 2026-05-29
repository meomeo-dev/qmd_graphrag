# Batch Command Heartbeat Observability Reaudit 1 - Agent B

## 结论

总体结果：PASS。

上一轮 FAIL 已修复：`BatchRecoverySummarySchema.retryPolicy`
中的 `heartbeatIntervalSeconds` 现在对 legacy summary 兼容
(legacy-compatible)，runner-local schema 与 public TypeScript contract
均定义为 optional。只读契约探针确认缺少该字段的旧
`recovery-summary.json` 可解析，新 summary 仍可携带该字段。

## 固定 Criteria 结果

1. PASS - 新 checkpoint 字段为 optional，不破坏既有 item JSON。
   `currentCommand` 和 `currentCommandStartedAt` 在 runner-local schema 中为
   optional：`scripts/graphrag/batch-epub-workflow.mjs:397`、
   `scripts/graphrag/batch-epub-workflow.mjs:398`；public contract 中同为
   optional：`src/contracts/batch-run.ts:104`、
   `src/contracts/batch-run.ts:105`。

2. PASS - 新 recovery summary 字段为 optional，并保留 existing consumers
   兼容性。item summary 字段为 optional：
   `scripts/graphrag/batch-epub-workflow.mjs:528`、
   `scripts/graphrag/batch-epub-workflow.mjs:529`、
   `src/contracts/batch-run.ts:242`、
   `src/contracts/batch-run.ts:243`。上一轮问题字段
   `retryPolicy.heartbeatIntervalSeconds` 现在也是 optional：
   `scripts/graphrag/batch-epub-workflow.mjs:568`、
   `src/contracts/batch-run.ts:283`。

3. PASS - 新 manifest policy 字段对 legacy manifests 为 optional，并在新写入
   manifests 中出现。schema 定义为 optional：
   `scripts/graphrag/batch-epub-workflow.mjs:475`、
   `src/contracts/batch-run.ts:187`。新建、加载协调和更新 manifest 时写入
   `heartbeatIntervalSeconds`：
   `scripts/graphrag/batch-epub-workflow.mjs:1171`、
   `scripts/graphrag/batch-epub-workflow.mjs:1199`、
   `scripts/graphrag/batch-epub-workflow.mjs:2745`。

4. PASS - public TypeScript contract 镜像 runner-local schemas。
   checkpoint、manifest、recovery summary item、recovery summary retry policy
   的新增字段在两侧均存在，且 optional/required 形态一致。关键对照：
   runner-local `heartbeatIntervalSeconds` optional 位于
   `scripts/graphrag/batch-epub-workflow.mjs:568`，public contract optional
   位于 `src/contracts/batch-run.ts:283`。

5. PASS - `--status-json` 保持只读，且不会启动 heartbeat monitors。
   `startCommandHeartbeatMonitor` 在 `statusJson` 下直接返回 `null`：
   `scripts/graphrag/batch-epub-workflow.mjs:1475`。`event` 与
   `writeTypedJson` 在 `statusJson` 下不写文件：
   `scripts/graphrag/batch-epub-workflow.mjs:966`、
   `scripts/graphrag/batch-epub-workflow.mjs:1037`。主流程打印 status 后返回：
   `scripts/graphrag/batch-epub-workflow.mjs:4072`。

6. PASS - redaction 与 log-root isolation 规则保持有效。
   `ensureDirs` 仍拒绝位于 `graph_vault` 内或 realpath 后落入
   `graph_vault` 的 `--log-root`：
   `scripts/graphrag/batch-epub-workflow.mjs:866`、
   `scripts/graphrag/batch-epub-workflow.mjs:893`。GraphRAG batch runner
   相关测试全量通过。

7. PASS - stop files 与 heartbeat metadata 未发现泄露 source paths、secrets
   或 raw GraphRAG content。stop file 名称只含 item id、sanitized command
   name 与 runner session id：
   `scripts/graphrag/batch-epub-workflow.mjs:1477`-
   `scripts/graphrag/batch-epub-workflow.mjs:1480`。heartbeat 写入的 metadata
   仅为 command name、timestamp 和 runner heartbeat：
   `scripts/graphrag/batch-epub-workflow.mjs:1453`-
   `scripts/graphrag/batch-epub-workflow.mjs:1458`。

8. PASS - `--heartbeat-interval-seconds` 有安全默认值和下界。
   CLI 默认值为 `30` 秒：
   `scripts/graphrag/batch-epub-workflow.mjs:71`。解析后使用
   `Math.max(1, ...)` 限制为至少 1 秒：
   `scripts/graphrag/batch-epub-workflow.mjs:124`-
   `scripts/graphrag/batch-epub-workflow.mjs:127`。

9. PASS - typed validation 仍会捕获 malformed running checkpoints。
   runner-local schema 要求 running checkpoint 具备 `runnerSessionId`、
   `runnerHost`、`runnerPid` 和 `runnerHeartbeatAt`：
   `scripts/graphrag/batch-epub-workflow.mjs:422`-
   `scripts/graphrag/batch-epub-workflow.mjs:437`。public contract 同步要求：
   `src/contracts/batch-run.ts:133`-
   `src/contracts/batch-run.ts:148`。只读契约探针确认缺少这些字段时解析失败。

10. PASS - 测试覆盖 static contract presence 与真实 long-command heartbeat
    behavior。静态检查覆盖新增 option、monitor、lock 和 persistence invariant：
    `test/cli.test.ts:1436`-
    `test/cli.test.ts:1449`。真实长命令 heartbeat 测试覆盖 checkpoint 更新、
    `--status-json` 读取运行中 command、最终清理 command 字段：
    `test/cli.test.ts:1508`。contract integration 测试覆盖 legacy summary
    缺少 `heartbeatIntervalSeconds`：
    `test/integrations/contracts.test.ts:1655`-
    `test/integrations/contracts.test.ts:1662`。

## 发现的问题

未发现阻断问题。上一轮 legacy recovery summary contract 不兼容问题已修复。

## 建议修复

无必需修复。建议保留当前 integration contract regression，防止
`retryPolicy.heartbeatIntervalSeconds` 未来被误改回 required。

## 执行的只读检查与测试

- `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs src/contracts/batch-run.ts test/cli.test.ts test/integrations/contracts.test.ts`
  通过。
- `npm run test:types` 通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"`
  通过：49 passed，132 skipped。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts -t "accepts batch execution bus envelopes with real schemas"`
  通过：1 passed，69 skipped。
- `node --import tsx --input-type=module ...` 契约探针通过：
  legacy manifest 解析为 true，legacy recovery summary 解析为 true，新 summary
  `heartbeatIntervalSeconds` 为 30，malformed running checkpoint 被拒绝。
