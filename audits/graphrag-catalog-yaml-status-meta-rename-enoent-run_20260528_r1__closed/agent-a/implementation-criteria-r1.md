# 实施审计基准 R1：Agent A

适用范围：`--status-json` 只读契约、catalog YAML durable 读取路径、
checksum sidecar 证据投影、恢复摘要 schema 与测试覆盖。

1. `--status-json` 不得创建、修改或删除任何 durable 文件、lock、temp、
   owner、checksum、checksum meta、quarantine、event 或 summary。
2. `--status-json` 读取 catalog、manifest、checkpoint 与 typed JSON/YAML 时，
   只能走 read-only inspection，不得触发 reconcile/backfill。
3. 缺失 `*.sha256.meta.json` 时必须降级为诊断，保留 exit 0 与 JSON stdout，
   且不得把缺失 meta 修复回磁盘。
4. read-only 诊断必须包含 target、primary sidecar 映射、lane、owner、
   localFailureClass、checksumRecoveryDecision 与 `repairAllowed: false`。
5. repair writer 模式允许 backfill meta；若 sidecar rename ENOENT，必须产生
   `durable_temp_rename_enoent`，且不得 quarantine primary YAML。
6. checksum meta sidecar 的 `primaryTargetLocator`、`sidecarTargetLocator`
   与 `sidecarKind` 必须贯穿 error、event、summary 与共享 contract。
7. `BatchRecoverySummarySchema` 必须允许 read-only durable diagnostics，
   且不得污染 item checkpoint 的 recoveryDecision 枚举。
8. 测试必须证明 `status-json` 前后 catalog 目录快照完全一致。
9. 测试必须证明 repair writer sidecar ENOENT 可在 events 中审计。
10. 新实现不得破坏既有 durable checkpoint rename ENOENT 回归语义。
