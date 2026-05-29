# Development Ultimate Reaudit Report

Verdict: pass

## Findings

未发现阻断缺陷（blocking findings）、高/中严重度真实缺陷、行为回归或
越界改动。

上一轮 stale `query_ready` fingerprint 可加载 capability 的失败路径已被关闭。
`src/graphrag/capability-catalog.ts:158` 到
`src/graphrag/capability-catalog.ts:176` 的 run-record candidate 不再用当前
book stage fingerprint 伪造历史 stage fingerprint，而是优先使用 run record
metadata 中的 `stageFingerprint`，否则使用 `inputFingerprint`。
`src/graphrag/capability-catalog.ts:220` 到
`src/graphrag/capability-catalog.ts:232` 随后要求 checkpoint candidate 匹配
当前 typed stage fingerprint、provider fingerprint、content hash、book scope
和 succeeded 状态；`query_ready` 缺 `runId` 仅在
`src/graphrag/capability-catalog.ts:275` 到
`src/graphrag/capability-catalog.ts:306` 的 query-ready checkpoint 选择中被
兼容，fingerprint/provider/content 约束未放宽。

## Criteria Coverage

1. Pass. 高成本 producer stage 不会仅因 artifact id 刷新而重跑。
   `src/job-state/repository.ts:2491` 到
   `src/job-state/repository.ts:2518` 按同一 book、stage、producer run 与
   required kind 从当前 artifact manifest 重新绑定 artifacts。
   capability/restore projection 也在
   `src/graphrag/capability-catalog.ts:235` 到
   `src/graphrag/capability-catalog.ts:270` 按 producerRunId 选择并验证当前
   producer artifacts。

2. Pass. Readiness 继续验证 producer lineage、required kind、stage
   fingerprint、provider fingerprint、corpus content hash、book scope 和文件
   完整性（file integrity）。核心校验集中在
   `src/job-state/artifact-validation.ts:477` 到
   `src/job-state/artifact-validation.ts:580`，其中包含 artifact id/book id、
   kind、book-scoped output、producerRunId、stage fingerprint、provider
   fingerprint、corpus hash 和物理文件校验。

3. Pass. Checkpoint artifact ids 可作为 stale references 处理，但只能在同一
   producer run 的当前 artifacts 满足完整校验后恢复。
   Repository resume 使用
   `src/job-state/repository.ts:2491` 到
   `src/job-state/repository.ts:2568`；capability/restore 使用
   `src/graphrag/capability-catalog.ts:378` 到
   `src/graphrag/capability-catalog.ts:469` 的统一 query-ready lineage
   projection。

4. Pass. 新的 failed/running checkpoint 不会遮蔽旧的可用 succeeded
   checkpoint。`src/job-state/repository.ts:2598` 到
   `src/job-state/repository.ts:2632` 在所有 candidates 中按 stage、status、
   input fingerprint 与 artifact validity 选择 usable succeeded checkpoint；
   `src/job-state/repository.ts:2635` 到
   `src/job-state/repository.ts:2700` 用该结果覆盖 current checkpoint 的
   effective state。对应回归覆盖在 `test/book-job-state.test.ts:2001`。

5. Pass. Query-ready readiness 仍要求 `graph_extract`、`community_report` 和
   `embed` producer run ids 及 validated artifacts。Repository gate 位于
   `src/job-state/repository.ts:1792` 到
   `src/job-state/repository.ts:1858`；capability/restore projection 在
   `src/graphrag/capability-catalog.ts:402` 到
   `src/graphrag/capability-catalog.ts:430` 必须先选出三个 producer
   checkpoints，再选出有效的 `query_ready` checkpoint。

