# Design Audit R5 Agent A

结论：PASS

审计对象：`docs/architecture/graphrag-parallel-runner.type-dd.yaml`。

## 关键核对结果

1. R4 唯一阻塞项已闭合。`statusJsonReadOnlyContract.selfFailureProjection`
   明确规定：对 directory fsync boundary，self failure JSON 必须复用
   `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 的完整字段集。

2. self failure JSON 的字段要求已覆盖 R4 缺口。该段明确列出
   `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`unavailableFieldSentinels when fsyncErrno is
   sentinel`，并规定不得因无法写入 checkpoint、event、status.json 或
   recovery-summary.json 而降级或省略 sentinel 字段。

3. R1-R4 的 fsync boundary 观测面未回退。以下载体仍保留
   directory fsync boundary 所需字段：
   - item checkpoint：保留 `directoryTargetLocator`、primary/sidecar
     locator、`sidecarKind`、`lane`、`targetMappingOwner`、
     `directoryDurableKind`、`primaryDurableKind`、`fsyncTarget`、
     `fsyncPlatform`、`fsyncErrno` 与 sentinel 投影。
   - subprocess typed envelope：保留 lane、owner、directory/primary durable
     kind、primary/sidecar locator、`sidecarKind`、fsync 三元组与 sentinel。
   - event schema：通用事件条件字段仍包含 directory fsync boundary 字段。
   - durable failure event：`fsyncBoundary` 条件字段仍包含完整字段集。
   - command check：子进程 durable failure 字段仍包含完整 fsync boundary 字段。
   - status-json entry：`requiredForFsyncBoundary` 作为 canonical 字段集存在。
   - recovery summary：仍要求 lane、owner、directory/primary durable kind、
     primary/sidecar locator、`sidecarKind`、fsync 三元组、sentinel 与
     `completedPublishRule`。

4. `graph_vault/dspy` 递归 scope 未回退。目录 fsync scope 明确覆盖
   `graph_vault/dspy` 下保存 registered DSPy YAML/JSON targets 及 checksum
   sidecars 的 descendant directories；target mapping 仍包含
   `graph_vault/dspy/**/*.yaml` 与 `graph_vault/dspy/**/*.json`。

5. `graph_vault/catalog` checksum meta backfill 的 parent directory fsync
   路径仍闭合。设计仍要求 checksum meta backfill 写入 sidecar 后，将
   `graph_vault/catalog` 作为 derived directory fsync operation，并保留
   directory target、primary target、sidecar target、`sidecarKind`、
   `directoryDurableKind`、`primaryDurableKind`、lane 与 owner 映射；status-json
   read-only 仍不得 backfill 或执行 fsync。

## 非阻塞风险

1. 多个载体以局部字段清单表达同一 canonical boundary。实现阶段应将
   `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 作为共享
   contract 或测试 fixture，避免手写清单漂移。

2. 部分字段仍带有 `when` 条件。实现测试需要覆盖 primary target、checksum
   sidecar、checksum meta sidecar、unsupported fsync 与 platform no errno 场景，
   确保 sentinel 不被条件分支漏投影。

3. read-only diagnostic 与 repair writer 共用 directory mapping 的要求已明确，
   但实现应增加 golden case 验证，防止 status-json 观察路径与 repair writer
   backfill 路径各自解析 scope。
