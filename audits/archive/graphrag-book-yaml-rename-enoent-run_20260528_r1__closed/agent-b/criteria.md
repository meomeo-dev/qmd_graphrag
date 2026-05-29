# Implementation Audit Criteria

本文件固定本轮实施审计基准。后续重审不得修改以下 10 条基准。

1. Contract schema closure:
   `src/contracts/batch-run.ts` 必须覆盖 durable state/status 所需字段，
   包括 incomplete evidence、`repairAllowed`、`cleanupReason`、sidecar fields、
   以及 status-json durable failure entry fields。
2. Runner schema parity:
   `scripts/graphrag/batch-epub-workflow.mjs` 内部 zod schema 必须与公开
   contract schema 保持同等字段闭合，不得因脚本内重复 schema 丢字段。
3. Durable evidence projection:
   `localDurableEvidence` 与 `durableProjection` 必须无损投影 durable evidence
   字段，包括 sidecar、checksum、fsync、repair、cleanup 与 incomplete evidence。
4. Status-json durable diagnostics:
   `durableStateFailures`、`durableTempDiagnostics` 与
   `durableLockDiagnostics` 条目必须保留本地状态失败的必要身份、分类、恢复决策、
   command/item/book scope、read-only 决策与 redacted evidence。
5. Child process durable envelope:
   `resume-book-workspace.mjs` 发出的 typed durable failure envelope 必须保留
   shared durable store 的完整 evidence，父 runner 不得退化为文本分类。
6. Recovery/event field preservation:
   command check、item checkpoint、event、manifest durableFailureSummary、
   status-json 与 recovery summary 必须一致保留 durable failure 字段。
7. Status-json read-only behavior:
   `--status-json` 不得创建、删除、重命名或修改 state root 内的 lock、temp、
   checksum、checksum meta、event、checkpoint、manifest、status 或 recovery summary。
8. Durable preflight coverage:
   before-claim、before-resume-book 与 runner-start preflight 必须从
   targetMapping 派生扫描范围，并覆盖 book-scoped YAML primary、checksum sidecar、
   checksum meta sidecar、temp 与 lock。
9. Sidecar repair boundary:
   checksum meta sidecar 缺失、无效、冲突或 rename ENOENT 时，必须区分
   sidecar-only 与 primary-bundle 处理，并在 evidence 中指明 primary 与 sidecar。
10. Focused regression coverage:
    测试必须覆盖 schema closure、status-json read-only、sidecar failure fields、
    incomplete envelope、recovery summary projection 与 book-scoped YAML preflight。
