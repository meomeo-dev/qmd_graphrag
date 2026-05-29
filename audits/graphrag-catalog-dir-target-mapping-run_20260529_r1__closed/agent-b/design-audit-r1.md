# Design Audit R1 Agent B

## 结论

FAIL。

Type DD 已要求 YAML/JSON durable replace 执行文件 fsync、atomic rename
与父目录 fsync（parent directory fsync），并把目录 fsync 不确定性归类为
`durable_directory_fsync_unsupported` 或
`durable_directory_fsync_uncertain`。但是当前 `targetMapping` 只覆盖
文件级 primary target、部分通配文件 target 与隐式 sidecar，未把目录
flush 本身建模为可追溯的 durable target。因此 checksum meta sidecar
写入完成后，对 `graph_vault/catalog` 等 parent directory 执行 fsync 时，
实现无法从目录路径追溯到唯一 lane、owner 与 durable kind，真实 runner
报错 `durable target mapping missing: graph_vault/catalog` 符合设计缺口。

## 审计依据

- `targetMappingContract.rule` 要求每个生产持久化目标能从
  `targetMapping` 追溯到唯一 `lane`、`owner`、`durableKind`、
  `laneTimeoutMs` 与 `releaseOn`，但规则文本只禁止未列入 mapping 的
  durable YAML/JSON/SQLite 目标写入，未显式覆盖 directory fsync target。
- `derivedSidecarRule` 规定 checksum sidecar 与 checksum meta sidecar
  继承 primary target 的 lane、owner、durable mode 与 preflight scope，
  但没有规定 sidecar commit 的 parent directory fsync 继承同一 mapping，
  也没有定义 `directoryTargetLocator`。
- `targetMapping` 条目均为文件或文件通配模式，例如
  `graph_vault/catalog/books.yaml`、
  `graph_vault/catalog/batch-runs/{runId}/manifest.json`、
  `graph_vault/catalog/batch-runs/{runId}/items/{itemId}.json`、
  `graph_vault/books/{bookId}/job.yaml`。未列出
  `graph_vault/catalog`、batch run root、`items`、`provider-slots`、
  `subprocesses`、`book-leases`、book root、book `runs` 等目录 target。
- `platformFsyncBoundary.requiredDiagnostics` 只要求 `targetLocator`、
  `operationId`、`tempId`、`fsyncTarget`、`fsyncErrno`、
  `fsyncPlatform`、`durableMode` 与 `completedPublishRule`。该字段集不足以
  区分 primary target、sidecar target 与 directory target，也不足以证明
  目录 fsync 由哪个 `targetMapping` owner 与 lane 承担。
- durable failure event、status-json 与 recovery summary 对 fsync boundary
  的要求主要保留 `fsyncTarget` 与 `fsyncErrno`，没有要求保留
  `directoryTargetLocator`、`primaryTargetLocator`、`targetMappingOwner`、
  `lane` 与 `durableKind`。
- `statusJsonReadOnlyContract` 确立了 read-only 行为，但只读诊断仍围绕
  target、checksum、checksum meta、lock、temp 与 events 展开，没有声明读取
  或投影目录 fsync target 时必须使用同一目录 mapping 规则。
- `repairWriter` 可执行 checksum backfill、checksum meta backfill 与
  quarantine，但设计未要求 repair writer 在写 sidecar 或 quarantine object
  后，以 directory scope mapping 记录 parent directory fsync evidence。

## 设计缺口

1. `targetMappings` 未覆盖目录级 durable operation。

   目录 fsync 是 durable replace commit boundary 的组成部分，不是普通
   派生细节。当前设计把 parent directory 当作 `fsyncTarget` 字段值处理，
   但没有让该路径进入 target mapping 闭包（mapping closure）。因此
   `graph_vault/catalog` 这类目录在 sidecar commit 后会成为 unmapped target。

2. writer lane scope 未显式包括目录 scope。

   `catalogWriterLane` 保护 catalog 文件，`manifestWriterLane` 保护 batch run
   下 manifest/status/lock/provider slot 等文件，`checkpointWriterLane` 保护
   book checkpoint 与 item checkpoint 文件。三者均未声明对应 parent
   directory fsync 由同一 lane 串行化并持有同一 owner evidence。

3. directory fsync evidence 字段不闭合。

   现有证据可说明发生了哪个 syscall 或 fsync target，但不能无损证明：
   目录 target 是哪个 primary target 或 sidecar commit 的 durable boundary、
   由哪个 mapping owner 负责、持有哪个 lane、采用哪个 durable kind。缺少
   这些字段时，status-json、event 与 recovery summary 无法稳定重建失败语义。

4. status-json/read-only 与 repair writer 未绑定目录 mapping 规则。

   只读 status 必须不能修复目录 mapping 缺口，也不能把目录路径降级为 unknown。
   repair writer 在回填 checksum meta sidecar 时会触发新的 parent directory
   fsync；如果该目录仍未映射，repair 本身会复现同类失败。

## 必须修改项

1. 扩展 `targetMappingContract`，明确 directory fsync target 是生产 durable
   target。

   规则应要求每个 primary YAML/JSON target、checksum sidecar、checksum meta
   sidecar、quarantine target、lock/owner/temp lifecycle 相关写入，在执行
   parent directory fsync 前，必须能从 `targetMapping` 或显式派生的
   directory mapping 追溯到唯一 `lane`、`owner`、`durableKind`、
   `laneTimeoutMs` 与 `releaseOn`。

