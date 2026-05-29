Result: FAIL

## Findings

1. 严重度：High

   文件/行号：
   `audit/graphrag-query-ready-identity-settings-dev-run_1__closed/status.yaml:33`
   `scripts/graphrag/batch-failure-classifier.mjs:140`
   `scripts/graphrag/batch-epub-workflow.mjs:693`
   `scripts/graphrag/batch-epub-workflow.mjs:4237`

   原因：四个 observed failure text 中，当前 classifier 只把
   `GraphRAG document identity is missing for query_ready` 和
   `capabilityScope references unknown or not-ready graphCapabilityId(s)` 识别为
   local artifact gate。`GraphRAG document identity sidecar does not match
   query_ready` 和 `graph_vault/settings.yaml is not the managed projection of
   .qmd/index.yml` 仍返回 `unknown`。批处理 repair 入口依赖
   `canRepairLocalArtifactGate`，因此这些 persisted `stop_until_fixed` checkpoint
   不会进入 pending repair；settings projection drift 的安全 rewrite 也不会被触发。

   修复建议：将这两个真实 failure text 纳入受保护的本地 gate 分类，且 repair
   前重新验证当前 sidecar/settings evidence。sidecar 仍 mismatch、user-owned
   settings 或 invalid source config 时必须 fail-closed；evidence 已修复时 reopen
   到 pending/continue_pending 并走正常 resume 与 command checks。补充从
   persisted failed checkpoint 启动的回归测试。

2. 严重度：High

   文件/行号：
   `scripts/graphrag/batch-epub-workflow.mjs:1372`
   `scripts/graphrag/batch-epub-workflow.mjs:2892`
   `scripts/graphrag/batch-epub-workflow.mjs:3595`
   `src/contracts/batch-run.ts:104`
   `src/contracts/batch-run.ts:243`

   原因：schema 已允许 `activeCommand`，但 repair checkpoint metadata 未写入该
   字段；非 running checkpoint 持久化时会清除 `currentCommand`；recovery summary
   又把 `activeCommand` 投影为 `item.currentCommand`。结果是本地 projection repair
   后的 checkpoint 和 recovery summary 没有可观测的 active command，未满足基准
   第 9 条。

   修复建议：在 repair metadata 中持久化 active command，或在 checkpoint 顶层写入
   `activeCommand`，并使 recovery summary 使用
   `item.activeCommand ?? item.currentCommand`。补充断言 reopened checkpoint 与
   recovery summary 均包含 active command 的测试。

## Criteria Review

1. PASS。`graph_extract`、`community_report`、`embed`、`query_ready` 的 artifact
   ownership 分离，producer stage mapping 明确。

2. PASS。`query_ready` 完成前验证 producer checkpoints、query artifacts、
   provider/stage fingerprint、corpus content hash 与 graph identity。

3. FAIL。已覆盖的 repair path 会 reopen 到 pending，但两个 observed failure text
   不会进入 repair path，无法保证 affected items 被 reopen。

4. PASS。repair 复用 `graph_extract`、`community_report`、`embed` producer run ids，
   不重跑高成本 producer。

5. PASS。已实现 repair 只改写本地 projection、producer manifest/checkpoint 投影、
   document identity、graph capability 或 managed settings projection。

6. PASS。缺失 document identity 与缺失 graph capability 的已知文本被分类为
   permanent local artifact gate，而不是 provider transient。

7. PASS。source/content hash、document id、book id、normalized path、producer
   lineage、provider/stage fingerprint 不匹配时 fail-closed。

8. PASS。repair 后的 batch item 仍要求 27 个固定 CLI command checks；repair
   不能直接写 batch `completed`。

9. FAIL。repair reason、projection、evidence locator、producer run ids 已投影；
   active command 未可靠写入 checkpoint 或 recovery summary。

10. FAIL。测试覆盖了前两个 observed query-ready failure text；未覆盖
    sidecar mismatch 和 settings projection failure text 的 persisted checkpoint
    reopen/repair 回归。

## Evidence

- `src/job-state/graphrag-book.ts:63` 定义各 stage 的 artifact requirement；
  `src/job-state/artifact-validation.ts:41` 约束 artifact kind 的 producer stage。
- `src/job-state/repository.ts:2472` 在 `query_ready` succeeded 前验证 producer
  stages、query artifacts 和 graph identity；`src/job-state/repository.ts:2590`
  只在 validated checkpoint 后发布 graph capability。
- `src/job-state/graphrag-book.ts:629` 至 `src/job-state/graphrag-book.ts:662`
  校验 sidecar 的 `bookId/sourceId/sourceHash/documentId/contentHash/normalizedPath`
  与非空 graph text units。
- `src/graphrag/settings-projection.ts:319` 至
  `src/graphrag/settings-projection.ts:363` 对 managed settings drift 做 atomic
  rewrite，并拒绝缺少 managed marker 的 user-owned settings。
- `scripts/graphrag/batch-failure-classifier.mjs:140` 至
  `scripts/graphrag/batch-failure-classifier.mjs:168` 未包含 sidecar mismatch 与
  settings projection failure text。
- 验证命令：
  `node --input-type=module ... batch-failure-classifier.mjs` 输出显示前两个文本
  `local=true`，sidecar/settings 两个文本 `local=false` 且 `failureKind=unknown`。
- 测试命令：
  `node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000
  test/graphrag-book-state.test.ts test/integrations/contracts.test.ts`
  结果为 2 个文件通过、97 个测试通过。
- 测试命令：
  `node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000
  test/cli.test.ts -t "query-ready projection|managed GraphRAG
  settings|settingsProjection|completed items"` 结果为 1 个文件通过、6 个测试通过、
  175 个测试跳过。

## Residual Risks

- 本审计只运行了目标子集测试，未运行完整 `npm test`。
- settings projection invalid source 与 user-owned rejection 共用
  `rejected_user_owned` metadata，后续应确认是否需要更精确的 typed reason。
- `activeCommand` 当前更像 schema 字段而非持久事实，修复时需要避免与
  `currentCommand` 的 running heartbeat 语义混淆。
