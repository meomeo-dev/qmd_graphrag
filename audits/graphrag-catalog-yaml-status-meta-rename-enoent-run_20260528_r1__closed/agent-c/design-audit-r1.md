# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R1

## 结论

FAIL

当前 Type DD 已覆盖 durable replace、checksum crash window、rename `ENOENT`
分类、以及 checkpoint、event、status-json、recovery summary 四个观测面的一致性。
但它没有把 `--status-json` 的只读边界（no-mutation boundary）和 checksum meta
缺失读取语义绑定起来，也没有规定当只读 status-json 路径触发
`books.yaml.sha256.meta.json` backfill 且 backfill rename `ENOENT` 时，如何在不
写 checkpoint、event、status.json 或 recovery-summary.json 的前提下提供等价
诊断。

因此，本次真实失败仍暴露设计缺口：`--status-json` 既被测试和用户语义理解为
只读状态查询，又可能通过 durable checksum meta backfill 写入
`graph_vault/catalog/books.yaml.sha256.meta.json`。Type DD 未明确这是禁止行为、
允许的修复行为，还是必须显式切换到 repair-only 的行为。

## 审计范围

- 失败入口：`--status-json`
- 失败阶段：`status-json`
- 错误：`DurableStateError`
- local failure class：`durable_temp_rename_enoent`
- 目标：`graph_vault/catalog/books.yaml.sha256.meta.json`
- 关注面：可验证性与观测设计

未运行真实 EPUB runner，未读取或打印 `.env`，未修改源码、测试或设计文档。

## 固定设计审计基准

| 基准 | 结论 | 说明 |
| --- | --- | --- |
| C01 status-json no-mutation contract | FAIL | Type DD 只说 `status-only` 例外不能把缺失产物标为完成，未定义 `--status-json` 是否绝对只读、是否允许 checksum meta backfill、允许时可写哪些文件。现有测试断言 status-json 不改 item checkpoint 且不写 recovery-summary，但设计未把该行为提升为完整契约。 |
| C02 catalog YAML read authority | PASS | Type DD 明确 catalog 目标在 `targetMapping` 中，读前 reconcile、checksum 校验与 durable state preflight 必须使用共享 durable contract，禁止裸读后作为可提交状态。 |
| C03 missing checksum meta read semantics | FAIL | `checksumCommit.missingChecksumRule` 允许 meta 缺失时按 legacy onboarding 记录 `target_new_checksum_missing` 并回填 checksum，但未区分 normal run、repair-only 与 `--status-json` 只读查询。缺少“读时可投影缺失 meta 诊断但不得 backfill”的模式规则。 |
| C04 checksum meta target coverage | FAIL | Type DD 未显式把 `graph_vault/catalog/books.yaml.sha256.meta.json` 作为 books catalog 的派生 sidecar target 建模，也未说明 sidecar 的 sidecar 是否禁止生成。对 `*.sha256.meta.json` 的读写边界仍依赖泛化描述。 |
| C05 rename ENOENT classification | PASS | Type DD 明确 atomic rename `ENOENT` 必须是 `local_state_integrity`、`durable_temp_rename_enoent`、`stop_until_fixed`，并必须选择 `renameCause`，不得降级为 unknown、provider transient 或业务失败。 |
| C06 status-json failure projection | FAIL | Type DD 要求 status-json 包含 durable diagnostics，但没有规定 status-json 命令自身在读取 catalog sidecar 失败时的 stdout/stderr/exit code 形态，也没有要求输出 JSON 诊断对象而非只抛错。 |
| C07 four-surface consistency boundary | FAIL | Type DD 要求 checkpoint、event、status-json、recovery summary 四个观测面一致，但 `--status-json` no-mutation 模式无法写前三类持久证据。设计缺少只读观测面的等价降级规则，例如 stdout JSON 内嵌 `durableStateFailures`，并声明不会写 event/checkpoint/recovery summary。 |
| C08 recovery summary status-json semantics | FAIL | recovery summary 被定义为派生目标，也被普通运行写入；但 status-json 测试期望不创建 `recovery-summary.json`。Type DD 未明确 status-json 是“读取并输出 recovery summary projection”还是“可 durable replace recovery-summary.json”。 |
| C09 regression test specification | FAIL | durable acceptance matrix 覆盖 checkpoint rename ENOENT、checksum crash window、YAML reader preflight fault，但未要求测试 status-json 读取 `books.yaml` 时缺失 meta、meta backfill 被禁用、以及 backfill rename ENOENT 的观测输出。 |
| C10 post-R10 scenario binding | FAIL | R10 已通过 mapped YAML preflight 与 checkpoint rename ENOENT，但新失败发生在 catalog books.yaml checksum meta backfill 的 status-json 读路径。Type DD 未新增专门场景，无法保证实现审计以本失败为验收目标。 |

