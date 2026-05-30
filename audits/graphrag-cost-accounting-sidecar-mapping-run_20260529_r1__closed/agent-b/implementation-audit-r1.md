# Agent B Implementation Audit R1

## Verdict: FAIL

当前工作区 diff 基本满足 Agent B 固定 10 条标准中的实现形态要求，但固定审计
范围内没有可审计的测试通过结果、退出码或日志记录；`reports/status.json` 只列出
verification commands，未记录 outcome。因此第 10 条不满足，Implementation Audit
R1 不能判 PASS。

## 逐条检查结论

1. PASS

   实现遵循已补入 Type DD 的 `auxiliarySidecarMappingRule` 与
   `jsonl_read_reconcile_replace` 方向。`src/job-state/durable-state-store.ts`
   与 `scripts/graphrag/batch-epub-workflow.mjs` 均改为通过
   `normalizeDurableTargetForMapping` 将 auxiliary path 归一到 primary target；
   Type DD 中 `graph_vault/catalog/cost-accounting.jsonl` 已声明
   `durableWriteMode: jsonl_read_reconcile_replace` 与
   `auxiliarySidecars: inherit_primary_mapping`。

2. PASS

   未发现为 `.tmp-*`、`.owner.json`、`.lock`、`.sha256`、
   `.sha256.meta.json` 或 `.corrupt-*` 新增显式 targetMapping row。diff 中
   target mapping 仍只注册 primary targets，例如
   `graph_vault/catalog/cost-accounting.jsonl`。

3. PASS

   `src/job-state/durable-target-normalizer.ts` 的
   `durableTargetNormalizationEvidence` 会在 auxiliary path 上输出
   `primaryTargetLocator`。`durable-state-store.ts` 的 mapping miss evidence 与
   successful mapping evidence 都扩展该 normalization evidence。runner adapter
   同样在 `batch-epub-workflow.mjs` 中投影该 evidence。

4. PASS

   normalization 只处理固定 durable engine forms：`.tmp-`、`.owner.json` 且需
   basename 中存在 `.tmp-`、`.lock`、`.corrupt-`、`.sha256` 与
   `.sha256.meta.json`。未发现 broad catalog fallback 或任意 `.owner.json`
   兜底映射。

5. PASS

   `cost-accounting.jsonl` 未在实现中获得隐式 checksum sidecar。provider cost
   accounting 仍通过 `writeOpaqueFileDurableSync` 写入 JSONL ledger；本次变更没有
   为该路径调用 checksum sidecar 写入。Type DD 也声明
   `checksumPolicy: none_for_current_jsonl_replace`。

6. PASS

   runner adapter parity 已有测试覆盖。`test/durable-target-normalizer.test.ts`
   同时导入 `scripts/graphrag/durable-target-normalizer.mjs` 与
   `src/job-state/durable-target-normalizer.js`，并断言 primary、temp owner、
   corrupt、checksum、checksum meta 与 lock locators 的 normalization 输出一致。

7. PASS

   `batch-epub-workflow.mjs` 新增导入
   `scripts/graphrag/durable-target-normalizer.mjs`，且 `package.json` 的 `files`
   列表已包含该 runtime helper。

8. PASS

   新行为被放入小 helper 文件：
   `src/job-state/durable-target-normalizer.ts` 与
   `scripts/graphrag/durable-target-normalizer.mjs`。对已 oversized 的
   `durable-state-store.ts` 和 `batch-epub-workflow.mjs` 只做小规模接线改动。

9. PASS

   unknown production target 仍保持 fail closed。shared durable store 在
   normalization 后使用 primary locator 做 targetMapping 查找；未映射的
   production path 仍抛出 `durable_target_mapping_missing`。新增
   `test/graphrag-cost-accounting-durable.test.ts` 覆盖 unknown
   `graph_vault/catalog/unknown.jsonl` 写入抛出 mapping missing。

10. FAIL

   本报告已引用具体文件与测试，但固定审计范围内缺少这些测试的通过结果记录。
   `audits/.../reports/status.json` 的 implementation section 只列出验证命令，
   包括 `test/durable-target-normalizer.test.ts`、
   `test/graphrag-cost-accounting-durable.test.ts`、`npm run test:types`、
   package tests、GraphRAG cost tests 与 durable runner tests；该文件没有记录
   exit code、PASS/FAIL outcome、stdout/stderr 摘要或日志路径。因此不能确认
   “all fixed criteria are satisfied”，也不能返回 PASS。

## 最小必须修复项

1. 在固定审计范围内补充可审计的测试结果记录，至少包含以下命令的 exit code
   与通过结果：
   `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/durable-target-normalizer.test.ts`
   和
   `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-cost-accounting-durable.test.ts`。

2. 若 `reports/status.json` 继续声明 package、typecheck、GraphRAG cost、
   durable state/preflight 或 build verification，也必须为这些声明的验证命令补充
   对应 outcome；否则实现审计无法把这些命令当作已通过证据。

除测试结果记录缺失外，本轮未发现必须追加的代码修复项。
