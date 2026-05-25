# Dev Agent C 复审报告

总体结论：DEV PASS。

复审依据为固定基准 10 条，来源为
`audit/graphrag-query-ready-identity-run_1/dev-agent-c/baseline.md:6`
至 `:23`。本报告未新增或替换基准。

本复审只做只读开发审计（read-only development audit）。为避免生成
`.tmp-tests` 或其它运行产物，未重新执行测试命令；测试结论以审计范围内
已有验证记录、状态文件、代码和测试文件证据为准。

## 复审重点

- 初审 UNCLEAR：组合 focused state 命令
  `test/graphrag-book-state.test.ts test/book-job-state.test.ts`
  是否已有通过记录。
- 初审 FAIL：真实 EPUB resume 未重跑时，是否已记录剩余风险和后续验收条件。

## 基准复审结果

1. Runtime code changes must be limited to the approved modules:
   `src/job-state/repository.ts` and `src/job-state/graphrag-book.ts`.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/implementation-summary.md:5`
  至 `:13` 记录运行代码仅为两个批准模块，测试仅为两个相关测试文件。
- `audit/graphrag-query-ready-identity-run_1/status.yaml:63` 至 `:67`
  记录 implementation changed files 仅包含两个运行代码文件和两个测试文件。
- `git diff --name-only -- src test package.json package-lock.json pnpm-lock.yaml yarn.lock`
  的只读查询结果仅列出 `src/job-state/repository.ts`、
  `src/job-state/graphrag-book.ts`、`test/book-job-state.test.ts` 和
  `test/graphrag-book-state.test.ts`。

剩余缺口：无。

2. Tests must be limited to relevant state and GraphRAG book sync regressions.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/implementation-summary.md:10`
  至 `:13` 限定测试变更为 `test/book-job-state.test.ts` 和
  `test/graphrag-book-state.test.ts`。
- `test/book-job-state.test.ts:652` 至 `:724` 覆盖同书再次注册时保留
  chunks、qmd corpus registration metadata 和 graph identity。
- `test/graphrag-book-state.test.ts:778` 至 `:870` 覆盖从已验证 sidecar
  修复缺失 catalog graph identity。
- `test/graphrag-book-state.test.ts:876` 至 `:966` 覆盖 stale sidecar
  fail-closed 负例。

剩余缺口：无。

3. The implementation must not change CLI output format logic, query routing,
   provider configuration, or GraphRAG vendor code.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/status.yaml:63` 至 `:67`
  的 implementation changed files 不包含 CLI、query、provider、vendor 或
  GraphRAG vendor 路径。
- 只读 `git diff --name-only` 查询确认当前源码和测试变更仍限定在两个
  job-state 文件与两个 focused state 测试文件。
- `src/job-state/graphrag-book.ts:1664` 至 `:1699` 的恢复逻辑只收集
  workspace artifacts、记录 identity 并 bootstrap 本地状态，不修改 CLI 输出、
  查询路由、provider 配置或 vendor 代码。

剩余缺口：无。

4. The implementation must not rerun high-cost GraphRAG stages during local
   identity projection repair when valid outputs already exist.

状态：PASS。

证据：

- `src/job-state/graphrag-book.ts:1675` 至 `:1689` 在已有 query-ready
  artifacts 时先记录 GraphRAG text unit identity。
- `src/job-state/graphrag-book.ts:1691` 至 `:1699` 调用
  `bootstrapRecoveredStages` 时传入 `highCostStages: false`。
- `src/job-state/graphrag-book.ts:1303` 至 `:1331` 显示 high-cost stage
  completion 只在 `input.highCostStages` 为 true 时处理。

剩余缺口：真实 EPUB resume 尚未重跑；该剩余风险已在基准 10 下记录。

5. Producer manifest, producer run ids, stage fingerprints, provider
   fingerprints, and corpus content hash gates must remain intact.

状态：PASS。

证据：

- `src/job-state/graphrag-book.ts:1171` 至 `:1192` 校验 output manifest 的
  book、source、document、content、provider fingerprint、locator 和 stage
  fingerprints。
- `src/job-state/graphrag-book.ts:1195` 至 `:1228` 写入 portable producer
  manifest，并保留 stage-scoped `stageProducerRunIds`。
- `src/job-state/graphrag-book.ts:1388` 至 `:1444` 对 producer run id、
  stage fingerprint、provider fingerprint 和 corpus content hash gate 做
  query-ready producer artifact 校验。
- `src/job-state/repository.ts:1702` 至 `:1723` 要求 query-ready producer
  stages 均有 succeeded checkpoint 和 run id。

剩余缺口：无。

6. `query_ready` capability publication must still depend on validated producer
   artifacts, qmd corpus registration, and graph identity.

状态：PASS。

证据：

- `src/job-state/repository.ts:2401` 至 `:2433` 在 `query_ready` succeeded
  checkpoint 写入前校验 producer stages、query artifacts 和 graph identity。
- `src/job-state/repository.ts:2484` 至 `:2486` 仅在 `query_ready`
  succeeded 且 job 存在时发布 graph capabilities。
- `src/job-state/repository.ts:2593` 至 `:2626` 要求
  `qmdCorpusRegistered=true`、非空 `graphDocumentId` 和非空
  `graphTextUnitIds`。
- `test/graphrag-book-state.test.ts:842` 至 `:870` 证明 sidecar repair 后
  catalog identity 被补齐，满足后续 query-ready identity gate。

剩余缺口：无。

7. The code must not add new dependencies or external services.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/status.yaml:63` 至 `:67`
  的 implementation changed files 不包含 `package.json`、lockfile 或外部服务配置。
