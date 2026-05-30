# Agent B Implementation Audit R2

## Verdict: PASS

当前工作区 diff、R2 修复与
`audits/graphrag-cost-accounting-sidecar-mapping-run_20260529_r1__open/reports/verification-r2.md`
满足 Agent B `implementation-audit-criteria.md` 的固定 10 条标准。允许关闭本轮
Implementation Audit R2。

## 逐条检查结论

1. PASS

   实现遵循 patched Type DD 的 `auxiliarySidecarMappingRule` 与
   `jsonl_read_reconcile_replace` policy。`src/job-state/durable-state-store.ts`
   与 `scripts/graphrag/batch-epub-workflow.mjs` 均使用
   `normalizeDurableTargetForMapping` 将 auxiliary path 归一到 primary target。
   Type DD 中 `graph_vault/catalog/cost-accounting.jsonl` 保持
   `durableWriteMode: jsonl_read_reconcile_replace`、
   `checksumPolicy: none_for_current_jsonl_replace` 与
   `auxiliarySidecars: inherit_primary_mapping`。

2. PASS

   未发现为 `.tmp-*`、`.owner.json`、`.lock`、`.sha256`、
   `.sha256.meta.json` 或 `.corrupt-*` 新增显式 targetMapping row。映射表仍以
   primary targets 为准，例如 `graph_vault/catalog/cost-accounting.jsonl`。

3. PASS

   auxiliary path evidence 包含 primary target locator。
   `src/job-state/durable-target-normalizer.ts` 的
   `durableTargetNormalizationEvidence` 输出 `primaryTargetLocator`、
   `auxiliaryTargetLocator` 与 `auxiliarySidecarKind`。R2 还将
   `auxiliaryTargetLocator` 和 `auxiliarySidecarKind` 加入
   `src/contracts/batch-run.ts`、`scripts/graphrag/batch-epub-workflow.mjs` 的
   schema/projection，以及 `scripts/graphrag/resume-book-workspace.mjs` 的 durable
   failure envelope。

4. PASS

   normalization 只剥离固定 durable engine suffix forms：
   `.tmp-`、带 `.tmp-` 的 `.owner.json`、`.lock`、`.corrupt-`、
   `.sha256` 与 `.sha256.meta.json`。未发现 arbitrary `.owner.json` 或 catalog
   fallback pattern。

5. PASS

   `cost-accounting.jsonl` 未隐式获得 checksum sidecars。provider cost
   accounting 仍通过 `writeOpaqueFileDurableSync` 写 JSONL ledger；R2 verification
   覆盖了 existing provider cost behavior，且 Type DD 明确该 target 当前
   `checksumPolicy: none_for_current_jsonl_replace`。

6. PASS

   runner adapter parity 已测试。
   `test/durable-target-normalizer.test.ts` 同时导入
   `scripts/graphrag/durable-target-normalizer.mjs` 与
   `src/job-state/durable-target-normalizer.js`，并断言 primary、temp owner、
   corrupt、checksum、checksum meta 与 lock locators 的 normalization 输出一致。
   `verification-r2.md` 记录该测试 PASS，exit code 0。

7. PASS

   `batch-epub-workflow.mjs` 新增 runtime import
   `scripts/graphrag/durable-target-normalizer.mjs`，且 `package.json` 的 `files`
   列表已包含该 helper。`verification-r2.md` 中 `test/package.test.ts` 记录 PASS，
   exit code 0。

8. PASS

   新行为放在小文件中：
   `src/job-state/durable-target-normalizer.ts` 与
   `scripts/graphrag/durable-target-normalizer.mjs`。对 oversized runner 和 durable
   store 只做接线改动；R2 增加的 schema/projection 字段也属于小范围 contract
   补齐。

9. PASS

   unknown production targets 仍保持 `durable_target_mapping_missing`。
   `test/graphrag-cost-accounting-durable.test.ts` 覆盖 unknown
   `graph_vault/catalog/unknown.jsonl` 写入 fail closed。`verification-r2.md`
   记录该测试所在命令 PASS，exit code 0。

10. PASS

   本报告引用了具体文件与测试；`verification-r2.md` 记录所有固定相关验证均
   PASS 且 exit code 0，包括 syntax check、`npm run test:types`、
   `test/durable-target-normalizer.test.ts`、
   `test/graphrag-cost-accounting-durable.test.ts`、
   `test/integrations/contracts.test.ts`、`test/package.test.ts`、
   `test/integrations/graphrag-cost.test.ts`、
   `test/graphrag-runner-durable-state.test.ts`、
   `test/graphrag-runner-durable-preflight.test.ts` 与 `npm run build`。

## 最小必须修复项

无。
