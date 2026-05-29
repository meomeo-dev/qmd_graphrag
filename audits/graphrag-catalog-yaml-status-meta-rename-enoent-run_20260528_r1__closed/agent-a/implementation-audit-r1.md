# 实施审计报告 R1：Agent A

结论：FAIL

失败原因：第 8 条基准未满足。现有测试没有证明 `status-json`
执行前后 catalog 目录快照完全一致。

## 逐条判定

| 基准 | 判定 | 审计结论 |
|---|---:|---|
| 1 | PASS | `statusJson` 分支跳过 lock、preflight、reconcile、event 写入与 summary 写入；`event()`、`writeTypedJson()` 在该模式下不落盘。 |
| 2 | PASS | catalog 使用 `readDurableYamlReadOnly()`，manifest/checkpoint 使用 `readDurableJsonReadOnly()`；reconcile/backfill 在 `statusJson` 下被跳过。 |
| 3 | PASS | 缺失 meta 被投影为 `metadata_missing_read_only`；测试断言 exit 0、stderr 空、meta 仍不存在。 |
| 4 | PASS | `inspectDurableSerializedTargetReadOnly()` 构造 target/primary/sidecar/lane/owner/checksum/repairAllowed 诊断字段。 |
| 5 | PASS | writer 模式会 backfill meta；sidecar 写入 ENOENT 由 `renameWithDurableEvidence()` 分类，未进入 YAML quarantine。 |
| 6 | PASS | contract、event schema、summary diagnostics schema 均包含 checksum meta sidecar locator/kind 字段。 |
| 7 | PASS | `metadata_missing_read_only` 只进入 `DurableStateDiagnosticSchema`；item checkpoint 仍使用 `BatchRecoveryDecisionSchema`。 |
| 8 | FAIL | 当前快照只比较 catalog 顶层文件名，不能证明递归目录、文件内容、event、summary、sidecar 字节完全未变。 |
| 9 | PASS | 测试断言 `durable_replace_failed` event 带 `durable_temp_rename_enoent`、rename syscall、ENOENT 与 sidecar locator。 |
| 10 | PASS | 既有 durable checkpoint rename ENOENT 回归测试仍保持 stop-until-fixed 语义。 |

## 阻塞问题

1. `test/graphrag-runner-status-json-readonly.test.ts:70` 的
   `catalogSnapshot()` 仅返回顶层目录项列表，不能检测递归子目录、
   durable 文件内容、event、summary、lock、temp、owner、checksum 和
   checksum meta 的变化。

## 非阻塞建议

- 将 `catalogSnapshot()` 扩展为递归快照，记录相对路径、文件类型、大小与
  SHA-256 内容摘要。
- 在 read-only meta 缺失测试中断言 `events.jsonl`、`status.json`、
  `recovery-summary.json` 未创建或未修改。
- 在 sidecar ENOENT 测试中补充 primary YAML 内容和 checksum 未变断言。

## 残余风险

当前代码路径显示 `--status-json` 已跳过写入，但测试快照粒度不足，仍可能
漏检递归 catalog 子树或文件内容的意外变更。