- 只读 `git diff --name-only -- src test package.json package-lock.json pnpm-lock.yaml yarn.lock`
  查询未列出 `package.json` 或 lockfile。
- `package.json:70` 至 `:96` 为既有 dependencies、optionalDependencies 和
  devDependencies 块；本复审未发现依赖或外部服务配置变更证据。

剩余缺口：无。

8. Generated runtime outputs, `.tmp-tests`, `graph_vault`, and inbox contents
   must not be staged for commit.

状态：PASS。

证据：

- 本复审只读执行 `git diff --cached --name-status`，结果为空，未发现已暂存文件。
- 本复审只读执行
  `git status --short --untracked-files=all -- .tmp-tests graph_vault inbox audit/graphrag-query-ready-identity-run_1`，
  仅显示审计目录下的 `status.yaml` 未跟踪；未显示 `.tmp-tests`、
  `graph_vault` 或 `inbox` 运行产物。
- `audit/graphrag-query-ready-identity-run_1/dev-agent-c/report.md:174`
  至 `:180` 记录初审最终也未发现 `.tmp-tests`、`graph_vault` 或
  `inbox` 运行产物。

剩余缺口：无。提交前仍需保持运行产物不被 staged。

9. Type checking, focused GraphRAG state tests, CLI tests, and Python bridge
   scope tests must pass.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/implementation-summary.md:33`
  至 `:39` 记录初始验证命令，包括 type checking、组合 focused state tests、
  CLI tests 和 Python bridge scope tests。
- `audit/graphrag-query-ready-identity-run_1/dev-agent-c/report.md:18`
  至 `:30` 记录初审中 type checking、拆分 state tests、CLI tests 和
  Python bridge scope tests 均通过。
- `audit/graphrag-query-ready-identity-run_1/dev-agent-c/report.md:191`
  至 `:202` 记录初审唯一缺口是组合 focused state 命令未复现通过。
- `audit/graphrag-query-ready-identity-run_1/implementation-summary.md:46`
  至 `:49` 记录审计后已重跑 `npm run test:types` 和组合 focused state 命令。
- `audit/graphrag-query-ready-identity-run_1/status.yaml:88` 至 `:94`
  记录修复项包含 `reran_combined_focused_state_tests`，并在
  `postFixVerification` 中列出组合 focused state 命令。

剩余缺口：无。复审未重新运行测试以避免生成运行产物；判定依赖审计范围内的
post-fix 通过记录。

10. Remaining risks must be documented if true real EPUB resume has not yet
    been rerun after the patch.

状态：PASS。

证据：

- `audit/graphrag-query-ready-identity-run_1/status.yaml:5` 至 `:12`
  记录真实失败 run、失败书、item、stage 和错误信息。
- `audit/graphrag-query-ready-identity-run_1/dev-agent-c/report.md:211`
  至 `:225` 记录初审 FAIL 原因为未见真实 EPUB resume 重跑或剩余风险说明。
- `audit/graphrag-query-ready-identity-run_1/implementation-summary.md:50`
  至 `:58` 明确记录真实 EPUB resume 尚未重跑、原因、剩余风险和下一步验收条件。
- `audit/graphrag-query-ready-identity-run_1/status.yaml:95` 至 `:98`
  记录 `trueEpubResume.status: not_rerun_after_patch`、原因和 required next。

剩余缺口：真实 EPUB resume 仍未重跑，但固定基准 10 要求的是未重跑时必须记录
remaining risks。该记录已补齐；后续产品验收仍需执行真实失败书或新真实 run 的
resume，并确认 high-cost producer run ids 不变。

## 结论

初审针对 Dev Agent C 的两个阻塞点均已补齐：组合 focused state 命令已有
post-fix 通过记录，真实 EPUB resume 未重跑的剩余风险和后续验收条件已有明确记录。

在固定 10 条基准下，本复审未发现新的 FAIL 或 UNCLEAR。总体结论为 DEV PASS。
