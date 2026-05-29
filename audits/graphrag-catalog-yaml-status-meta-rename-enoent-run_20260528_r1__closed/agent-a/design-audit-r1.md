# Design Audit Agent A: status-json 与 durable checksum meta 审计

结论：FAIL

审计范围限定为：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`

事故场景为 `--status-json` 读取 `graph_vault/catalog/books.yaml`
时，发现 `books.yaml.sha256.meta.json` 缺失后进入 checksum meta
回填路径，并在写入 meta sidecar 时触发
`DurableStateError local_state_integrity durable_temp_rename_enoent`。

## 固定设计审计基准

1. status-json 严格只读（strict read-only）

   判定：FAIL

   `--status-json` 应只读取磁盘状态并输出诊断，不应创建 lock、temp、
   owner、checksum 或 checksum meta。当前 Type DD 只声明 status-json
   必须展示状态字段和不得输出 secret，未声明只读边界。实现中
   `main()` 在 status 输出前仍调用 `discoverItems()`，随后读取 catalog
   时进入可写 durable 路径。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:10594`
   - `scripts/graphrag/batch-epub-workflow.mjs:10649`
   - `scripts/graphrag/batch-epub-workflow.mjs:5896`
   - `scripts/graphrag/batch-epub-workflow.mjs:5899`

2. status-json 不得获取写锁或 per-target durable lock

   判定：FAIL

   `loadCatalogBySourceHash()` 在 status 模式下仍调用
   `withJsonFileLock(catalogPath, ...)`。该函数会创建 lock 文件、写入
   owner record 并 fsync。即使最终释放 lock，这仍是写操作。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:5899`
   - `scripts/graphrag/batch-epub-workflow.mjs:5321`
   - `scripts/graphrag/batch-epub-workflow.mjs:5351`
   - `scripts/graphrag/batch-epub-workflow.mjs:5353`
   - `scripts/graphrag/batch-epub-workflow.mjs:5402`

3. status-json 读路径不得调用可写 reconcile 或 backfill

   判定：FAIL

   `readDurableYamlAfterReconcileUnlocked()` 无 status guard，直接调用
   `reconcileDurableYamlTargetUnlocked()`。该 unlocked 函数可删除 temp、
   写 `.sha256`、写 `.sha256.meta.json`、提交 pending meta，并写 event。
   这使 status 查询路径绕过了 `reconcileDurableYamlTarget()` 顶层的
   `if (statusJson) return` 防线。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:4998`
   - `scripts/graphrag/batch-epub-workflow.mjs:5004`
   - `scripts/graphrag/batch-epub-workflow.mjs:6547`
   - `scripts/graphrag/batch-epub-workflow.mjs:6548`
   - `scripts/graphrag/batch-epub-workflow.mjs:5070`
   - `scripts/graphrag/batch-epub-workflow.mjs:5091`
   - `scripts/graphrag/batch-epub-workflow.mjs:5112`

