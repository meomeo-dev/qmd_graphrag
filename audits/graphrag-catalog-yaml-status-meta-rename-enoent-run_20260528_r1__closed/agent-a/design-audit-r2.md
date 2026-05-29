# Design Re-audit R2 Agent A: status-json 与 durable checksum meta

结论：PASS

审计范围限定为：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`

复审目标是确认 Type DD 是否已覆盖 R1 中 Agent A 对
`--status-json`、checksum meta 缺失、sidecar 归属、rename ENOENT
诊断与验收测试的设计关注点。本轮未审查实现代码，未运行真实 EPUB
runner。

## 固定设计审计基准

1. status-json 严格只读（strict read-only）

   判定：PASS

   Type DD 已新增 `statusJsonReadOnlyContract`，明确 `--status-json`
   是严格只读观测入口，只能读取 target、checksum、checksum meta、lock
   owner record、events、manifest、checkpoint 与 provider slot projection，
   并把 durable gap 投影为 redacted diagnostics。契约同时禁止 repair、
   writable reconcile、quarantine、event append、manifest rebuild、
   status cache 写入与 recovery summary 写入。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1203`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1206`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1209`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1210`

2. status-json 不得获取写锁或 per-target durable lock

   判定：PASS

   Type DD 在 status-json 禁止操作中显式列出不得获取 exclusive durable
   write lock 或 per-target lock，也不得创建或删除 `.lock` 文件。checksum
   meta 缺失 crash window 还重复声明 status-json 不得获取写锁。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1212`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1213`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1214`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:650`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:653`

3. status-json 读路径不得调用可写 reconcile 或 backfill

   判定：PASS

   Type DD 已在 `checksumCommit.reconcileModes` 拆分
   `repairWriter` 与 `readOnlyObserver`。`readOnlyObserver` 明确要求
   `--status-json` 使用 read-only durable inspection，禁止创建 lock、
   temp、owner、checksum、checksum meta、quarantine target 或追加 event。
   当 target 与 checksum 匹配但 checksum meta 缺失时，只能投影
   `metadata_missing_read_only`，不能 backfill。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:628`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:629`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:633`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:634`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:637`

4. 正常恢复模式允许 checksum backfill，但必须持有目标锁

   判定：PASS

   Type DD 保留正常修复语义，但把权限收束到 `repairWriter`。normal
   resume、migrate-only 或显式 repair command 只有在持有 per-target lock
   时，才可执行 temp cleanup、checksum backfill、checksum meta backfill
   与 quarantine。共享 durable boundary 也继续禁止未持有 per-target lock
   的 checksum backfill。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:490`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:506`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:628`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:630`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:631`

5. `.sha256` 缺失与 `.sha256.meta.json` 缺失必须区分

   判定：PASS

   Type DD 现在分别建模 `target_new_checksum_missing` 与
   `checksum_meta_missing`。前者覆盖 target 有效但 checksum sidecar 缺失
   的恢复路径；后者覆盖 target 有效、checksum sidecar 匹配但 checksum
   meta 缺失的状态，并明确 repair writer 可回填、status-json 只能报告
   `read_only_degraded diagnostic`。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:646`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:647`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:650`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:652`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:653`

6. checksum sidecar 必须继承 primary target 的 lane 与 owner

   判定：PASS

   Type DD 新增 `derivedSidecarRule`，声明每个 durable YAML/JSON primary
   target 隐式拥有 `{target}.sha256` 与
   `{target}.sha256.meta.json`。sidecar 继承 primary target 的 lane、
   owner、laneTimeoutMs、releaseOn、durableMode 与 preflight scope，且
   不递归生成新的 checksum sidecar。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:246`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:247`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:249`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:250`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:251`

7. sidecar durable replace 的 ENOENT 分类必须稳定

   判定：PASS

   Type DD 保留 rename ENOENT 的 fail-closed 分类，并新增 sidecar evidence。
   `checksum_meta_backfill_rename_enoent` 明确要求 repair writer 写 checksum
   meta sidecar 时的 rename ENOENT 分类为 `local_state_integrity`、
   `durable_temp_rename_enoent` 与 `stop_until_fixed`。当 primary target 与
   checksum 匹配时，不得隔离 primary target，诊断必须指向 sidecar target
   并保留 primaryTargetLocator。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:655`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:657`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:658`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:659`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:727`

8. status-json 应输出 durable diagnostics，而不是尝试修复后失败

   判定：PASS

   Type DD 的 read-only diagnostics 已覆盖 checksum meta missing、
   checksum mismatch 与 unresolved temp/lock。checksum meta missing 状态要求
   输出 `read_only_degraded` 与
   `checksumRecoveryDecision=metadata_missing_read_only`，而不是执行修复。
   `selfFailureProjection` 还要求 status-json 自身读取 durable target 时遇到
   fail-closed durable failure，应尽量输出可解析 JSON，并且不依赖写入
   checkpoint、event、status.json 或 recovery-summary.json。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1222`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1223`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1225`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1226`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1236`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1240`

9. manifest 与 checkpoint 聚合在 status 模式下基本抑制写入

   判定：PASS

   Type DD 的 status-json 只读契约禁止 manifest rebuild、status cache 写入
   与 recovery summary 写入，并在 forbidden operations 中明确禁止写
   `manifest.json`、`status.json` 或 `recovery-summary.json`。这已覆盖 R1
   对 manifest 与 checkpoint 聚合在 status 模式下不得产生写副作用的设计
   要求。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1209`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1210`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1221`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1240`

10. Type DD 必须覆盖 status-json 只读回归测试

    判定：PASS

    Type DD 的 durable state acceptance matrix 新增
    `status_json_catalog_missing_checksum_meta` 与
    `status_json_checksum_meta_backfill_rename_enoent`。前者要求
    `books.yaml` 通过 durable validation 读取但不进入 writable reconcile，
    缺失 meta 被报告为 `metadata_missing_read_only`，且不创建、删除或
    rename lock、temp、checksum、checksum meta、event、checkpoint、status
    或 recovery-summary 文件。后者要求 status-json 不尝试 checksum meta
    backfill，因此不会触发 `books.yaml.sha256.meta.json` 的 rename ENOENT。

    证据：

    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1417`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1419`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1420`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1422`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1426`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1428`

## 剩余阻塞问题

无设计阻塞问题。

R1 的设计缺口已在 Type DD 中被补齐：

- status-json 已被定义为 strictly read-only observer。
- 读路径与 repair writer 的 reconcile 权限已分离。
- checksum sidecar 缺失与 checksum meta 缺失已分属不同 crash window。
- checksum sidecar 与 checksum meta sidecar 已继承 primary target 的 lane、
  owner 与 durable scope。
- status-json durable diagnostics 与只读回归验收已进入 acceptance matrix。

## 实现准入结论

允许进入实现。

实现阶段必须证明以下行为，但这些是实现验收项，不再构成 Type DD 设计阻塞：

- `--status-json` 不调用任何会创建 lock、temp、owner、checksum、checksum
  meta、event、manifest、status cache 或 recovery summary 的路径。
- status-json 读取 `books.yaml` 时，checksum meta 缺失只输出
  `metadata_missing_read_only` / `read_only_degraded` 诊断。
- repair writer 仍可在持有 per-target lock 时回填 checksum meta。
- repair writer 的 checksum meta sidecar rename ENOENT 保持
  `local_state_integrity`、`durable_temp_rename_enoent` 与
  `stop_until_fixed`，并输出 primary 与 sidecar evidence。

最终判定：PASS
