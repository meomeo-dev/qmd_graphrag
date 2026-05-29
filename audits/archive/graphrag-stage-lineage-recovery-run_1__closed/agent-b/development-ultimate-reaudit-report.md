# Development Ultimate Reaudit Report

Verdict: pass

## Findings

无阻断发现（no blocking findings）。

上一轮 `stale query_ready fingerprint` 高风险已关闭。能力加载路径现在从
current checkpoints 与 run records 投影 query-ready lineage 时，不再用当前
book 的 `stageFingerprints` 伪造 run record 的历史 stage fingerprint，而是使用
`metadata.stageFingerprint` 或 `inputFingerprint`
（`src/graphrag/capability-catalog.ts:146`,
`src/graphrag/capability-catalog.ts:158`）。随后
`checkpointMatchesBook` 要求候选 checkpoint 的 `stageFingerprint` 匹配当前
book 的 typed stage fingerprint
（`src/graphrag/capability-catalog.ts:220`），`selectQueryReadyCheckpoint`
允许 `query_ready` 缺少 `runId`，但仍必须通过当前 `query_ready`
fingerprint、provider、content hash 与 artifact validation
（`src/graphrag/capability-catalog.ts:275`）。

新增回归测试覆盖了旧 `query_ready` fingerprint 在重新注册为新
`query_ready` fingerprint 后的阻断行为：`getResumePlan` 返回
`nextStage === "query_ready"`、`canQuery === false`，且
`loadGraphQueryCapabilities` 返回空数组
（`test/book-job-state.test.ts:2215`）。

## Criteria Coverage

1. Pass. 高成本 producer stage 仍可从同一 producer run 的当前 manifest
   artifacts 恢复，不依赖 stale checkpoint artifact ids
   （`src/job-state/repository.ts:2491`,
   `src/graphrag/capability-catalog.ts:97`）。
2. Pass. readiness 仍通过 producer lineage、required kind、stage
   fingerprint、provider fingerprint、corpus content hash、book scope 与文件
   完整性验证。核心约束仍由 `validateBookArtifactSet` 执行
   （`src/job-state/artifact-validation.ts:477`）。
3. Pass. checkpoint artifact ids 可作为 stale references 处理；当当前
   artifacts 对同一 stage 与 producer run 满足全部校验时才恢复 ready
   （`src/job-state/repository.ts:2511`,
   `src/graphrag/capability-catalog.ts:97`）。
4. Pass. 新的 failed/running checkpoint 不会遮蔽旧的可用 succeeded
   checkpoint。候选选择只接受 succeeded 且 fingerprint 匹配的 checkpoint，并
   在 newer invalid candidate 后继续寻找可用成功记录
   （`src/job-state/repository.ts:2598`,
   `src/graphrag/capability-catalog.ts:235`）。相关回归覆盖 resume plan 与
   capability loading（`test/book-job-state.test.ts:2001`,
   `test/book-job-state.test.ts:2082`）。
5. Pass. query-ready readiness 仍要求 `graph_extract`、`community_report`
   与 `embed` 的 producer run ids 和 artifacts 均通过验证后，才返回
   lineage projection（`src/graphrag/capability-catalog.ts:402`,
   `src/graphrag/capability-catalog.ts:423`,
   `src/graphrag/capability-catalog.ts:449`）。
6. Pass. capability publishing/loading 使用经过验证的 producer lineage
   artifact ids，而非 stale checkpoint artifact ids
   （`src/job-state/repository.ts:1860`,
   `src/job-state/repository.ts:2920`,
   `src/graphrag/capability-catalog.ts:482`,
   `src/graphrag/capability-catalog.ts:506`）。
7. Pass. partial 或 invalid artifacts 继续 fail closed。错误 book scope、
   producer run、stage fingerprint、provider fingerprint、corpus hash、missing
   file、空 Parquet/LanceDB/JSON 或 content hash mismatch 都会阻断 ready
   （`src/job-state/artifact-validation.ts:398`,
   `src/job-state/artifact-validation.ts:510`,
   `src/job-state/artifact-validation.ts:527`,
   `src/job-state/artifact-validation.ts:535`,
   `src/job-state/artifact-validation.ts:543`,
   `src/job-state/artifact-validation.ts:550`,
   `src/job-state/artifact-validation.ts:573`）。
8. Pass. GraphRAG book isolation 未被削弱。projection 与 artifact validation
   仍要求 `bookId` 匹配和 book-scoped graph output
   （`src/job-state/artifact-validation.ts:510`,
   `src/job-state/artifact-validation.ts:520`,
   `src/job-state/artifact-validation.ts:583`,
   `src/graphrag/capability-catalog.ts:220`）。
9. Pass. resume plan 保留真实 next stage 与 artifact failure evidence。
   新增 stale `query_ready` 测试确认 blocked 时 `canQuery=false` 且
   `nextStage=query_ready`（`test/book-job-state.test.ts:2341`）。repository
   仍在 stage validity 中保留 missing ids、missing kinds 与 invalid artifact
   evidence（`src/job-state/repository.ts:2521`,
   `src/job-state/repository.ts:2690`）。
10. Pass. diff 范围仍限于 stage lineage recovery、capability projection、
    restore 复用 projection 与回归测试；未发现 qmd search、GraphRAG query、
    CLI output 或 rendering 行为重写。

## Residual Risks

- `src/job-state/repository.ts:954` 的 repository run-record candidate 仍保留
  `job?.stageFingerprints?.[record.stage]` fallback。当前路径还会通过
  `inputFingerprint` 过滤和 artifact fingerprint validation 阻断本次 stale
  `query_ready` 问题，但它与 `projectQueryReadyLineage` 的更严格 projection
  规则存在未来漂移风险。
- run record schema 没有 top-level stage/provider fingerprint 字段。当前
  capability projection 依赖 `metadata.stageFingerprint` 或 `inputFingerprint`
  表达历史 stage fingerprint；若未来 writer 改变 `inputFingerprint` 语义，
  需要同步更新 projection 或 run record schema。
- stale `query_ready` fingerprint 已有直接回归测试；但 restore 路径尚无完全
  同构的 “old query_ready fingerprint after re-register” 专项测试。当前
  restore 复用 `projectQueryReadyLineage`，降低了分叉风险
  （`src/vault/restore.ts:230`, `src/vault/restore.ts:299`）。
- `community_report` 与 `embed` 的 stale artifact-id recovery 主要通过
  query-ready producer lineage 组合覆盖，单独 stage-specific 回归仍较少。

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  (`49 passed`).
- Passed: `npm run test:types`.
- Passed: `git diff --check -- src/graphrag/capability-catalog.ts
  src/job-state/repository.ts src/vault/restore.ts
  test/book-job-state.test.ts`.
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000
  test/integrations/contracts.test.ts -t
  "restores qmd index and capability mirror from graph vault catalogs"`
  (`1 passed`, `69 skipped`).
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000
  test/integrations/contracts.test.ts -t "restore"`
  (`8 passed`, `62 skipped`).
