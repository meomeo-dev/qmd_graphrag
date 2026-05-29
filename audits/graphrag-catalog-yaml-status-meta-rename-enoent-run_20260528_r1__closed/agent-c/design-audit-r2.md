# GraphRAG Catalog YAML Status Meta Rename ENOENT 设计审计 R2

## 结论

PASS。

R2 Type DD 已把 R1 的核心阻塞项提升为可验证合同（verifiable
contract）：`--status-json` 被定义为严格只读观测入口（read-only
observer），checksum meta 缺失被拆分为只读投影与 repair writer 回填两种模式，
checksum meta backfill rename `ENOENT` 被纳入 crash window，catalog
sidecar 继承规则和 sidecar evidence 已固定，且 durable acceptance matrix
新增了本事故对应的两项验收场景。

允许进入实现（implementation may proceed）。实现阶段必须只按 Type DD
落地，不得把 status-json 读路径复用到 writable reconcile/backfill。

## 审计范围

- 复审对象：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 关注问题：
  status-json no-mutation 行为、缺失 checksum meta 的读取语义、
  rename `ENOENT` 的输出/观测面、必须新增测试是否已在 Type DD 固定。
- 限制：
  未运行真实 EPUB runner，未读取或打印 `.env`，未修改源码、测试或设计文档。

## 固定设计审计基准

| 基准 | 结论 | R2 复审意见 |
| --- | --- | --- |
| C01 status-json no-mutation contract | PASS | Type DD 已新增 `statusJsonReadOnlyContract`，声明 `--status-json` 是 `observer`，`mutationPolicy` 为 `no_state_root_mutation`，并禁止 lock、temp、owner、checksum、checksum meta、event、manifest、status、recovery summary 等写入。 |
| C02 catalog YAML read authority | PASS | `books.yaml` 仍在 `targetMapping` 中，且 `derivedSidecarRule` 使其 checksum 与 checksum meta sidecar 继承同一 durable 边界。R2 未削弱 catalog YAML 的 durable validation 要求。 |
| C03 missing checksum meta read semantics | PASS | `checksumCommit.reconcileModes.readOnlyObserver` 与 `checksum_meta_missing` crash window 已明确：target 与 checksum 匹配但 checksum meta 缺失时，status-json 只能投影 `metadata_missing_read_only`，不得获取写锁或 backfill。 |
| C04 checksum meta target coverage | PASS | `derivedSidecarRule` 明确 `{target}.sha256` 与 `{target}.sha256.meta.json` 是 primary target 的派生 sidecar，继承 lane、owner、timeout、releaseOn、durableMode 与 preflight scope，并禁止 sidecar 递归生成 `.sha256.meta.json.sha256`。 |
| C05 rename ENOENT classification | PASS | rename `ENOENT` 仍固定为 `local_state_integrity`、`durable_temp_rename_enoent`、`stop_until_fixed`，且 `checksum_meta_backfill_rename_enoent` 明确 repair writer 对 checksum meta sidecar 写入失败时必须 fail-closed。 |
| C06 status-json failure projection | PASS | `statusJsonReadOnlyContract.selfFailureProjection` 要求 status-json 自身读到 fail-closed durable failure 时尽量输出可解析 JSON，包含 failureKind、localFailureClass、recoveryDecision、failedStage、targetLocator、tempId、operationId、failedSyscall、errno、renameCause 与 completedPublishRule，且不依赖持久写入。 |
| C07 four-surface consistency boundary | PASS | R2 保留四观测面一致性要求，同时为 no-mutation status-json 增加只读等价投影规则。checkpoint、event、status.json、recovery-summary 不可写时，stdout JSON 内的 durable diagnostics 成为 status-json 的观测面。 |
| C08 recovery summary status-json semantics | PASS | `forbiddenOperations` 明确禁止 status-json 写 `recovery-summary.json`，同时 `selfFailureProjection` 明确诊断不得依赖写 recovery summary。R1 中“status-json 是否可 durable replace recovery summary”的歧义已消除。 |
| C09 regression test specification | PASS | `durableStateAcceptanceMatrix` 已新增 `status_json_catalog_missing_checksum_meta`，要求不创建、删除或 rename lock、temp、checksum、checksum meta、event、checkpoint、status、recovery-summary，并要求输出 durable diagnostics 与 `repairAllowed false`。 |
| C10 post-R10 scenario binding | PASS | `status_json_checksum_meta_backfill_rename_enoent` 已把本事故绑定到验收矩阵：status-json 不触发 checksum meta backfill；repair writer 上的 checksum meta sidecar rename `ENOENT` 必须分类为 `durable_temp_rename_enoent` 与 `stop_until_fixed`，并输出 primary/sidecar locator、sidecarKind、tempId、operationId、failedSyscall、errno、renameCause。 |

## 剩余阻塞问题

无剩余设计阻塞问题。

实现审计阶段仍需重点验证以下事项，但它们不阻塞进入实现：

1. status-json 代码路径必须完全绕开 writable reconcile、checksum backfill、
   checksum meta backfill、temp cleanup、stale lock recovery 与 quarantine。
2. `metadata_missing_read_only` 必须进入 status-json 的 durable diagnostics，
   且包含 `repairAllowed: false`。
3. 缺失 checksum meta 的 status-json 测试必须用文件系统快照或等价断言证明：
   无 lock、temp、checksum、checksum meta、event、checkpoint、status 或
   recovery-summary 文件被创建、删除或 rename。
4. repair writer 的 checksum meta sidecar rename `ENOENT` 注入测试必须验证
   sidecar evidence 字段完整，并确认 primary target 不被隔离。

## 是否允许进入实现

允许进入实现。

进入实现的条件是保持 R2 Type DD 的模式分离：status-json 只做只读检查与 JSON
诊断投影；normal resume、migrate-only 或显式 repair command 才能在持有
per-target lock 时执行 checksum/checksum meta backfill 或 quarantine。
