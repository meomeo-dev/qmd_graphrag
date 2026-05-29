# Implementation Audit R10 - Agent C

Verdict: PASS

## Criteria Results

1. I01_temp_identity_exclusive_create: PASS

   共享 durable store 以 target 语义、pid、timestamp 与 operationId/UUID
   构造 temp 身份，并用 `wx` exclusive create 写入 target 与 checksum temp：
   `src/job-state/durable-state-store.ts:475`,
   `src/job-state/durable-state-store.ts:478`,
   `src/job-state/durable-state-store.ts:483`,
   `src/job-state/durable-state-store.ts:500`,
   `src/job-state/durable-state-store.ts:1760`,
   `src/job-state/durable-state-store.ts:1765`。Runner adapter 具备同等
   temp identity 与 exclusive create：
   `scripts/graphrag/batch-epub-workflow.mjs:2447`,
   `scripts/graphrag/batch-epub-workflow.mjs:2449`,
   `scripts/graphrag/batch-epub-workflow.mjs:4214`,
   `scripts/graphrag/batch-epub-workflow.mjs:4224`。

2. I02_single_durable_boundary: PASS

   repository、capability catalog、settings projection、durable-json、
   python bridge 与 DSPy policy store 复用 shared durable contract：
   `src/job-state/repository.ts:333`,
   `src/job-state/repository.ts:400`,
   `src/graphrag/capability-catalog.ts:31`,
   `src/graphrag/capability-catalog.ts:342`,
   `src/graphrag/settings-projection.ts:7`,
   `src/graphrag/settings-projection.ts:259`,
   `src/job-state/durable-json.ts:1`,
   `src/job-state/durable-json.ts:17`,
   `src/integrations/python-bridge.ts:11`,
   `src/integrations/python-bridge.ts:151`,
   `src/dspy/policy-store.ts:55`,
   `src/dspy/policy-store.ts:190`。Runner 声明等价 adapter contract：
   `scripts/graphrag/batch-epub-workflow.mjs:206`。

3. I03_lock_owner_fencing: PASS

   shared lock owner 记录 pid、host、runnerSessionId、generation、
   fencingTokenHash、targetLocator、operationId、heartbeatAt 与 expiresAt：
   `src/job-state/durable-state-store.ts:1798`。stale lock 删除前校验 TTL、
   expiry、recovery fence、host 与 owner liveness，并写入 recovery record：
   `src/job-state/durable-state-store.ts:891`,
   `src/job-state/durable-state-store.ts:906`,
   `src/job-state/durable-state-store.ts:913`。Runner JSON lock 有同等 owner
   fencing 与 stale recovery 事件：
   `scripts/graphrag/batch-epub-workflow.mjs:5321`,
   `scripts/graphrag/batch-epub-workflow.mjs:5335`,
   `scripts/graphrag/batch-epub-workflow.mjs:5195`。

4. I04_live_temp_cleanup_safety: PASS

   shared cleanup 在删除 temp 前验证 owner、target、createdAt、cleanup fence、
   target generation、stale age、host liveness 与 lease expiry：
   `src/job-state/durable-state-store.ts:969`,
   `src/job-state/durable-state-store.ts:983`,
   `src/job-state/durable-state-store.ts:986`,
   `src/job-state/durable-state-store.ts:987`,
   `src/job-state/durable-state-store.ts:989`,
   `src/job-state/durable-state-store.ts:997`。Runner preflight 对未可安全清理的
   temp 返回 unresolved blocker：
   `scripts/graphrag/batch-epub-workflow.mjs:4348`,
   `scripts/graphrag/batch-epub-workflow.mjs:4486`。对应测试保留 fresh、
   incomplete-owner 与 generation-advanced temp：
   `test/cli.test.ts:2883`, `test/cli.test.ts:2977`,
   `test/cli.test.ts:3049`。

