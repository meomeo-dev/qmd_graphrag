# Agent C Implementation Audit R1

## Verdict

Verdict: FAIL.

当前实现已覆盖主要 mapping 修复路径，但未完全满足固定 10 条审计基准。
阻断点有两个：runner durable evidence schema/projection 未保留
`auxiliaryTargetLocator` 与 `auxiliarySidecarKind`，以及测试结果记录只列出
verification 命令，未记录这些命令的通过结果。

## 逐条检查

1. Implementation must be scoped to cost-accounting auxiliary durable mapping
   and required parity wiring.

   结论：PASS。

   当前 diff 集中在 Type DD、shared durable store、runner adapter、durable
   target normalizer、focused tests 与 package file list。未看到 provider
   retry、GraphRAG stage gate、EPUB scheduling 或 checkpoint 重开策略的改动。

2. `normalizeDurableTargetForMapping` must produce deterministic output for
   primary, temp, temp owner, checksum, checksum meta, lock and corrupt paths.

   结论：PASS。

   `src/job-state/durable-target-normalizer.ts` 与
   `scripts/graphrag/durable-target-normalizer.mjs` 以纯字符串规则归一化 primary、
   `.tmp-*`、`.tmp-*.owner.json`、`.sha256`、`.sha256.meta.json`、`.lock` 与
   `.corrupt-*`。`test/durable-target-normalizer.test.ts` 覆盖 primary、JSONL
   temp owner、checksum temp owner、checksum meta temp owner、corrupt quarantine、
   unknown JSONL auxiliary 与 runner/shared parity。

3. Temp owner sidecars must be classified as auxiliary evidence, not primary
   JSON durable targets.

   结论：FAIL。

   Mapping 层已把 temp owner sidecar 归一回 primary，并生成
   `auxiliarySidecarKind: "temp_owner"`。但是 runner 证据投影层没有保留该
   字段：`DurableStateDiagnosticSchema`、`BatchCommandCheckSchema`、
   `BatchEventLogSchema`、`BatchRecoverySummaryItemSchema` 未声明
   `auxiliaryTargetLocator` 或 `auxiliarySidecarKind`；`localDurableEvidence`、
   `durableProjection` 与 `normalizeDurableFailureEnvelope` 也未投影这些字段。
   因此在 `resume-book-*`、event、checkpoint、status-json 或 recovery summary
   路径中，temp owner sidecar 的 auxiliary classification 会被丢失或无法通过
   schema 保留。

4. Corrupt quarantine paths for `cost-accounting.jsonl` must inherit the
   primary mapping.

   结论：PASS。

   Normalizer 会把 `cost-accounting.jsonl.corrupt-*` 归一为
   `cost-accounting.jsonl`，并标记 `corrupt_quarantine`。新增
   `test/graphrag-cost-accounting-durable.test.ts` 覆盖 corrupt-tail quarantine
   append path，确认 ledger 重新写入且存在 `cost-accounting.jsonl.corrupt-*`。

5. Unknown production JSONL auxiliary paths must still fail closed after
   normalization to their unknown primary.

   结论：PASS。

   Normalizer 对 unknown auxiliary 只剥离辅助后缀，保留 unknown primary identity；
   durable mapping 查不到 explicit row 时仍按 production `/graph_vault/` target
   抛出 `durable_target_mapping_missing`。新增测试覆盖
   `graph_vault/catalog/unknown.jsonl` fail closed。

6. Tests must verify no leftover `.tmp-*` or `.owner.json` files after a
   successful cost accounting append.

   结论：PASS。

   `test/graphrag-cost-accounting-durable.test.ts` 的 successful append 用例读取
   `graph_vault/catalog`，断言不存在包含 `.tmp-` 的 entry，也不存在
   `.owner.json` 后缀 entry。

7. Existing GraphRAG provider cost accounting integration tests must continue
   to pass.

   结论：FAIL。

   `reports/status.json` 只在 `implementation.verification` 中列出
   `test/integrations/graphrag-cost.test.ts` 的执行命令，没有记录 exit code、
   pass/fail、stdout 摘要或可审计结果文件。按本轮要求“审查当前工作区 diff 和
   测试结果记录”，命令清单不足以证明 existing integration tests continue to
   pass。

8. Existing durable runner preflight/state tests relevant to mapping and
   fsync evidence must continue to pass.

   结论：FAIL。

   `reports/status.json` 只列出
   `test/graphrag-runner-durable-state.test.ts` 与
   `test/graphrag-runner-durable-preflight.test.ts` 的执行命令，没有记录通过结果。
   另外，第 3 条指出 runner durable evidence projection 未保留 auxiliary 字段，
   该问题也会削弱相关 mapping/evidence 测试的充分性。

9. The Type DD patch, implementation, tests and package file list must be
   internally consistent.

   结论：FAIL。

   Type DD 要求 visible auxiliary failure evidence 包含
   `auxiliaryTargetLocator` 或 `auxiliarySidecarKind`，并要求
   `resume-book-*` durable failure envelope 保留 sidecar/auxiliary evidence。
   实现的 normalizer 生成这些字段，但 runner schemas 和 projection helpers 未
   接收或保留它们。package file list 已加入
   `scripts/graphrag/durable-target-normalizer.mjs`，这一部分一致；不一致点集中在
   Type DD 与 runner evidence projection。

10. No unrelated refactor, formatting churn or generated artifact mutation may
    be included as part of the fix.

    结论：PASS。

    当前 tracked diff 限于 Type DD、package file list、shared durable store 与
    runner adapter。新增文件限于 normalizer、focused tests 和审计目录。未看到
    unrelated refactor、formatter churn 或生成产物变更。

## 最小必须修复项

1. 在 `scripts/graphrag/batch-epub-workflow.mjs` 的 durable evidence schema 和
   projection 路径中补齐 `auxiliaryTargetLocator` 与 `auxiliarySidecarKind`：
   `DurableStateDiagnosticSchema`、`BatchCommandCheckSchema`、
   `BatchEventLogSchema`、`BatchRecoverySummaryItemSchema`、`localDurableEvidence`、
   `durableProjection`、`normalizeDurableFailureEnvelope` 都必须保留这两个字段。

2. 为 runner/subprocess durable failure projection 增加或更新测试，证明
   `cost-accounting.jsonl.tmp-*.owner.json` 的 failure evidence 在 commandCheck、
   event、status-json 或 recovery summary 中保留 auxiliary classification，
   不被 schema 丢弃。

3. 补充可审计测试结果记录，而不是只列 verification 命令。至少记录以下命令的
   pass/fail 或 exit code：`test/integrations/graphrag-cost.test.ts`、
   `test/graphrag-runner-durable-state.test.ts`、
   `test/graphrag-runner-durable-preflight.test.ts`。若有失败，先修复再重审。
