# Development Audit Report

Verdict: pass

## Findings

未发现阻断缺陷或需要变更的非阻断缺陷。

本次审计的未提交 diff 限定在
`src/job-state/repository.ts` 和 `test/book-job-state.test.ts`。
实现满足 10 条固定开发审计基准，未发现对 qmd search、GraphRAG
query、CLI 输出或渲染路径的无关行为改写。

## Criteria Coverage

1. Pass. 高成本生产阶段不会仅因 checkpoint artifact id 过期而被重跑。
   `src/job-state/repository.ts:2491` 到 `src/job-state/repository.ts:2518`
   对 high-cost stage 按同一 book、stage、producer run 和 required kind
   从当前 artifact manifest 重新选择证据。新增测试
   `test/book-job-state.test.ts:1915` 覆盖 `graph_extract` artifact id
   刷新后的恢复路径。
2. Pass. 阶段 readiness 通过统一 artifact set validator 做闭环验证。
   `src/job-state/repository.ts:2521` 到 `src/job-state/repository.ts:2577`
   调用 `validateBookArtifactSet`，后者在
   `src/job-state/artifact-validation.ts:477` 到
   `src/job-state/artifact-validation.ts:581` 校验 producer lineage、
   required kind、stage fingerprint、provider fingerprint、corpus content
   hash、book scope 和文件完整性。
3. Pass. Checkpoint artifact ids 被安全地视为 stale references。
   `src/job-state/repository.ts:2491` 到 `src/job-state/repository.ts:2518`
   不信任 high-cost checkpoint 内的旧 artifact id 列表，而是使用同一
   producer run 的当前 artifacts；`src/job-state/repository.ts:2538`
   继续要求这些当前 artifacts 全部通过 readiness 验证。
4. Pass. 新的 failed/running checkpoint 不会遮蔽旧的可用成功 checkpoint。
   `src/job-state/repository.ts:2462` 到 `src/job-state/repository.ts:2488`
   从 checkpoint 和 run record 构建候选集；
   `src/job-state/repository.ts:2598` 到 `src/job-state/repository.ts:2633`
   只选择 status 为 `succeeded` 且验证通过的候选；
   `src/job-state/repository.ts:2635` 到 `src/job-state/repository.ts:2700`
   用 effective state 覆盖当前 failed/running 诊断状态。新增测试
   `test/book-job-state.test.ts:2001` 覆盖 newer running 不遮蔽 older
   success。
5. Pass. Query-ready readiness 仍然要求 `graph_extract`、
   `community_report`、`embed` 三个 producer run ids 和 validated
   artifacts。`src/job-state/repository.ts:1792` 到
   `src/job-state/repository.ts:1809` 从 effective producer checkpoints
   计算 run ids；`src/job-state/repository.ts:1811` 到
   `src/job-state/repository.ts:1858` 验证 producer stages；
   `src/job-state/repository.ts:1888` 到 `src/job-state/repository.ts:1926`
   验证 query-ready artifacts。
6. Pass. Query-ready capability publishing 使用 validated producer lineage
   artifact ids，而不是 stale checkpoint artifact ids。
   `src/job-state/repository.ts:1860` 到 `src/job-state/repository.ts:1885`
   从 effective artifact validity 提取 producer lineage artifact ids；
   `src/job-state/repository.ts:2920` 到 `src/job-state/repository.ts:2938`
   将这些 ids 发布到 capability catalog。测试
   `test/book-job-state.test.ts:2082` 到 `test/book-job-state.test.ts:2171`
   覆盖 capability 中包含 producer artifacts。
7. Pass. Partial 或 invalid artifacts 仍然 fail closed。
   `src/job-state/artifact-validation.ts:398` 到
   `src/job-state/artifact-validation.ts:475` 校验路径、hash、Parquet、
   JSON 和 LanceDB 完整性；`src/job-state/artifact-validation.ts:510`
   到 `src/job-state/artifact-validation.ts:565` 校验 book id、allowed
   kind、book-scoped output、producer run、fingerprint、provider 和 corpus。
   现有负向测试覆盖 missing artifacts、fake Parquet、LanceDB sidecar、
   shared output、missing graph stats、missing qmd corpus registration 等场景。
8. Pass. GraphRAG book isolation 未被削弱。
   `src/job-state/repository.ts:2511` 到 `src/job-state/repository.ts:2518`
   仅从同一 book 的 manifest 中重绑定 high-cost artifacts；
   `src/job-state/artifact-validation.ts:583` 到
   `src/job-state/artifact-validation.ts:597` 继续要求 GraphRAG 输出位于
   book-scoped output。测试 `test/book-job-state.test.ts:2428` 覆盖 shared
   output 拒绝，`test/book-job-state.test.ts:2657` 覆盖跨 book capability
   不回滚。
9. Pass. Resume plan 和 query-ready failure 仍然可观测。
   `src/job-state/repository.ts:753` 到 `src/job-state/repository.ts:889`
   继续报告 `nextStage`、`artifact_missing`、`missingArtifactIds`、
   `missingArtifactKinds` 和 `invalidArtifacts`；
   `src/job-state/repository.ts:1811` 到 `src/job-state/repository.ts:1858`
   以及 `src/job-state/repository.ts:1888` 到
   `src/job-state/repository.ts:1926` 在 query-ready 阻塞时保留 producer
   或 artifact evidence。
10. Pass. 变更范围最小且集中在 stage lineage recovery。
    diff 只修改 `src/job-state/repository.ts` 和
    `test/book-job-state.test.ts`，未触碰 qmd search、GraphRAG query、
    CLI output 或 rendering behavior。

## Residual Risks

- 新增直接测试覆盖了 `graph_extract` 的 stale artifact-id recovery 和
  newer running shadowing；`community_report` 与 `embed` 使用同一 generic
  repository path，但没有新增逐阶段 stale-id recovery 断言。
- 恢复候选依赖 run records 保留 producer `runId` 和 `inputFingerprint`。
  如果历史 run record 缺失或损坏，实现会回退到当前 checkpoint 状态并
  fail closed，无法重建旧成功候选。
- `BookJobRunRecord` 不独立保存 stage/provider fingerprint；从 run
  record 构造 checkpoint candidate 时会使用当前 job metadata。最终安全性
  仍由 artifact manifest 的 fingerprint/provider/corpus 校验保证，但历史
  run record 本身不能作为这些字段的独立事实源。
- 通用 `getResumePlan` 调用者若省略 `artifactRequirements`，仍保留既有
  无 required-kind gate 的行为。GraphRAG workflow 和 query-ready validation
  已传入固定 requirements，因此本 case 的恢复路径不受影响。
- 验证命令已通过：`CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`，
  47 个测试通过；`npm run test:types` 通过。