5. I05_checksum_commit_recovery: PASS

   shared store 覆盖 checksum missing、pending meta、checksum-old 与 mismatch
   quarantine：
   `src/job-state/durable-state-store.ts:575`,
   `src/job-state/durable-state-store.ts:598`,
   `src/job-state/durable-state-store.ts:615`,
   `src/job-state/durable-state-store.ts:642`,
   `src/job-state/durable-state-store.ts:646`。Runner YAML/JSON reconcile 等价：
   `scripts/graphrag/batch-epub-workflow.mjs:4863`,
   `scripts/graphrag/batch-epub-workflow.mjs:4998`,
   `scripts/graphrag/batch-epub-workflow.mjs:5048`,
   `scripts/graphrag/batch-epub-workflow.mjs:5123`。R10 测试注入 mapped YAML
   checksum mismatch 并断言 stop_until_fixed：
   `test/graphrag-runner-durable-preflight.test.ts:135`,
   `test/graphrag-runner-durable-preflight.test.ts:142`,
   `test/graphrag-runner-durable-preflight.test.ts:192`。

6. I06_fsync_platform_failure: PASS

   shared store 将 file fsync 与 parent directory fsync failure 归类为 durable
   state failure，并携带 fsyncTarget、fsyncErrno、fsyncPlatform、durableMode 与
   completedPublishRule：
   `src/job-state/durable-state-store.ts:1479`,
   `src/job-state/durable-state-store.ts:1493`,
   `src/job-state/durable-state-store.ts:1497`,
   `src/job-state/durable-state-store.ts:1533`。Runner adapter 有同等证据：
   `scripts/graphrag/batch-epub-workflow.mjs:2878`,
   `scripts/graphrag/batch-epub-workflow.mjs:2892`,
   `scripts/graphrag/batch-epub-workflow.mjs:2896`。fault test 覆盖：
   `test/cli.test.ts:2821`。

7. I07_batch_observability_schema: PASS

   command check、item checkpoint、manifest durableFailureSummary、event 与
   recovery summary schema 均承载 local durable diagnostics：
   `src/contracts/batch-run.ts:134`,
   `src/contracts/batch-run.ts:226`,
   `src/contracts/batch-run.ts:344`,
   `src/contracts/batch-run.ts:371`,
   `src/contracts/batch-run.ts:423`。Runner 将 durable fields 投影到 event、
   manifest、recovery-summary 与 status.json：
   `scripts/graphrag/batch-epub-workflow.mjs:2646`,
   `scripts/graphrag/batch-epub-workflow.mjs:2798`,
   `scripts/graphrag/batch-epub-workflow.mjs:8062`,
   `scripts/graphrag/batch-epub-workflow.mjs:8325`,
   `scripts/graphrag/batch-epub-workflow.mjs:8328`。R10 测试断言 event、
   checkpoint 与 recovery summary：
   `test/graphrag-runner-durable-preflight.test.ts:171`,
   `test/graphrag-runner-durable-preflight.test.ts:179`,
   `test/graphrag-runner-durable-preflight.test.ts:183`。

8. I08_failure_classifier_mapping: PASS

   durable local-state classifier 在 provider transient 规则前执行：
   `scripts/graphrag/batch-failure-classifier.mjs:7`,
   `scripts/graphrag/batch-failure-classifier.mjs:47`。映射覆盖 rename ENOENT、
   temp collision、live temp deletion、fsync failure、checksum windows/mismatch
   与 lock timeout：
   `scripts/graphrag/batch-failure-classifier.mjs:83`,
   `scripts/graphrag/batch-failure-classifier.mjs:102`,
   `scripts/graphrag/batch-failure-classifier.mjs:128`,
   `scripts/graphrag/batch-failure-classifier.mjs:137`,
   `scripts/graphrag/batch-failure-classifier.mjs:166`,
   `scripts/graphrag/batch-failure-classifier.mjs:178`,
   `scripts/graphrag/batch-failure-classifier.mjs:347`。classifier test 覆盖
   durable checksum 与 lock timeout：
   `test/cli.test.ts:2624`, `test/cli.test.ts:2632`。

