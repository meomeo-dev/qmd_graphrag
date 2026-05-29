# Dev Agent C 只读开发审计报告

总体结论：DEV FAIL。

审计依据为固定基准（baseline）10 条：
`audit/graphrag-query-ready-identity-run_1__closed/dev-agent-c/baseline.md:6`
至 `:23`。本报告未新增或替换基准。

审计重点（audit focus）：

- 是否越界改动 CLI 输出、查询路由、provider 配置或 GraphRAG vendor。
- 是否在已有有效 GraphRAG output 时避免重跑高成本 stage。
- 是否把 generated runtime outputs、`.tmp-tests`、`graph_vault` 或
  `inbox` 内容纳入提交。

## 本审计验证

- `npm run test:types`：PASS。
- `node ./node_modules/vitest/vitest.mjs run test/book-job-state.test.ts
  --testTimeout 120000 --reporter=dot`：PASS，45 tests passed。
- `node ./node_modules/vitest/vitest.mjs run
  test/graphrag-book-state.test.ts --testTimeout 120000 --reporter=dot`：
  PASS，23 tests passed。
- `node ./node_modules/vitest/vitest.mjs run test/unified-query.test.ts
  test/cli-graphrag-route.test.ts test/integrations/graphrag-cost.test.ts
  --testTimeout 120000 --reporter=dot`：PASS，47 tests passed。
- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts
  --testTimeout 120000 --reporter=dot`：PASS，173 tests passed。
- `.venv-graphrag/bin/python test/python/test_graphrag_bridge_scope.py`：
  PASS，25 tests passed。
- 实施摘要中的组合 focused state 命令
  `test/graphrag-book-state.test.ts test/book-job-state.test.ts` 在本审计中
  两次超时，外层超时分别为 180 秒与 420 秒；拆分运行同两个文件通过。
- 复跑测试生成的 `.tmp-tests` 临时目录已清理。最终状态未显示
  `.tmp-tests`、`graph_vault` 或 `inbox` 未跟踪运行产物。

## 基准审计结果

1. Runtime code changes must be limited to the approved modules:
   `src/job-state/repository.ts` and `src/job-state/graphrag-book.ts`.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/implementation-summary.md:5`
  至 `:13` 声明运行代码仅为两个批准模块，测试仅为两个相关测试文件。
- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:63` 至 `:67`
  记录 implementation changed files 仅包含两个运行代码文件和两个测试文件。
- `src/job-state/repository.ts:1083` 至 `:1145` 为同书 identity map
  非破坏性 upsert（non-destructive upsert）实现。
- `src/job-state/graphrag-book.ts:621` 至 `:862` 为 sidecar repair 和
  GraphRAG text unit identity 回写实现。

剩余缺口：无。

2. Tests must be limited to relevant state and GraphRAG book sync regressions.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/implementation-summary.md:10`
  至 `:13` 声明测试范围为 `test/book-job-state.test.ts` 和
  `test/graphrag-book-state.test.ts`。
- `test/book-job-state.test.ts:652` 至 `:721` 覆盖重复注册同一本书时保留
  chunk、qmd corpus registration metadata 和 graph identity。
- `test/graphrag-book-state.test.ts:778` 至 `:870` 覆盖从已验证 sidecar
  修复缺失 catalog graph identity。
- `test/graphrag-book-state.test.ts:876` 至 `:966` 覆盖 stale sidecar
  fail-closed 负例。

剩余缺口：无。

3. The implementation must not change CLI output format logic, query routing,
   provider configuration, or GraphRAG vendor code.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:63` 至 `:67`
  的 implementation changed files 不包含 CLI、query、provider、vendor 或
  GraphRAG vendor 路径。
- `docs/architecture/unified-retrieval-plane.md:797` 至 `:810` 保持
  CLI/MCP typed route contract 和 GraphRAG vendor 不承载业务路由逻辑的边界。
- `docs/operations/graphrag-epub-batch-runbook.md:240` 至 `:242`
  规定 migrate-only 不执行 EPUB、GraphRAG stage、provider 或 qmd CLI 子命令。

剩余缺口：无。

4. The implementation must not rerun high-cost GraphRAG stages during local
   identity projection repair when valid outputs already exist.

状态：PASS。

证据：

- `src/job-state/graphrag-book.ts:1683` 至 `:1689` 在 query-ready artifact
  存在时先记录 GraphRAG text unit identity。
- `src/job-state/graphrag-book.ts:1691` 至 `:1699` 调用
  `bootstrapRecoveredStages` 时传入 `highCostStages: false`。
- `src/job-state/graphrag-book.ts:1303` 至 `:1331` 显示 high-cost stage
  completion 仅在 `input.highCostStages` 为 true 时处理。
- `docs/operations/graphrag-epub-batch-runbook.md:198` 至 `:201`
  规定 local projection repair 只补 catalog projection 并重试 `query_ready`，
  不得重跑 `graph_extract`、`community_report` 或 `embed`。

剩余缺口：真实 EPUB resume 未见已重跑记录，归入基准 10。

5. Producer manifest, producer run ids, stage fingerprints, provider
   fingerprints, and corpus content hash gates must remain intact.

状态：PASS。

证据：

- `src/job-state/graphrag-book.ts:1171` 至 `:1192` 校验 output manifest 的
  `bookId`、`sourceHash`、`documentId`、`contentHash`、provider fingerprint、
  output locator 和 stage fingerprints。
- `src/job-state/graphrag-book.ts:1195` 至 `:1228` 写入 portable producer
  manifest，并保留 stage-scoped `stageProducerRunIds`。
- `src/job-state/graphrag-book.ts:1388` 至 `:1444` 对
  `graph_extract`、`community_report` 和 `embed` producer artifacts 做
  producer run id、stage fingerprint、provider fingerprint 和 corpus content
  hash gate 校验。
- `src/job-state/repository.ts:1674` 至 `:1724` 在 repository 层验证
  query-ready producer checkpoints 与 artifact evidence。

剩余缺口：无。

6. `query_ready` capability publication must still depend on validated producer
   artifacts, qmd corpus registration, and graph identity.

状态：PASS。

证据：

- `src/job-state/repository.ts:2373` 至 `:2405` 在 `query_ready` succeeded
  checkpoint 前验证 producer stages、query artifacts 和 graph identity。
- `src/job-state/repository.ts:2456` 至 `:2457` 仅在 `query_ready`
  succeeded 后发布 graph capabilities。
- `src/job-state/repository.ts:2565` 至 `:2598` 要求
  `qmdCorpusRegistered=true`、非空 `graphDocumentId` 和非空
  `graphTextUnitIds`。
- `docs/architecture/unified-retrieval-plane.md:341` 至 `:347` 规定
  `query_ready` 依赖 producer checkpoint、artifact evidence、qmd corpus
  registration 和 graph identity。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1729` 至 `:1741`
  规定 commit rule、qmd corpus registration gate 和 graph identity gate。

