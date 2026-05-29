# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R3

## 结论

PASS。

R3 Type DD 已新增 `checksumCommit.sidecarQuarantineDecisionTable`、
`sidecarQuarantineRule`，并在 `durableStateAcceptanceMatrix` 中新增
`sidecar_only_quarantine_boundary`。新增设计把 primary target、checksum
sidecar 与 checksum meta sidecar 的隔离对象（quarantine object）拆成可验证
状态表，关闭了 R2 Agent B 的 sidecar-only primary quarantine boundary 阻塞点。

允许进入实现（implementation may proceed）。实现阶段仍必须保持
`--status-json` 的只读观测入口（read-only observer）语义：不得获取写锁、
不得 backfill、不得 quarantine、不得写 event/status/recovery summary。

## 审计范围

- 复审对象：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 对照材料：
  `agent-c/design-audit-r2.md` 与 `agent-b/design-audit-r2.md`
- 关注问题：
  quarantine decision table 是否可测试；是否削弱 status-json no-mutation、
  status-json 自身 failure projection、missing checksum meta read semantics。
- 限制：
  未运行真实 EPUB runner，未读取或打印 `.env`，未修改源码、测试或设计文档。

## 固定设计审计基准

| 基准 | 结论 | R3 复审意见 |
| --- | --- | --- |
| C01 status-json no-mutation contract | PASS | `statusJsonReadOnlyContract` 仍声明 `--status-json` 是 `observer`，`mutationPolicy` 为 `no_state_root_mutation`。`reconcileModes.readOnlyObserver` 继续禁止 lock、temp、owner、checksum、checksum meta、quarantine target 与 event 写入。新增 quarantine 表只约束 repair writer，不授予 status-json 写权限。 |
| C02 catalog YAML read authority | PASS | `books.yaml` 仍作为 durable primary target 通过 target mapping 与 durable validation 读取；checksum 与 checksum meta 仍是派生 sidecar。新增 sidecar quarantine 规则没有绕过 catalog YAML 的读前校验或 durable preflight。 |
| C03 missing checksum meta read semantics | PASS | `target_valid_checksum_matches_meta_missing` 明确 primary 与 checksum 保持不变，repair writer 可 backfill meta；status-json action 为 `read_only_degraded`，recovery decision 为 `metadata_missing_read_only`。这保持了缺失 meta 只读投影（read-only projection）语义，没有退回到 status-json backfill。 |
| C04 checksum meta target coverage | PASS | sidecar 仍被建模为 primary target 的派生对象，`sidecarQuarantineDecisionTable` 进一步把 meta missing、meta invalid、meta conflict 与 checksum sidecar invalid 拆成独立状态。覆盖范围比 R2 更明确，且没有引入 sidecar 递归生成规则。 |
| C05 rename ENOENT classification | PASS | `checksum_meta_backfill_rename_enoent` 仍要求 repair writer 的 checksum meta sidecar rename `ENOENT` 分类为 `local_state_integrity`、`durable_temp_rename_enoent` 与 `stop_until_fixed`。新增表没有降低 rename `ENOENT` 的 fail-closed 分类。 |
| C06 status-json failure projection | PASS | `selfFailureProjection` 仍要求 status-json 自身读到 fail-closed durable failure 时尽量输出可解析 JSON，并包含 failureKind、localFailureClass、recoveryDecision、failedStage、targetLocator、tempId、operationId、failedSyscall、errno、renameCause 与 completedPublishRule。新增 quarantine 表没有要求该投影依赖持久写入。 |
| C07 four-surface consistency boundary | PASS | 四观测面一致性仍保留；status-json no-mutation 场景继续以 stdout JSON 的 durable diagnostics 作为只读等价观测面。新增 `sidecar_only_quarantine_boundary` 要求 event、status-json 或 recovery summary 命名隔离对象为 sidecar 或 primary_bundle，使观测对象更精确。 |
| C08 recovery summary status-json semantics | PASS | status-json 仍被禁止写 `recovery-summary.json`。新增 quarantine evidence 可出现在 event、status-json 或 recovery summary，但没有把 recovery summary 写入变成 status-json 的必要条件。 |
| C09 regression test specification | PASS | `durableStateAcceptanceMatrix` 保留 `status_json_catalog_missing_checksum_meta` 与 `status_json_checksum_meta_backfill_rename_enoent`，并新增 `sidecar_only_quarantine_boundary`。新 case 覆盖 meta invalid/conflict 只隔离 meta sidecar、checksum sidecar invalid 只隔离 checksum/meta sidecar、primary invalid 或 checksum mismatch 才隔离 primary bundle。测试矩阵已可直接断言隔离对象。 |
| C10 post-R10 scenario binding | PASS | 本事故的 status-json meta missing 与 repair writer meta rename `ENOENT` 绑定仍保留；R3 新增 quarantine decision table 把 R2 B 的剩余阻塞项绑定到验收矩阵，防止有效 `books.yaml` 因 sidecar-only 污染被错误隔离，也防止 primary 不可信时只修 sidecar 后继续读取。 |

