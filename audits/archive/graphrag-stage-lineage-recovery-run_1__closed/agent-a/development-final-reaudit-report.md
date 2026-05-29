# Development Final Reaudit Report

Verdict: pass

## Findings

未发现阻断缺陷（blocking findings）。

上一轮指出的 capability loading / vault restore 只读取 current checkpoints
而忽略 run records 的缺陷已被当前 diff 修复。`projectQueryReadyLineage`
现在统一从 current checkpoints 与 run records 构建 query-ready lineage
投影，并在 capability loading 与 restore 两条消费路径复用该投影。

## Criteria Coverage

1. Pass. 高成本 producer stage 不会仅因 artifact id 刷新而被重跑。
   `src/job-state/repository.ts:2491` 继续按同一 book、stage、producer run
   和 required kind 从当前 artifact manifest 重新绑定 artifacts。
   `src/graphrag/capability-catalog.ts:97` 在 capability/restore 投影路径也
   按 producerRunId 重新选择 producer artifacts。

2. Pass. Readiness 仍按 producer lineage、required kind、stage fingerprint、
   provider fingerprint、corpus content hash、book scope 和文件完整性
   （file integrity）闭环验证。Repository 路径在
   `src/job-state/repository.ts:2538` 调用 `validateBookArtifactSet`；
   capability/restore 投影路径在
   `src/graphrag/capability-catalog.ts:248`、
   `src/graphrag/capability-catalog.ts:280` 和
   `src/graphrag/capability-catalog.ts:440` 执行同类验证。

3. Pass. Checkpoint artifact ids 可作为 stale references 处理，但只有同一
   producer run 的当前 artifacts 通过完整验证后才可恢复。
   `src/job-state/repository.ts:2491` 覆盖 repository resume；
   `src/graphrag/capability-catalog.ts:369` 的 `projectQueryReadyLineage`
   覆盖 capability loading 与 restore projection。

4. Pass. 新的 failed/running checkpoint 不会遮蔽旧的可用 succeeded
   checkpoint。Repository 通过 run records 构建 effective state；
   capability/restore 现在也在 `src/graphrag/capability-catalog.ts:170` 到
   `src/graphrag/capability-catalog.ts:208` 读取 run catalog 与 run records，
   并在 `src/graphrag/capability-catalog.ts:226` 到
   `src/graphrag/capability-catalog.ts:264` 选择通过验证的 producer
   checkpoint。复现场景中 current `graph_extract` checkpoint 为 `running`
   时，`loadGraphQueryCapabilities()` 仍返回 query capability。

5. Pass. Query-ready 仍要求 `graph_extract`、`community_report`、`embed`
   三个 producer run ids 和 validated artifacts。
   `src/job-state/repository.ts:1792` 到 `src/job-state/repository.ts:1858`
   保持 repository gate；`src/graphrag/capability-catalog.ts:393` 到
   `src/graphrag/capability-catalog.ts:421` 在 projection 中要求三类
   producer checkpoint 与 query-ready checkpoint 均可验证。

6. Pass. Query-ready capability publishing 和 subsequent loading 均使用
   validated producer lineage artifact ids，而不是 stale checkpoint artifact
   ids。Repository 发布路径在 `src/job-state/repository.ts:2925` 使用
   `queryReadyLineageArtifactIds`；capability loader 在
   `src/graphrag/capability-catalog.ts:473` 到
   `src/graphrag/capability-catalog.ts:477` 从统一投影取 lineage ids，并在
   `src/graphrag/capability-catalog.ts:530` 到
   `src/graphrag/capability-catalog.ts:537` 用投影结果替换 capability
   artifact ids。

7. Pass. Partial 或 invalid artifacts 仍 fail closed。所有恢复路径最终都
   依赖 `validateBookArtifactSet`，所以 missing、empty、wrong-scope、
   wrong-hash、wrong-fingerprint、wrong-provider、wrong-corpus 和
   wrong-producer artifacts 不会被标记为 ready。

8. Pass. GraphRAG book isolation 未被削弱。Artifact rebinding 继续要求
   `artifact.bookId === bookId`，并在 validator 中要求 book-scoped GraphRAG
   output。Shared output 与跨 book artifacts 仍不可用。

9. Pass. Resume plans 和 query-ready failures 仍保持可观测。Repository
   resume plan 继续报告 `nextStage`、`artifact_missing`、
   `missingArtifactIds`、`missingArtifactKinds` 和 `invalidArtifacts`。
   上轮 silently missing capability 的问题已通过统一投影修复；当前复现中
   loader 返回 capability 而不是空列表。

10. Pass. 变更范围保持在 stage lineage / query-ready recovery /
    capability projection / restore projection 内。未发现对 qmd search、
    GraphRAG query ranking、CLI output 或 rendering behavior 的无关重写。

## Residual Risks

- `projectQueryReadyLineage` 与 repository 的 effective resume state 仍是
  两套实现。当前逻辑已经覆盖 run-record fallback、producerRunId rebinding
  和 artifact validation，但长期维护中仍有语义漂移风险；后续可考虑抽出
  共享 lineage projection 模块。
- 直接新增测试主要覆盖 `graph_extract` stale artifact-id recovery 和 newer
  running shadowing。`community_report` 与 `embed` 使用同一 projection 逻辑，
  但没有逐阶段专门断言。
- Run records 不独立保存 stage/provider/content hash 字段；projection 从
  current book state 构造这些候选字段，并以 artifact manifest 的
  fingerprint/provider/corpus/hash 验证作为最终安全边界。该设计 fail
  closed，但历史 run record 本身不是完整事实源。
- Restore 复用 `projectQueryReadyLineage` 后覆盖了 query-ready lineage
  projection；但 restore 的 explicit capability audit 仍会严格报告原始
  malformed capability catalog entries，这是既有审计语义，不是本 case 的
  阻断缺陷。

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts`
  with 48 tests passing.
- Passed: `npm run test:types`.
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/integrations/contracts.test.ts -t "restore"`
  with 8 restore-related tests passing and 62 skipped by filter.
- Reproduced the prior failure scenario against current source with
  `./node_modules/.bin/tsx -`: after query-ready completion, starting a newer
  `graph_extract` run leaves current `checkpoints.yaml` with
  `graph_extract: running`, but `loadGraphQueryCapabilities()` now returns
  `capabilityCount: 1` with 9 lineage artifacts.
