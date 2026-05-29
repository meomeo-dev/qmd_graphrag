# GraphRAG QMD Build Gate 开发审计结果

## 结论

审计结论：PASS WITH MINOR DOC FOLLOW-UP。

核心 completed gate 已按独立证据重算实现：`qmdBuildStatus` 来自当前书的
`qmd_build_manifest.json`，`commandCheckStatus` 来自 27 个 `commandChecks`，
`completed` 同时要求 qmd build、GraphRAG build、GraphRAG query 和 command
checks 成功。`--status-json` 与 `--migrate-only` 均会重新校验旧 completed
checkpoint，不信任旧 completed 计数。

未发现阻断 r5 gate 的实现缺陷。发现一个低风险文档改进项：命令附录中的“快速汇总”
脚本直接读取 checkpoint 快照，只统计 `qmdBuildStatus`、`graphBuildStatus` 和
`graphQueryStatus`，未展示 `commandCheckStatus`；runbook 和 schema 已覆盖该字段，
但建议附录同步展示，减少人工排障时漏看命令检查集合的概率。

## 审计约束

- 未读取、打印或总结 `.env` 密钥值。
- 未启动真实 EPUB 批处理。
- 未运行会调用外部 provider 的命令。
- 写入范围仅限 `audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-c/`。
- 执行的验证命令：
  - `node --check scripts/graphrag/batch-epub-workflow.mjs`
  - `node --check src/contracts/batch-run.ts`
  - `node --check test/cli.test.ts`

## 逐条结果

### 1. 独立证据优先（independent evidence first）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2530` 定义 qmd build manifest locator
  为 `books/${item.bookId}/qmd/qmd_build_manifest.json`。
- `scripts/graphrag/batch-epub-workflow.mjs:3345` 从该 locator 读取
  `QmdBuildManifestSchema`。
- `scripts/graphrag/batch-epub-workflow.mjs:3431` 至 `3519` 中
  `qmdBuildEvidence()` 重新校验 runId、itemId、bookId、source hash、
  normalized path、content hash、qmd index、config 和 command check fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:2241` 至 `2247` 中
  `withBuildStatusSnapshot()` 使用 `qmdBuildEvidence(item)` 覆盖快照。

风险说明：

旧 checkpoint 中伪造的 `qmdBuildStatus: succeeded` 不会单独使 item 保持
completed；manifest 缺失时返回 `qmd_build_manifest_missing`。

必要修复建议：无。

### 2. 命令检查独立（command checks separated）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:186` 至 `214` 定义固定 27 个
  `requiredCommandCheckNames`。
- `scripts/graphrag/batch-epub-workflow.mjs:3566` 至 `3599` 中
  `commandCheckSetEvidence()` 单独检查数量、唯一性、缺项、额外项和失败项。
- `scripts/graphrag/batch-epub-workflow.mjs:3938` 至 `3962` 在
  recovery summary 中分别投影 `qmdBuildStatus` 与 `commandCheckStatus`。
- `src/contracts/batch-run.ts:221` 至 `230` 的 `BatchRecoverySummaryItemSchema`
  包含 `qmdBuildStatus` 和可选 `commandCheckStatus`，两者是独立字段。

风险说明：

实现层没有把 27 个 CLI 子命令检查折叠进 `qmdBuildStatus`。`qmdBuildManifest`
记录 command check names 和 fingerprint，但 completed gate 仍单独要求
`commandCheckSetEvidence()` 成功。

必要修复建议：无。

### 3. Completed 严格闭环（strict completed gate）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3646` 至 `3657` 中
  `downgradeCompletedIfClosedLoopInvalid()` 仅在 command checks、qmd build、
  GraphRAG build 和 GraphRAG query 全部 succeeded 时保留 completed。
- `scripts/graphrag/batch-epub-workflow.mjs:3665` 至 `3716` 在任一证据失败时
  将 completed checkpoint 降为 pending，并记录 `item_completed_reopened`。