9. I09_direct_call_chain_coverage: PASS

   受审直接 durable YAML/JSON 路径通过 shared API 或 runner adapter：
   `src/job-state/repository.ts:333`,
   `src/job-state/repository.ts:400`,
   `src/graphrag/capability-catalog.ts:745`,
   `src/graphrag/settings-projection.ts:263`,
   `src/job-state/durable-json.ts:17`,
   `src/integrations/python-bridge.ts:155`,
   `src/dspy/policy-store.ts:194`,
   `scripts/graphrag/batch-epub-workflow.mjs:4208`,
   `scripts/graphrag/batch-epub-workflow.mjs:6540`。runner durable target mapping
   覆盖 catalog、book-scoped YAML、batch JSON、DSPy、qmd output sidecar 与
   qmd index：
   `scripts/graphrag/batch-epub-workflow.mjs:238`,
   `scripts/graphrag/batch-epub-workflow.mjs:275`,
   `scripts/graphrag/batch-epub-workflow.mjs:296`,
   `scripts/graphrag/batch-epub-workflow.mjs:379`,
   `scripts/graphrag/batch-epub-workflow.mjs:419`,
   `scripts/graphrag/batch-epub-workflow.mjs:436`。

10. I10_fault_injection_tests: PASS

   R10 新增测试覆盖 mapped book-scoped YAML run target、checksum mismatch、
   mapping-derived before_claim preflight、event/checkpoint/recovery summary
   durable diagnostics：
   `test/graphrag-runner-durable-preflight.test.ts:113`,
   `test/graphrag-runner-durable-preflight.test.ts:135`,
   `test/graphrag-runner-durable-preflight.test.ts:142`,
   `test/graphrag-runner-durable-preflight.test.ts:190`,
   `test/graphrag-runner-durable-preflight.test.ts:204`,
   `test/graphrag-runner-durable-preflight.test.ts:213`。R9 共享 store 证据仍在：
   shared quarantine rename ENOENT：
   `test/book-job-state.test.ts:539`,
   `test/book-job-state.test.ts:564`；
   stale lock recovery record：
   `test/book-job-state.test.ts:722`,
   `test/book-job-state.test.ts:745`。CLI fault tests 覆盖 checksum crash
   window、stale lock preflight、nested sidecar preflight 与 rename ENOENT：
   `test/cli.test.ts:3280`, `test/cli.test.ts:3386`,
   `test/cli.test.ts:3464`, `test/cli.test.ts:3611`。

## Blocking Findings

None.

## R9 Closure

R9 Agent C 阻塞项已关闭。

R9 阻塞项要求 runner YAML reader/preflight fault coverage。R10 新增的
`test/graphrag-runner-durable-preflight.test.ts` 构造了
`graph_vault/books/{bookId}/runs/legacy.yaml` 这一映射内 book-scoped YAML
target，写入 durable fixture 后注入 checksum mismatch，并运行 synthetic
batch。测试断言 `durable_preflight_blocked` 发生在 `before_claim`，结果为
`failureKind=local_state_integrity`、`localFailureClass=durable_checksum_mismatch`、
`retryable=false`、`recoveryDecision=stop_until_fixed`，并验证 checkpoint 与
recovery summary 保留同等 durable diagnostics。

R9 已通过的 shared-store stale lock recovery record 与 shared quarantine
rename ENOENT 证据仍存在且本轮重新验证通过：
`test/book-job-state.test.ts:539`,
`test/book-job-state.test.ts:564`,
`test/book-job-state.test.ts:722`,
`test/book-job-state.test.ts:745`。

设计文档的 `runner_yaml_reader_preflight_fault` 矩阵要求 YAML reader 持有
per-target lock、checksum/live-temp fault 在 claim/resume 前 stop_until_fixed，
并写入 event、status-json 或 recovery summary：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1337`,
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1339`,
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1340`,
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1342`。当前测试与该矩阵
一致。

## Verification Reviewed

审阅了 R10 状态记录：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:95`
through
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:118`。

本轮运行并通过的轻量验证：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-runner-durable-preflight.test.ts`
  passed: 1 passed.
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/book-job-state.test.ts -t "quarantine rename ENOENT|stale durable temps|durable checksum"`
  passed: 4 passed, 62 skipped.
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/cli.test.ts -t "durable preflight blocks partial checksum sidecar crash window|durable preflight blocks unresolved stale lock without fencing evidence|before-claim preflight blocks nested book output durable sidecar temp|rename ENOENT during durable checkpoint write is stop-until-fixed"`
  passed: 4 passed, 244 skipped.

未读取 `.env` 或 secret 文件。未启动真实 EPUB runner。未处理 inbox 真实图书。
未修改 fixed criteria 文件。