4. 正常恢复模式允许 checksum backfill，但必须持有目标锁

   判定：PASS

   Type DD 已声明 checksum backfill 必须通过统一 durable 边界，并禁止
   未持有 per-target lock 的 backfill。实现中顶层 YAML reconcile 会先
   通过 `withJsonFileLock()` 包裹 unlocked reconcile。该设计适用于普通
   runner 恢复模式，但不应扩展到 status-json。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:486`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:499`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:616`
   - `scripts/graphrag/batch-epub-workflow.mjs:4998`
   - `scripts/graphrag/batch-epub-workflow.mjs:5001`

5. `.sha256` 缺失与 `.sha256.meta.json` 缺失必须区分

   判定：FAIL

   Type DD 的 `missingChecksumRule` 主要描述 checksum sidecar 缺失，
   未把 checksum 存在但 checksum meta 缺失定义为独立状态。实现中已
   存在 `meta == null` 且 checksum 匹配时写
   `checksumRecoveryDecision: "metadata_backfilled"` 的行为，但 Type DD
   没有声明该状态在读模式和修复模式下的不同处理。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:615`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:629`
   - `scripts/graphrag/batch-epub-workflow.mjs:5111`
   - `scripts/graphrag/batch-epub-workflow.mjs:5117`

6. checksum sidecar 必须继承 primary target 的 lane 与 owner

   判定：FAIL

   实现通过 `primaryTargetRelativePathForMapping()` 让 `.sha256` 和
   `.sha256.meta.json` 回到 primary target 做 mapping。Type DD 的
   targetMapping 未明确 sidecar 继承规则；`manifestWriterLane` 只声明
   保护本 lane 文件的 checksum sidecars，catalog lane 未对应声明。
   对 `graph_vault/catalog/books.yaml.sha256.meta.json`，Type DD 应明确
   它属于 `books.yaml` 的 `catalogWriterLane`，而不是独立 target。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:223`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:247`
   - `scripts/graphrag/batch-epub-workflow.mjs:2603`
   - `scripts/graphrag/batch-epub-workflow.mjs:2604`
   - `scripts/graphrag/batch-epub-workflow.mjs:2607`

7. sidecar durable replace 的 ENOENT 分类必须稳定

   判定：PASS

   Type DD 已要求 atomic rename ENOENT 分类为
   `local_state_integrity`，并要求 `durable_temp_rename_enoent` 与
   `stop_until_fixed`。实现中的 `renameWithDurableEvidence()` 对
   ENOENT 抛出 `DurableStateError`，附带 `failedSyscall`、`errno`、
   `renameCause` 和 `completedPublishRule: "forbidden"`。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:641`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:952`
   - `scripts/graphrag/batch-epub-workflow.mjs:4116`
   - `scripts/graphrag/batch-epub-workflow.mjs:4123`
   - `scripts/graphrag/batch-epub-workflow.mjs:4134`

8. status-json 应输出 durable diagnostics，而不是尝试修复后失败

   判定：FAIL

   Type DD 要求 status-json 包含 `durableStateFailures`、
   `durableTempDiagnostics` 与 `durableLockDiagnostics`，但没有声明
   read-only inspection（只读检查）发现可修复缺口时如何投影为诊断。
   当前实现可能在输出 JSON 前因 meta backfill 写失败而中断，导致状态查询
   不能稳定返回诊断。

   证据：

   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1133`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1163`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1164`
   - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1165`
   - `scripts/graphrag/batch-epub-workflow.mjs:8332`

9. manifest 与 checkpoint 聚合在 status 模式下基本抑制写入

   判定：PASS

   `loadManifest()` 在 status 模式下不会重建缺失 manifest；解析失败会
   抛出而不是 quarantine。`updateManifest()` 在 status 模式下不会写
   manifest 或 recovery summary。该部分符合 status 查询的只读方向。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:6020`
   - `scripts/graphrag/batch-epub-workflow.mjs:6026`
   - `scripts/graphrag/batch-epub-workflow.mjs:6096`
   - `scripts/graphrag/batch-epub-workflow.mjs:8124`
   - `scripts/graphrag/batch-epub-workflow.mjs:8325`

10. Type DD 必须覆盖 status-json 只读回归测试

    判定：FAIL

    Type DD 已有 YAML reader fault 与 checksum crash window 测试场景，
    但没有固定验收项证明 `--status-json` 在 checksum meta 缺失、pending
    meta、checksum 缺失或 stale temp 存在时不会创建、删除或 rename 任何
    durable 文件。现有验收标准只要求 status-json 展示状态，覆盖不足。

    证据：

    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1337`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1343`
    - `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1374`

## 阻塞问题

1. `--status-json` 不是严格只读

   status 入口在打印 JSON 前先执行 catalog 读取链路：

   `main()` -> `discoverItems()` -> `loadCatalogBySourceHash()` ->
   `withJsonFileLock()` -> `readDurableYamlAfterReconcileUnlocked()` ->
   `reconcileDurableYamlTargetUnlocked()`。

   该链路会写 lock，并可补写 `.sha256` 或 `.sha256.meta.json`。这与
   status 查询语义冲突，也是本次
   `books.yaml.sha256.meta.json` 写入 ENOENT 的直接设计缺口。

2. Type DD 未区分 repair reconcile 与 read-only inspect

   当前 Type DD 允许 reconcile 回填 checksum，但没有声明该权限只属于
   普通 runner 恢复模式。缺少模式边界后，reader 可调用同一 unlocked
   reconcile，导致状态查询具备修复副作用。

3. checksum meta 缺失未建模为独立 crash-window 状态

   `target_new_checksum_missing` 描述 `.sha256` 缺失，不足以覆盖
   `.sha256` 存在且匹配、`.sha256.meta.json` 缺失的状态。该状态应有
   独立 recovery decision，并明确 status-json 只能报告，不能补写。

4. sidecar lane 归属在 Type DD 中不完整

   `books.yaml.sha256.meta.json` 是 `books.yaml` 的 durable sidecar。
   Type DD 应声明所有 `.sha256` 与 `.sha256.meta.json` sidecar 继承
   primary target 的 lane、owner、timeout、lock 与 release 规则。当前
   文档只在 manifest lane 处局部提到 checksum sidecars。