- `scripts/graphrag/batch-epub-workflow.mjs:4978` 至 `5048` 在正常 run item
  结束前重新计算 GraphRAG build、GraphRAG query 和 qmd build status，再写入
  completed。
- `docs/operations/graphrag-epub-resume-boost.md:236` 至 `241` 说明 completed
  必须同时满足 qmd build、GraphRAG build、GraphRAG query、27 command checks
  和 book-scoped producer lineage。
- `docs/operations/graphrag-epub-resume-boost.md:294` 至 `301` 列出最终 completed
  item 必须重新计算出的四个 succeeded 状态。

风险说明：

completed 判定具备多证据交叉检查，避免仅靠 manifest counter 或 checkpoint
status 完成。

必要修复建议：无。

### 4. 旧状态不可继承（legacy status is not authority）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2193` 至 `2229` 加载既有 checkpoint 后，
  `--migrate-only`、`--status-json` 和正式运行路径都会调用
  `downgradeCompletedIfClosedLoopInvalid()`。
- `scripts/graphrag/batch-epub-workflow.mjs:3888` 至 `3912` 中 manifest 计数从
  当前 checkpoint 状态重新计算；`completedItems` 不直接继承旧 manifest。
- `scripts/graphrag/batch-epub-workflow.mjs:5332` 至 `5339` 在 status-json 输出前
  先 update manifest；migrate-only 写 summary 后退出，不执行真实批处理。
- `test/cli.test.ts:8677` 至 `8810` 覆盖 `--migrate-only` 对缺少真实闭环证据的
  completed item 降级为 pending，并断言 manifest completedItems 变为 0。
- `docs/operations/graphrag-epub-batch-runbook.md:120` 至 `135` 明确旧
  completed checkpoint 必须重新校验，规则适用于 `--migrate-only`、
  `--status-json` 和正式运行。

风险说明：

status-json 是只读投影，降级不写回文件；这符合只读设计，但操作者必须理解 stdout
投影可能比磁盘 checkpoint 更新。文档已经说明该点。

必要修复建议：无。

### 5. GraphRAG 产物书级隔离（book-scoped artifacts）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2526` 至 `2528` 将 GraphRAG output
  locator 定义为 `books/${bookId}/output`。
- `scripts/graphrag/batch-epub-workflow.mjs:2911` 至 `2930` 按 `item.bookId`
  筛选 stage candidate artifacts。
- `scripts/graphrag/batch-epub-workflow.mjs:2994` 至 `2999` 要求 embed artifact
  为 `books/<bookId>/output/lancedb`，其他 artifact 必须在
  `books/<bookId>/output/` 下。
- `docs/operations/graphrag-epub-batch-runbook.md:258` 至 `269` 要求 producer
  manifest 保存在 book-scoped output，并禁止共享 `graph_vault/output` 发布
  graph capability。

风险说明：

book scope gate 能拒绝 host absolute path、共享 output 或跨书 artifact。

必要修复建议：无。

### 6. Producer lineage 对齐（producer lineage alignment）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2957` 至 `2971` 对非 query_ready
  stage 校验 artifact producer run，对 query_ready 校验 artifact producer run
  与 producer manifest 中的 stage producer run 对齐。
- `scripts/graphrag/batch-epub-workflow.mjs:2972` 至 `2991` 校验 stage
  fingerprint、provider fingerprint 和 corpus content hash。
- `scripts/graphrag/batch-epub-workflow.mjs:3024` 至 `3070` 校验 stage
  checkpoint 非 bootstrap、status succeeded、bookId 和 contentHash。
- `test/cli.test.ts:9907` 至 `10193` 覆盖 stale GraphRAG producer lineage；
  测试将 community_report artifact 的 producerRunId 改错，并断言 status-json
  投影为 pending/stale，reason 匹配
  `stage_artifact_producer_run_mismatch:community_report`，且只读模式不写回
  checkpoint 或 event log。