6. Pass. Query-ready capability publishing 使用 validated producer lineage
   artifact ids，而非 stale checkpoint artifact ids。
   `src/job-state/repository.ts:1860` 到
   `src/job-state/repository.ts:1885` 从 effective artifact validity 与
   query-ready gate artifacts 构造 lineage ids；
   `src/job-state/repository.ts:2920` 到
   `src/job-state/repository.ts:2938` 发布 capability 时写入这些 lineage ids。
   加载路径在 `src/graphrag/capability-catalog.ts:567` 到
   `src/graphrag/capability-catalog.ts:629` 从同一 validated projection 派生
   capability artifact ids。

7. Pass. Partial 或 invalid artifacts 继续失败关闭（fail closed）。
   `src/job-state/artifact-validation.ts:510` 到
   `src/job-state/artifact-validation.ts:580` 对 missing、wrong-scope、
   wrong-kind、wrong-producer、wrong-fingerprint、wrong-provider、
   wrong-corpus、hash mismatch、empty/invalid parquet、invalid json 和缺失
   required kind 均返回 unsatisfied；所有恢复路径最终依赖该校验结果。

8. Pass. GraphRAG book isolation 未被削弱。Artifact selection 和 validation
   均要求 `artifact.bookId === bookId`，见
   `src/graphrag/capability-catalog.ts:97` 到
   `src/graphrag/capability-catalog.ts:108` 及
   `src/job-state/artifact-validation.ts:510` 到
   `src/job-state/artifact-validation.ts:524`。Book-scoped GraphRAG output
   路径约束位于 `src/job-state/artifact-validation.ts:583` 到
   `src/job-state/artifact-validation.ts:597`。

9. Pass. Resume plans 和 query-ready failures 仍可观测。
   `src/job-state/repository.ts:831` 到
   `src/job-state/repository.ts:843` 保留 `artifact_missing`、
   `missingArtifactIds`、`missingArtifactKinds` 与 `invalidArtifacts`；
   `src/job-state/repository.ts:881` 到
   `src/job-state/repository.ts:885` 继续用真实 `nextStage` 决定 `canQuery`。
   stale `query_ready` 回归在 `test/book-job-state.test.ts:2215` 到
   `test/book-job-state.test.ts:2370` 断言 `nextStage === "query_ready"`、
   `canQuery === false` 且 `loadGraphQueryCapabilities()` 返回空数组。

10. Pass. 变更范围保持在 stage lineage recovery、query-ready capability
    projection 与 restore projection。当前 diff 仅涉及
    `src/job-state/repository.ts`、`src/graphrag/capability-catalog.ts`、
    `src/vault/restore.ts` 和 `test/book-job-state.test.ts`；未发现 qmd
    search、GraphRAG query ranking、CLI output 或 rendering behavior 的
    无关重写。

## Residual Risks

- `src/job-state/repository.ts` 的 effective resume state 与
  `src/graphrag/capability-catalog.ts` 的 query-ready lineage projection 仍是
  两套实现。当前修复已让 restore 复用 capability projection，但 repository
  与 capability projection 后续仍有语义漂移风险。
- Run records 仍不是完整事实源（complete fact source）。Capability
  projection 的 run-record candidate 对 `stageFingerprint` 使用
  metadata/inputFingerprint；`providerFingerprint` 与 content hash 仍可从当前
  book state 兜底。最终安全边界由 artifact manifest 的 provider/stage/corpus
  校验承担，当前行为 fail closed，但历史 metadata 不完整会降低可解释性。
- 新增回归直接覆盖 `graph_extract` artifact-id recovery、newer running
  shadowing、recovered capability loading 和 stale `query_ready` fingerprint。
  `community_report` 与 `embed` 共享同一 projection 逻辑，但没有逐阶段专门的
  stale fingerprint 回归断言。
- 本轮执行了聚焦测试、restore targeted 测试、类型检查和 diff whitespace
  检查；未执行完整测试套件（full test suite）。

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts`
  with 49 tests passing.
- Passed: `npm run test:types`.
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/integrations/contracts.test.ts -t "restore"`
  with 8 tests passing and 62 tests skipped by filter.
- Passed: `git diff --check`.