## 建议的 Type DD 修改

1. 增加 status-json read-only contract

   建议在 observability 或 configuration contract 中增加：

   ```yaml
   statusJsonReadOnlyContract:
     mode: observer
     rule: >
       --status-json 必须严格只读。它只能读取 target、checksum、
       checksum meta、lock owner records、events、manifest 与 checkpoint，
       并把 durable state gap 投影为 diagnostics。它不得执行 repair、
       reconcile mutation、quarantine、event append、manifest rebuild、
       recovery summary 写入或 status cache 写入。
     forbiddenOperations:
       - acquire exclusive durable write lock or per-target lock
       - create or delete .lock files
       - create, rename or delete .tmp-* files
       - create or delete .owner.json files
       - write .sha256 files
       - write .sha256.meta.json files
       - quarantine or rename primary targets
       - append events.jsonl
       - write manifest.json, status.json or recovery-summary.json
     requiredProjection: >
       发现 durable gap 时仍应输出 redacted status JSON，并在
       durableStateFailures 中包含 targetLocator、localFailureClass、
       checksumRecoveryDecision、repairAllowed: false 与
       completedPublishRule: forbidden。
   ```

2. 在 durableWriteContract 中拆分 reconcile 模式

   建议补充：

   ```yaml
   reconcileModes:
     repairReconcile:
       rule: >
         可执行 temp cleanup、checksum backfill、checksum meta commit 与
         quarantine。必须满足 not status-json、持有 primary target 的
         writer lane、持有 per-target lock，并重新验证 fencing。
     readOnlyInspect:
       rule: >
         只读解析 target、checksum、checksum meta 与 lock owner evidence。
         不得调用任何会写入、rename、unlink、fsync parent 或 append event
         的函数。该模式用于 --status-json、status derivation 与只读
         recovery summary projection。
   ```

3. 明确 checksum 与 checksum meta 的状态矩阵

   建议在 `checksumCommit` 下增加：

   ```yaml
   checksumMetaStates:
     - state: target_checksum_match_meta_missing
       meaning: >
         target 内容有效，.sha256 存在且匹配，但 .sha256.meta.json 缺失。
       repairModeRecovery: >
         在 repairReconcile 中可补写 checksum meta，并记录
         durable_checksum_meta_backfilled。
       statusJsonRecovery: >
         不得补写。输出 durableStateFailures，设置
         checksumRecoveryDecision: metadata_backfill_required，
         repairAllowed: false。
     - state: target_checksum_missing
       meaning: >
         target 内容有效，但 .sha256 缺失。
       repairModeRecovery: >
         仅在 owner/generation/fencing evidence 可验证时补写 checksum。
       statusJsonRecovery: >
         不得补写。输出 target_new_checksum_missing diagnostics。
   ```

4. 声明 sidecar 继承 primary target mapping

   建议在 `targetMappingContract` 下增加：

   ```yaml
   sidecarInheritanceRule: >
     对任意 production durable target，`<target>.sha256` 与
     `<target>.sha256.meta.json` 必须继承 primary target 的 lane、owner、
     durableKind、laneTimeoutMs、releaseOn、preflight scope 与 per-target
     lock。sidecar 不得被视为独立 writer target，也不得落入不同 lane。
   ```

5. 增加 status-json 回归验收

   建议在 test matrix 中增加：

   ```yaml
   - case: status_json_catalog_checksum_meta_missing_read_only
     setup:
       - graph_vault/catalog/books.yaml exists and parses
       - graph_vault/catalog/books.yaml.sha256 exists and matches target
       - graph_vault/catalog/books.yaml.sha256.meta.json is absent
     command: batch runner --status-json
     evidence:
       - no .lock, .tmp-*, .owner.json, .sha256 or .sha256.meta.json is created
       - no events.jsonl, manifest.json, status.json or recovery-summary.json is written
       - stdout JSON includes durableStateFailures for books.yaml
       - checksumRecoveryDecision is metadata_backfill_required
       - repairAllowed is false
   - case: status_json_yaml_reader_no_unlocked_reconcile
     evidence:
       - status-json YAML read path uses readOnlyInspect
       - repairReconcile is not called
       - unlocked reconcile helpers are unreachable from observer mode
   ```

## 设计结论

当前设计和实现不足以支撑本次失败场景。普通恢复模式允许 durable
checksum 或 checksum meta 回填是合理的，但 `--status-json` 必须被定义为
严格只读 observer mode。Type DD 需要先补充 status-json read-only、
reconcile mode、checksum meta state 与 sidecar inheritance 不变量，然后
实现才能安全修复读路径。

最终判定：FAIL