## 阻塞问题

### B1. `--status-json` 的只读边界未被 Type DD 明确

真实命令带 `--status-json`，用户意图是状态查询（status query）。现有测试也已经
验证普通 status-json 不改 item checkpoint、不创建 durable recovery summary。
但 Type DD 没有明确：

- `--status-json` 是否禁止任何 stateRoot mutation；
- 禁止范围是否包括 `.sha256`、`.sha256.meta.json`、lock、temp、recovery log；
- 若发现 legacy target 缺少 checksum meta，是否只能报告诊断，不能回填；
- 若需要回填，是否必须要求显式 repair-only 或 normal resume 模式。

缺少该边界会使只读状态查询触发 durable replace，从而复现本次
`books.yaml.sha256.meta.json` rename `ENOENT`。

### B2. 缺失 checksum meta 的读取语义与 backfill 权限混在一起

Type DD 当前允许 legacy onboarding 下回填 checksum meta，但没有按命令模式拆分
读语义。对 status-json，合理语义应至少区分：

- target 有效、checksum 和 meta 都存在：正常读取；
- target 有效、checksum 存在但 meta 缺失：只读模式输出
  `checksumRecoveryDecision: target_new_checksum_missing` 或等价诊断；
- target 有效、checksum 缺失或不匹配：只读模式输出
  `local_state_integrity`，不得修复；
- normal/repair 模式才可持锁 backfill，并记录 durable event。

当前设计未阻止 status-json 对 missing meta 执行写入 backfill。

### B3. status-json 自身失败时的观测面未定义

rename `ENOENT` 的事件、checkpoint 与 recovery-summary 字段要求已经存在，但
本次失败发生在 status-json 读取/投影阶段。此时如果命令必须保持 no-mutation，
就不能依赖写入：

- `events.jsonl`
- item checkpoint
- `status.json`
- `recovery-summary.json`

Type DD 未定义这种情况下的替代观测面。最小要求应是 stdout 仍输出可解析 JSON
诊断，或明确 stderr/exit code 合同；否则自动化系统只能看到异常字符串。

### B4. `books.yaml.sha256.meta.json` 未作为一等 sidecar 目标验收

targetMapping 覆盖 `graph_vault/catalog/books.yaml`，并泛称 durable checksum
sidecars，但没有把 catalog YAML 的 `.sha256.meta.json` lifecycle 写清楚。尤其缺少：

- sidecar target locator 归属原 target，不作为新的 primary target 递归生成
  `.sha256.meta.json.sha256`；
- sidecar backfill 的 lane、lock、temp、event 与 failure fields；
- status-json 只读路径禁止 sidecar durable replace 的规则；
- catalog books.yaml 的 legacy meta onboarding 验收。

本次失败目标正是 sidecar meta 文件，泛化规则不足以防回归。

## 建议的 Type DD 修改

### 1. 新增 `statusJsonMode` 契约

建议在 `configurationContract.cli` 或 `recoveryReconciliation` 下新增：

```yaml
statusJsonMode:
  mutationPolicy: no_state_root_mutation
  forbiddenWrites:
    - checkpoint
    - events.jsonl
    - manifest.json
    - status.json
    - recovery-summary.json
    - durable target
    - durable checksum sidecars
    - durable locks
    - durable temp files
  allowedReads:
    - validated durable target read
    - non-mutating checksum/meta inspection
    - non-mutating recovery projection
  missingChecksumMetaBehavior: report_only
  repairEscalation: >
    checksum or checksum meta backfill requires explicit repair-only or normal
    resume mode; status-json must not perform backfill.
```

### 2. 拆分 checksum meta missing 的命令模式语义

在 `durableWriteContract.checksumCommit.missingChecksumRule` 下补充：

```yaml
readOnlyMode:
  appliesTo:
    - --status-json
  behavior: >
    当 target 有效但 checksum meta 缺失时，读取端只能输出
    checksumRecoveryDecision=target_new_checksum_missing 与
    local diagnostic projection，不得创建 lock、temp、checksum 或 meta sidecar。
  completedPublishRule: forbidden_when_evidence_incomplete
repairMode:
  behavior: >
    normal resume 或 explicit repair-only 可在持有 per-target lock 时 backfill
    checksum meta，并记录 durable_checksum_backfilled 或 durable_replace_failed。
```

