# 实施审计报告 R1：Agent C

结论：FAIL

固定 10 条基准中，7 条 PASS、3 条 FAIL。阻塞项为基准 2、5；基准 10 因
存在阻塞项而 FAIL。真实 EPUB runner 恢复门仍保持关闭。

## 逐条判定

| 基准 | 判定 | 审计结论 |
|---|---:|---|
| 1 | PASS | `readOnlyObserver` 已在实现中落地，`--status-json` 使用只读 durable inspection，并记录 `metadata_missing_read_only` 诊断。 |
| 2 | FAIL | `repairWriter` 覆盖 meta backfill 和 rename ENOENT 分类的一部分，但成功 backfill 缺少 durable event 或 recovery summary evidence。 |
| 3 | PASS | `status_json_catalog_missing_checksum_meta` 有自动化测试。 |
| 4 | PASS | `status_json_checksum_meta_backfill_rename_enoent` 有 repair writer 失败注入测试。 |
| 5 | FAIL | `sidecar_only_quarantine_boundary` 未由实现完整保证；sidecar meta invalid/conflict 路径仍可能 quarantine primary YAML。 |
| 6 | PASS | shared contract 与 runner 本地 schema 已同步 diagnostics 与 sidecar evidence 字段。 |
| 7 | PASS | recovery summary 提供 `durableStateFailures`，并派生 temp/lock diagnostics。 |
| 8 | PASS | 真实 EPUB runner 在实施审计 PASS 前保持 `resumeAllowed: false`。 |
| 9 | PASS | 验证记录包含语法检查、类型检查、聚焦 vitest 与 Type DD YAML 解析。 |
| 10 | FAIL | 存在阻塞项，必须先修复实现或设计，再复用本基准重新审计。 |

## 阻塞问题

1. `repairWriter` 成功 backfill 缺少 durable event 或 recovery summary evidence。
   JSON/YAML missing-meta 路径只调用 `writeJsonAtomicSidecar()` 写回 meta，
   未记录成功修复事件或摘要证据。
2. sidecar-only quarantine boundary 未完整实现。当前 YAML 路径在
   `checksumMetaIsInvalid()` 时抛出 `checksum_mismatch`，随后 catch 调用
   `quarantineDurableTarget(path, "yaml", ...)`，可能 rename primary YAML。

## 非阻塞建议

- 为 `sidecar_only_quarantine_boundary` 增加直接自动化测试。
- 为 successful `metadata_backfilled` 增加事件断言或 recovery summary evidence
  断言。
- 将 sidecar quarantine/backfill 提取为共享 helper，减少 JSON/YAML 分支漂移。

## 残余风险

在阻塞项修复前，真实 EPUB runner 恢复门应继续保持 `resumeAllowed: false`。