- `docs/operations/graphrag-epub-batch-runbook.md:139` 至 `158` 描述
  GraphRAG build succeeded 的必要 lineage 条件。

风险说明：

lineage 校验覆盖 producer run、fingerprint、provider 和 corpus identity，能防止
跨 run 或 stale artifact 被接受。

必要修复建议：无。

### 7. Provider auth 恢复有界且保留投影（bounded auth repair）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1031` 至 `1104` 中
  `providerAuthReopenDecision()` 仅对 failed、retryable=false、
  `stop_until_fixed` 且确认为 provider auth failure 的 checkpoint 计算 reopen；
  未 ready、fingerprint 未变、已重开或超过次数上限均 blocked。
- `scripts/graphrag/batch-epub-workflow.mjs:1106` 至 `1157` 的
  `providerAuthSummaryProjection()` 投影 decision、eligible、source、presence、
  readiness 和 fingerprint 字段。
- `scripts/graphrag/batch-epub-workflow.mjs:1188` 至 `1276` 的 reopen 写入
  pending、`continue_pending`、`normalCommandChecksRequired=true`，并清空
  command checks，确保不会直接完成。
- `test/cli.test.ts:6303` 至 `6528` 覆盖 legacy provider auth checkpoint 被重开并
  重跑闭环，断言最终 completed、27 个命令检查齐全、summary 不包含测试密钥值。
- `test/cli.test.ts:6530` 至 `6607` 覆盖 shell env shadow 时 status-json 不写回，
  且不泄露被遮蔽值。
- `test/cli.test.ts:6684` 至 `6740` 覆盖当前 provider readiness 覆盖 stale reopen
  metadata。
- `docs/operations/graphrag-epub-resume-boost.md:164` 至 `185` 描述 provider auth
  reopen 条件和重开后必须重新走正常闭环。
- `docs/operations/graphrag-epub-resume-boost.md:219` 至 `221` 说明状态、事件和
  summary 只保存 present/missing、source 和 redacted fingerprint，不保存 `.env`
  值。

风险说明：

provider auth 修复不会把永久失败直接改 completed，且通过 fingerprint 和 attempt
limit 控制重复重开。

必要修复建议：无。

### 8. 只读投影无副作用（read-only projection has no writes）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1702` 至 `1713` 中 status-json 只要求
  state root 存在并校验 log root 不在 graph_vault 内。