2. 为目录 target 定义 durable kind 与派生规则。

   建议增加 `durableKind: directory`，并规定目录 mapping 可由 primary
   target 派生，但派生结果必须可观测、可校验、可用于 preflight scope。
   对 sidecar commit，directory mapping 必须继承 primary target 的 lane、
   owner、timeout、release policy 与 durable mode，同时记录 primary 与 sidecar
   的 locator。

3. 补齐 catalog、manifest 与 checkpoint lane 的目录 scope。

   至少需要覆盖以下目录类别：

   - `catalogWriterLane`：`graph_vault/catalog` 以及 catalog-owned 通配 target
     的 parent directories，例如 `graph_vault/catalog/provider-requests`。
   - `manifestWriterLane`：
     `graph_vault/catalog/batch-runs/{runId}`、
     `graph_vault/catalog/batch-runs/{runId}/provider-slots`、
     `graph_vault/catalog/batch-runs/{runId}/subprocesses`，以及 manifest lane
     保护文件的 parent directories。
   - `checkpointWriterLane`：
     `graph_vault/books/{bookId}`、`graph_vault/books/{bookId}/runs`、
     `graph_vault/books/{bookId}/qmd`、
     `graph_vault/books/{bookId}/output`、
     `graph_vault/catalog/batch-runs/{runId}/items`、
     `graph_vault/catalog/batch-runs/{runId}/book-leases`，以及 checkpoint lane
     保护文件的 parent directories。

   若目录可由通配 target 动态派生，Type DD 必须明确派生边界，避免实现维护
   与 `targetMapping` 分离的手写目录清单。

4. 扩展 directory fsync 失败证据字段。

   `platformFsyncBoundary.requiredDiagnostics`、durable failure event、
   command check、item checkpoint、status-json 与 recovery summary 对目录
   fsync 失败必须至少保留：

   - `directoryTargetLocator`
   - `primaryTargetLocator`
   - `sidecarTargetLocator`，仅 sidecar commit/quarantine 相关时必填
   - `targetMappingOwner`
   - `lane`
   - `durableKind`
   - `durableMode`
   - `operationId`
   - `tempId`
   - `fsyncTarget`
   - `fsyncErrno`
   - `fsyncPlatform`
   - `completedPublishRule`

   对 checksum meta sidecar backfill，`primaryTargetLocator` 必须指向原 primary
   YAML/JSON target，`sidecarTargetLocator` 必须指向
   `{target}.sha256.meta.json`，`directoryTargetLocator` 必须指向被 fsync 的
   parent directory。

5. 扩展 `statusJsonReadOnlyContract`。

   `--status-json` 发现目录 fsync evidence 缺失、目录 mapping 缺失或目录
   target 无法追溯到 primary target 时，必须输出 fail-closed durable
   diagnostic。该路径不得创建 mapping、不得 backfill sidecar、不得写入
   status/recovery summary，也不得把目录 target 归类为 unmapped unknown。

6. 扩展 repair writer 契约。

   normal resume、migrate-only 与 explicit repair 在执行 checksum sidecar、
   checksum meta sidecar、quarantine 或 temp cleanup 写入时，必须使用同一
   directory mapping 规则。repair writer 的目录 fsync 失败必须与普通 durable
   replace 一样进入 `local_state_integrity` 与 `stop_until_fixed`，并保留完整
   directory evidence。

7. 更新验收矩阵。

   `directory_fsync_boundary_uncertain` 用例目前只要求 `fsyncTarget` 与
   `fsyncErrno`。应新增针对 checksum meta sidecar parent directory fsync 的
   用例，并要求 event、checkpoint、status-json 与 recovery summary 都保留
   directory mapping 字段。

## 验收条件

1. Type DD 中每个 durable YAML/JSON primary target 均能推导出其 checksum
   sidecar、checksum meta sidecar 与 parent directory fsync target 的唯一
   mapping。`graph_vault/catalog` 不再是 unmapped durable target。

2. `catalogWriterLane`、`manifestWriterLane` 与 `checkpointWriterLane` 的
   `protects` 或 mapping 派生规则明确覆盖目录 scope，并说明目录 fsync 与其
   primary/sidecar commit 使用同一 lane 串行化。

3. directory fsync failure 的所有观测面均包含
   `directoryTargetLocator`、`primaryTargetLocator`、`targetMappingOwner`、
   `lane` 与 `durableKind`；sidecar 相关失败还包含
   `sidecarTargetLocator` 与 `sidecarKind`。

4. `--status-json` 对目录 mapping 缺失和目录 fsync evidence 缺失保持严格
   read-only，只输出 fail-closed diagnostic，不创建、修改或修复 state root
   内任何文件。

5. repair writer 对 checksum meta backfill、checksum backfill、quarantine
   与 temp cleanup 的 parent directory fsync 使用同一 mapping 规则。任何目录
   mapping 缺失或 fsync 不确定均阻止 completed 发布。

6. 验收测试或设计验收条目覆盖以下场景：

   - checksum meta sidecar 写入后 fsync `graph_vault/catalog`。
   - item checkpoint sidecar 写入后 fsync
     `graph_vault/catalog/batch-runs/{runId}/items`。
   - book checkpoint sidecar 写入后 fsync `graph_vault/books/{bookId}` 或
     `graph_vault/books/{bookId}/runs`。
   - `--status-json` 遇到缺失 checksum meta 与缺失 directory mapping 时保持
     read-only。
   - repair writer 回填 checksum meta sidecar 时发生 directory fsync failure，
     并在 checkpoint、event、status-json 与 recovery summary 中保留完整字段。