## R3 重点确认

1. 新增 quarantine decision table 可验证。

   `sidecarQuarantineDecisionTable` 至少覆盖以下状态，并为每个状态规定
   primary、checksum sidecar、meta sidecar 的动作：

   - target 有效、checksum 匹配、meta 缺失：keep primary/checksum，
     repair writer 可 backfill，status-json 只读 degraded。
   - target 有效、checksum 匹配、meta invalid 或 conflict：keep
     primary/checksum，只 quarantine meta sidecar。
   - target 有效、checksum 缺失：keep primary，repair writer 才可 backfill。
   - target 有效但 checksum mismatch：quarantine primary bundle。
   - target invalid 或 unparseable：quarantine primary bundle。
   - checksum sidecar invalid 或 unparseable：keep valid primary，只 quarantine
     checksum/meta sidecar。

   这些状态已映射到 `sidecar_only_quarantine_boundary` 验收项，测试可以通过
   文件系统快照、event/status-json/recovery summary 字段和 quarantine object
   类型直接验证。

2. 未削弱 status-json no-mutation。

   Type DD 仍在两个位置限制 status-json：`readOnlyObserver` 禁止创建
   quarantine target，`statusJsonReadOnlyContract` 禁止 repair、writable
   reconcile、quarantine、event append、status cache 与 recovery summary 写入。
   新表中的 repair/quarantine 动作不适用于 status-json。

3. 未削弱 status-json 自身 failure projection。

   新增 sidecar quarantine evidence 只补充隔离对象语义，不移除
   `selfFailureProjection` 的可解析 JSON 输出要求，也不要求通过 checkpoint、
   event、status.json 或 recovery-summary.json 才能表达 status-json 自身失败。

4. 未削弱 missing checksum meta read semantics。

   meta missing 仍是 `metadata_missing_read_only`。status-json 只能报告
   `read_only_degraded` diagnostic；checksum meta backfill 仍限于 normal
   resume、migrate-only 或显式 repair command，并且必须持有 per-target lock。

## 剩余阻塞问题

无剩余设计阻塞问题。

实现审计阶段需重点验证：

1. status-json 缺失 checksum meta 时，文件系统无 lock、temp、checksum、
   checksum meta、event、checkpoint、status 或 recovery-summary 变更。
2. meta invalid/conflict 且 target/checksum 匹配时，只隔离 meta sidecar，
   primary target 与 checksum sidecar 保持原位。
3. checksum sidecar invalid 且 target 有效时，只隔离 checksum/meta sidecar，
   不隔离 primary target。
4. target invalid 或 checksum mismatch 时，必须隔离 primary bundle，不能只修
   sidecar 后继续读取。
5. repair writer 的 checksum meta sidecar rename `ENOENT` 仍输出
   primaryTargetLocator、sidecarTargetLocator、sidecarKind、tempId、
   operationId、failedSyscall、errno 与 renameCause。

## 是否允许进入实现

允许进入实现。

当前 Type DD 已把 quarantine 对象选择、status-json 只读投影、checksum meta
缺失读取语义与 rename `ENOENT` fail-closed 观测面绑定为可测试合同。R3 结论为
PASS。