剩余缺口：无。

7. The code must not add new dependencies or external services.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:63` 至 `:67`
  的 implementation changed files 不包含 `package.json`、lockfile 或外部服务配置。
- `package.json:70` 至 `:96` 为既有 dependencies、optionalDependencies 和
  devDependencies 块；本审计未发现该依赖块或 lockfile diff。

剩余缺口：无。

8. Generated runtime outputs, `.tmp-tests`, `graph_vault`, and inbox contents
   must not be staged for commit.

状态：PASS。

证据：

- `docs/architecture/unified-retrieval-plane.md:820` 至 `:829` 定义源码提交
  边界并禁止提交 `graph_vault`、`.qmd/*.sqlite*`、`inbox`、tmp 和日志。
- `docs/operations/graphrag-epub-batch-runbook.md:379` 至 `:387` 定义
  generated runtime outputs 不得提交。
- 本审计执行 `git diff --cached --name-status` 结果为空，未发现已 staged 文件。
- 本审计最终 `git status --short --untracked-files=all` 未显示 `.tmp-tests`、
  `graph_vault` 或 `inbox` 运行产物。

剩余缺口：无。后续复跑测试若再次生成 `.tmp-tests`，提交前仍需清理。

9. Type checking, focused GraphRAG state tests, CLI tests, and Python bridge
   scope tests must pass.

状态：UNCLEAR。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/implementation-summary.md:29`
  至 `:35` 记录实施者声称已运行的验证命令。
- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:72` 至 `:77`
  记录同一组 verification 命令。
- 本审计复跑 type checking、两个 state 测试文件的拆分命令、CLI 相关测试、
  `test/cli.test.ts` 和 Python bridge scope tests 均通过。
- 本审计复跑实施摘要中的组合 focused state 命令两次超时，未能复现该组合命令
  的 PASS 状态。

剩余缺口：需要调查或重跑组合 focused state 命令
`test/graphrag-book-state.test.ts test/book-job-state.test.ts` 的超时原因，并记录
稳定通过结果或改用明确的拆分验证策略。

10. Remaining risks must be documented if true real EPUB resume has not yet
    been rerun after the patch.

状态：FAIL。

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:5` 至 `:12`
  固定真实失败 run、book、item、failed stage 和错误。
- `audit/graphrag-query-ready-identity-run_1__closed/implementation-summary.md:29`
  至 `:35` 只记录 type、state、CLI 和 Python bridge 验证，未记录真实 EPUB
  resume 已重跑。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1928` 至 `:1936`
  把真实失败书回归验收定义为应证明从既有 sidecar 修复 catalog graph
  identity，并保持高成本 producer run ids 不变。
- `docs/operations/graphrag-epub-batch-runbook.md:198` 至 `:204`
  定义该类失败的 safe resume 规则和 fail-closed 负例。

剩余缺口：未见 post-patch true real EPUB resume 的执行记录，也未见明确的
remaining risk（剩余风险）说明。需要二选一补齐：执行真实失败书 resume 并记录
producer run id 不变；或明确记录真实 EPUB resume 尚未重跑、风险影响和后续验收
条件。

## 结论

实现未发现越界改动 CLI、query routing、provider 配置、GraphRAG vendor 或依赖。
核心代码路径满足低成本 identity projection repair、sidecar fail-closed、
producer lineage gate、qmd corpus registration gate 和 graph identity gate。

DEV FAIL 的原因是验证闭环未完全满足固定基准：组合 focused state 验证命令未在
本审计中复现通过，且真实 EPUB resume 尚未见已重跑或剩余风险记录。
