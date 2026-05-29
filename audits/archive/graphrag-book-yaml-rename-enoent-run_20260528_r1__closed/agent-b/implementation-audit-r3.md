# Implementation Audit R3

审计对象：GraphRAG 多书并行 Runner 的 durable schema/projection、
status-json diagnostics、runner-start preflight 与 sidecar repair boundary。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. checksum meta conflict 错误隔离 primary target

- 文件：`src/job-state/durable-state-store.ts`
- 违反基准：9
- 影响：`checksumMetaIsInvalid(actual, meta)` 分支调用 `quarantineTarget(path,
  "checksum_mismatch")`，会把 primary target 移到 `.corrupt-*`。checksum meta
  sidecar conflict 应该是 sidecar-only 边界，不能升级为 primary-bundle
  quarantine。
- 修复要求：新增 checksum meta sidecar-only quarantine/repair 路径，只隔离
  `${path}.sha256.meta.json`，并保留 primary target 与 checksum sidecar。
  evidence 必须包含 `primaryTargetLocator`、`sidecarTargetLocator`、
  `sidecarKind: checksum_meta`、checksum expected/actual 与 repair decision。

### 2. checksum meta invalid JSON 被吞并为 missing

- 文件：`src/job-state/durable-state-store.ts`
- 违反基准：9
- 影响：`readChecksumMeta()` 捕获读取与 JSON parse 错误后统一返回 `null`，调用方将
  invalid meta 与 missing meta 一样 backfill，缺失、无效、冲突三类状态不可观测。
- 修复要求：把 checksum meta 读取改为显式状态，至少区分 `missing`、`invalid` 与
  `present`。missing 可 backfill；invalid/conflict 必须走 sidecar-only
  quarantine/repair，并提供 typed evidence。

## 通过证据

- R2 runner-start preflight 修复已从 targetMapping 派生全局 scope 与
  item-derived book scope，并扫描 temp。
- schema/projection/status-json durable fields 未发现回退。
- child durable envelope 保留 typed evidence。