### 3. 定义 status-json 自身 durable failure 输出

在 `observability.requiredStatusJsonFields` 或相邻位置补充：

```yaml
statusJsonSelfFailure:
  exitCode: non_zero
  stdoutContract: parseable_json_when_possible
  requiredFields:
    - schemaVersion
    - runId
    - status
    - failureKind
    - localFailureClass
    - recoveryDecision
    - failedStage
    - targetLocator
    - tempId
    - operationId
    - failedSyscall
    - errno
    - renameCause
    - completedPublishRule
  mutationRule: >
    If --status-json is no-mutation, these diagnostics are emitted in the
    command output and must not require writing checkpoint, event, status.json
    or recovery-summary.json.
```

### 4. 明确 checksum meta sidecar lifecycle

建议在 `targetMappingContract` 或 `checksumCommit` 中补充：

```yaml
checksumMetaSidecars:
  primaryTargetRelation: derived_sidecar_of_target
  examples:
    - target: graph_vault/catalog/books.yaml
      checksum: graph_vault/catalog/books.yaml.sha256
      meta: graph_vault/catalog/books.yaml.sha256.meta.json
  sidecarRecursionRule: >
    checksum meta files are not primary durable targets and must not generate
    secondary checksum sidecars such as .sha256.meta.json.sha256.
  writePermission:
    normal_resume: allowed_with_per_target_lock
    repair_only: allowed_with_per_target_lock
    status_json: forbidden
```

### 5. 增加专门验收矩阵项

在 `validationRequirements.durableStateAcceptanceMatrix` 增加：

```yaml
- case: status_json_catalog_missing_checksum_meta
  evidence:
    - books.yaml content is read through durable validation
    - missing books.yaml.sha256.meta.json is reported as
      target_new_checksum_missing
    - no lock, temp, checksum or meta file is created
    - no events.jsonl, checkpoint or recovery-summary.json is mutated
    - stdout status JSON includes durableStateFailures entry
- case: status_json_checksum_meta_backfill_rename_enoent
  evidence:
    - injected rename ENOENT on books.yaml.sha256.meta.json is classified as
      durable_temp_rename_enoent when backfill is attempted outside status-json
    - status-json mode does not attempt the backfill
    - if a failure is observed while projecting, output includes targetLocator,
      tempId, operationId, failedSyscall, errno and renameCause
```

## 必须新增的测试

1. `--status-json` 读取已有 `books.yaml`，当 `books.yaml.sha256.meta.json` 缺失
   时，不创建 meta、temp、lock、event、checkpoint 或 recovery summary，并在 stdout
   JSON 中报告 checksum meta 缺失诊断。

2. `--status-json` 读取 `books.yaml` 时若 `.sha256` 不匹配或 meta 冲突，命令输出
   `local_state_integrity`、`stop_until_fixed` 与 target locator，但不执行
   quarantine 或 backfill 写入。

3. normal/repair 模式对 `books.yaml.sha256.meta.json` backfill 注入 rename
   `ENOENT`，断言 `durable_temp_rename_enoent`、`renameCause`、`targetLocator`、
   `tempId`、`operationId`、`failedSyscall` 与 `errno` 出现在 event、checkpoint、
   recovery summary 或等价持久观测面。

4. `--status-json` 同样设置 rename `ENOENT` test hook，但因 no-mutation 不应触发
   backfill，也不应触发 hook；命令应完成状态投影或输出只读诊断。

5. catalog sidecar hygiene 测试：`books.yaml.sha256.meta.json` 不会被当作 primary
   durable target 递归生成 `.sha256` 或 `.sha256.meta.json` 辅助文件。

## 最小通过条件

复审通过前，需要先在 Type DD 中完成以下设计闭合：

1. 明确 `--status-json` 是 no-mutation 模式，或明确改名/拆分为 repair status 模式。
2. 明确 status-json 下 checksum meta 缺失只能报告，不能 backfill。
3. 明确 status-json 自身 durable failure 的 JSON 输出合同。
4. 明确 `books.yaml.sha256.meta.json` 的 sidecar lifecycle 和禁止递归 sidecar 规则。
5. 把本次 `books.yaml.sha256.meta.json` rename `ENOENT` 加入验收矩阵与测试清单。