- `scripts/graphrag/batch-epub-workflow.mjs:1905` 至 `1921` 中
  `lockedReadWriteTypedJson()` 和 `writeTypedJson()` 在 status-json 时直接返回，
  不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:2225` 至 `2230` 中 status-json 加载
  checkpoint 后只 parse 带 snapshot 的对象，不写回。
- `scripts/graphrag/batch-epub-workflow.mjs:4069` 至 `4072` 的
  `printStatusAndExit()` 只向 stdout 输出 `buildRecoverySummary()`。
- `docs/operations/graphrag-epub-resume-boost.md:99` 至 `101` 明确
  `--status-json` 不执行 EPUB 规范化、GraphRAG、provider 或 qmd CLI，也不写
  manifest、checkpoint 或 event log。

风险说明：

status-json 会在内存中计算 provider auth readiness 和 completed 降级投影，但不会
持久化。该行为符合只读审计需求。

必要修复建议：无。

### 9. 文档与 schema 一致（docs and schema agree）

判定：PASS，附低风险改进建议。

证据：

- `src/contracts/batch-run.ts:221` 至 `230` 的 summary item schema 包含
  `qmdBuildStatus`、`commandCheckStatus`、`graphBuildStatus` 和
  `graphQueryStatus`。
- `docs/operations/graphrag-epub-batch-runbook.md:343` 至 `348` 明确
  `recovery-summary.json` 与 `--status-json` 受 `BatchRecoverySummarySchema` 约束，
  并记录 `commandCheckStatus`。
- `docs/operations/graphrag-epub-batch-runbook.md:440` 至 `443` 明确
  `qmdBuildStatus` 来自独立 qmd build manifest，`commandCheckStatus` 来自
  27 个 CLI 子命令检查。
- `docs/operations/graphrag-epub-resume-commands.md:5` 至 `20`、`24` 至 `39` 和
  `43` 至 `67` 均使用同一
  `--run-id epub-batch-20260527-real-resume-1`，并用 `env -u` 清理 shell provider
  环境变量。
- `docs/operations/graphrag-epub-resume-boost.md:142` 至 `154` 解释 `env -u` 与
  dotenv authority，未写密钥值。
- `docs/operations/graphrag-epub-resume-boost.md:273` 至 `280` 禁止手工 completed、
  误用旧 seed 和写入密钥。

风险说明：

主 runbook 和 schema 一致，且不再声称 `qmdBuildStatus` 等于 27 command checks。
低风险缺口是 `docs/operations/graphrag-epub-resume-commands.md:89` 至 `103` 的
“快速汇总”脚本直接读取 checkpoint 快照，只统计 `qmdBuildStatus`、
`graphBuildStatus`、`graphQueryStatus`，未统计 `commandCheckStatus`。由于
checkpoint schema 不持久化 `commandCheckStatus`，该脚本若继续读 raw checkpoint，
应自行从 `commandChecks` 计算；或者改为读取 `--status-json`/`recovery-summary.json`
输出中的 `commandCheckStatus`。

必要修复建议：

- 非阻断建议：在命令附录的快速汇总中加入 27 个 command check 完整性统计，或改为
  汇总 `recovery-summary.json` 的 `items[].commandCheckStatus.status`。

### 10. 回归测试覆盖失败模式（regression coverage for gate failures）

判定：PASS。

证据：

- qmd manifest 缺失 / migrate-only reopen：
  `test/cli.test.ts:8677` 至 `8810` 覆盖缺少真实 closed-loop evidence 的
  completed item 被 `--migrate-only` 重开，断言 `qmd_build_manifest_missing`。
- GraphRAG query failed：
  `test/cli.test.ts:9247` 至 `9539` 覆盖 `qmd-query-graphrag-json` failed，
  status-json 将 completed 投影为 pending，并给出
  `graph_query_command_check_failed`。
- command check incomplete：
  `test/cli.test.ts:9541` 至 `9818` 覆盖缺少 `qmd-cleanup` 的 command check set，
  status-json 投影 `commandCheckStatus.reason=command_check_missing`。
- stale producer lineage：
  `test/cli.test.ts:9907` 至 `10193` 覆盖 producer run mismatch。
- provider auth repair：
  `test/cli.test.ts:6303` 至 `6528` 覆盖 legacy provider auth 重开并重跑闭环；
  `test/cli.test.ts:6530` 至 `6607` 和 `6684` 至 `6740` 覆盖 blocked/stale
  provider auth 投影。
- valid portable book-scoped evidence：
  `test/cli.test.ts:8929` 至 `9244` 覆盖 book-scoped GraphRAG producer evidence
  被接受，并验证 artifact 内容损坏时 GraphRAG build 投影 stale。

风险说明：

覆盖项与本轮必须重点检查的失败模式一致。由于本审计受“只允许写入审计目录”约束，
未运行会写 `.tmp-tests` 的 vitest 命令；已执行三项 `node --check` 语法验证，且
用户背景说明本地关键 vitest 已通过。

必要修复建议：无。

## 最终建议

1. 接受当前 r5 build gate 修复进入后续集成验证。
2. 后续小改动：更新 `docs/operations/graphrag-epub-resume-commands.md` 的“快速汇总”
   脚本，使其展示 `commandCheckStatus` 或 27 个 `commandChecks` 的完整性统计。
3. 后续真实续跑仍应按文档使用同一 runId，并先运行 `--status-json` 观察 runner
   ownership、provider auth readiness、`nextRetryAt` 和四类闭环状态。
