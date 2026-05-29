# Design Re-audit R3 Agent A: sidecar quarantine Type DD 增量复核

结论：PASS

审计范围限定为：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- R2 Agent A 固定 10 条设计审计基准
- R3 新增 Type DD 内容：
  `checksumCommit.sidecarQuarantineDecisionTable`、
  `checksumCommit.sidecarQuarantineRule`、
  `durableStateAcceptanceMatrix.sidecar_only_quarantine_boundary`

本轮只复核新增 Type DD 内容是否破坏 R2 已通过的 status-json 严格只读
（strict read-only）、read-only diagnostic、sidecar inheritance 与验收测试
设计。未审查实现代码，未运行真实 EPUB runner，未读取或打印 `.env`。

## 固定设计审计基准

1. status-json 严格只读（strict read-only）

   判定：PASS

   新增 sidecar quarantine 决策表没有扩大 `--status-json` 权限。
   `statusJsonReadOnlyContract` 仍声明 `--status-json` 是 observer，mutation
   policy 仍为 `no_state_root_mutation`，并禁止 repair、writable reconcile、
   quarantine、event append、manifest rebuild、status cache 写入与 recovery
   summary 写入。新增 `sidecar_only_quarantine_boundary` 中的 status-json 仅作为
   观测面命名 quarantine object，不授予实际 quarantine 写操作。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1251`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1253`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1255`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1258`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1491`

2. status-json 不得获取写锁或 per-target durable lock

   判定：PASS

   新增 `sidecarQuarantineRule` 要求 sidecar-only quarantine 必须持有 primary
   target lock，但该规则属于 repair writer/quarantine 写路径。它没有覆盖或削弱
   `statusJsonReadOnlyContract.forbiddenOperations` 中的禁止获取 exclusive
   durable write lock 或 per-target lock。status-json 仍不能通过 sidecar-only
   quarantine 边界获取锁。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1260`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1261`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:680`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:681`

3. status-json 读路径不得调用可写 reconcile 或 backfill

   判定：PASS

   `readOnlyObserver` 仍要求 `--status-json` 使用 read-only durable
   inspection，禁止创建 lock、temp、owner、checksum、checksum meta、
   quarantine target 或追加 event。新增决策表把可写 backfill 与 quarantine
   动作放在 repair writer 语义下；对 meta 缺失仍固定为
   `metadata_missing_read_only`，不能 backfill。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:634`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:635`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:636`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:637`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:640`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:645`

4. 正常恢复模式允许 checksum backfill，但必须持有目标锁

   判定：PASS

   新增规则强化而非放松该基准。`repairWriter` 仍限定 normal resume、
   migrate-only 或显式 repair command 必须在持有 per-target lock 时执行
   checksum/checksum meta backfill 与 quarantine。`sidecarQuarantineRule`
   又补充 sidecar-only quarantine 必须持有 primary target lock。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:630`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:631`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:632`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:680`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:681`

5. `.sha256` 缺失与 `.sha256.meta.json` 缺失必须区分

   判定：PASS

   新增 `sidecarQuarantineDecisionTable` 保持并细化该区分：
   `target_valid_checksum_matches_meta_missing` 对应 checksum 匹配但 meta 缺失，
   status-json 行为是 `read_only_degraded`，
   `recoveryDecision=metadata_missing_read_only`；`target_valid_checksum_missing`
   另行建模为 checksum sidecar 缺失，repair writer 可回填 checksum。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:640`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:643`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:644`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:645`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:658`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:660`

6. checksum sidecar 必须继承 primary target 的 lane 与 owner

   判定：PASS

   新增 quarantine 决策表没有改变 `derivedSidecarRule`。checksum sidecar 与
   checksum meta sidecar 仍继承 primary target 的 lane、owner、
   laneTimeoutMs、releaseOn、durableMode 与 preflight scope，且 sidecar
   failure evidence 仍必须同时包含 primary 与 sidecar locator 以及
   sidecarKind。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:246`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:247`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:249`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:250`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:251`

7. sidecar durable replace 的 ENOENT 分类必须稳定

   判定：PASS

   新增 sidecar-only quarantine 边界没有改变 rename ENOENT 的 fail-closed
   分类。checksum meta backfill rename ENOENT 仍必须分类为
   `local_state_integrity`、`durable_temp_rename_enoent` 与 `stop_until_fixed`。
   primary target 与 checksum 匹配时仍不得隔离 primary，诊断必须指向 sidecar
   target 并保留 primaryTargetLocator。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:700`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:701`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:702`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:703`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1478`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1480`

8. status-json 应输出 durable diagnostics，而不是尝试修复后失败

   判定：PASS

   新增内容继续把 status-json 限定为诊断投影。read-only diagnostics 仍覆盖
   checksum meta missing、checksum mismatch 与 unresolved temp/lock。新增
   `sidecar_only_quarantine_boundary` 只要求 event、status-json 或 recovery
   summary 能命名 quarantine object；status-json 在此仍是输出 durable
   diagnostics，而不是执行 sidecar quarantine 或 repair。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1270`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1271`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1276`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1280`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1491`

9. manifest 与 checkpoint 聚合在 status 模式下基本抑制写入

   判定：PASS

   新增 quarantine 决策表不影响 status 模式的写入抑制。status-json 仍禁止
   append event、写 manifest、写 status、写 recovery summary；self failure
   projection 仍声明输出不得依赖写 checkpoint、event、status.json 或
   recovery-summary.json。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1268`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1269`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1284`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1288`

10. Type DD 必须覆盖 status-json 只读回归测试

    判定：PASS

    原 R2 的 status-json 只读验收用例仍保留：meta 缺失时不创建、删除或
    rename lock、temp、checksum、checksum meta、event、checkpoint、status 或
    recovery-summary 文件；status-json 不尝试 checksum meta backfill，因此不会
    触发 checksum meta sidecar rename ENOENT。新增
    `sidecar_only_quarantine_boundary` 补齐 Agent B R2 指出的 quarantine 对象
    边界，并未削弱 status-json 只读回归测试。

    证据：

    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1465`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1467`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1470`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1474`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1476`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1482`

## 增量复核结论

R3 新增 Type DD 内容没有破坏 Agent A R2 已通过的设计边界：

- status-json 仍是严格只读 observer，不持锁、不修复、不隔离、不写状态。
- read-only diagnostic 仍以 `metadata_missing_read_only` 与
  `read_only_degraded` 表达 checksum meta 缺失。
- sidecar inheritance 仍由 primary target 的 lane、owner 与 durable scope 决定。
- 验收矩阵继续覆盖 status-json no-mutation 与 checksum meta rename ENOENT，
  并新增 sidecar-only quarantine 对象边界。

## 实现准入结论

允许进入实现。

实现阶段必须保持 Type DD 的模式分离：

- `--status-json` 只能执行 read-only durable inspection 与 JSON 诊断投影。
- sidecar-only quarantine、checksum backfill 与 checksum meta backfill 只能由
  持有 primary target lock 的 repair writer 执行。
- status-json 若输出 quarantine object，只能作为只读诊断字段，不得执行
  quarantine 或 rename。

最终判定：PASS
