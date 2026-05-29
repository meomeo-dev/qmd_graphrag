# Design Audit R1 - agent-a

## 结论

FAIL.

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 当前不足以指导正确
修复 `DurableStateError: durable target mapping missing: graph_vault/catalog`。
设计已经要求 catalog、checksum sidecar 与 checksum meta sidecar 使用 durable
replace，并要求完成后执行父目录 fsync（parent directory fsync），但没有把
该父目录 fsync 边界纳入 target mapping（目标映射）契约。

结果是实现者可能合理地把 `fsyncDirectory(dirname(path))` 当作一个需要
`durableTargetMapping` 的持久化目标处理；当 `dirname(path)` 是
`graph_vault/catalog` 时，现有 mapping 只覆盖 `books.yaml` 等具体文件，
无法解析目录本身的 lane、owner 与 durableKind，正好落入本轮真实 runner
失败。

## 设计证据

- `targetMappingContract.rule` 规定每个生产持久化目标必须能从
  `targetMapping` 追溯到唯一 `lane`、`owner`、`durableKind`、
  `laneTimeoutMs` 与 `releaseOn`，但文字只禁止未列入 mapping 的
  durable YAML/JSON/SQLite 目标写入，没有定义目录 fsync 目标是否也属于
  target mapping 管辖范围。
- `targetMapping` 枚举了 `graph_vault/catalog/books.yaml`、
  `runs.yaml`、`sources.yaml`、`document-identity-map.yaml`、
  `graph-capabilities.yaml` 等具体文件，也枚举了 batch run 下的具体
  JSON/JSONL pattern；没有 `graph_vault/catalog` 或等价的
  `directory_fsync` / `fsync_boundary` 条目。
- `derivedSidecarRule` 说明 `{target}.sha256` 与
  `{target}.sha256.meta.json` 继承 primary target 的 lane、owner、
  timeout、releaseOn、durableMode 与 preflight scope；但没有说明
  sidecar 写入后的父目录 fsync 是否也继承 primary target 的映射，或是否
  需要单独的目录映射。
- `durableWriteContract.yamlOrJsonReplace` 明确要求写 temp、fsync 文件、
  atomic rename 后再 fsync 父目录；`platformFsyncBoundary` 又要求
  `fsyncTarget`、`fsyncErrno`、`durableMode` 等诊断字段。但设计没有定义
  `fsyncTarget=graph_vault/catalog` 如何解析出唯一 lane/owner，也没有规定
  解析失败时的分类与恢复决策。
- `preflightScopeRule` 规定精确文件条目使用父目录派生 scan root。该规则只
  覆盖扫描范围（scan scope），不能替代 durable operation evidence
  所需的目录 fsync mapping；否则 `graph_vault/catalog` 会被扫描到，却仍然
  不是可解析的 durable target。
- `directory_fsync_boundary_uncertain` acceptance case 覆盖目录 fsync
  unsupported/uncertain 的失败投影，但没有覆盖“父目录 fsync target mapping
  缺失”这一前置解析失败，也没有要求 runner_start/discoverItems 读 catalog
  时通过 checksum meta reconcile 路径验证该映射。

## 必须补充或修正的设计点

1. 明确定义目录 fsync target mapping（directory fsync target mapping）。
   Type DD 必须说明父目录 fsync 是 durable operation 的一部分，并且必须能
   解析出 lane、owner、durableKind、timeout 与 releaseOn。可采用显式目录
   条目，例如 `durableKind: directory_fsync`，或采用基于 primary target 的
   继承规则；两者必须择一并写成规范。

2. 规定 `fsyncDirectory` 不得只用裸目录路径做唯一 target lookup。对于
   `writeJsonAtomicSidecar`、`writeCommittedChecksumMeta`、checksum backfill
   与 YAML/JSON reconcile，目录 fsync 必须携带 `primaryTargetLocator` 或
   `sidecarTargetLocator` 上下文，并从对应 durable target family 继承
   `lane`、`owner` 与 `targetMappingOwner`。否则 `graph_vault/catalog`
   这类混合目录会在不同文件 family 之间产生歧义。

3. 明确 `graph_vault/catalog` 顶层 catalog YAML family 的目录 fsync 归属。
   对 `books.yaml`、`runs.yaml`、`sources.yaml`、
   `document-identity-map.yaml` 与 `graph-capabilities.yaml` 的 primary、
   checksum sidecar 与 checksum meta sidecar，父目录 fsync 应解析到
   `catalogWriterLane`，owner 应继承对应 primary target owner，或由设计明示
   一个不会混淆 provider cost/event family 的 catalog directory owner。

4. 定义目录 fsync mapping 缺失的 fail-closed 分类。若必需的父目录 fsync
   无法解析映射，设计应要求分类为 local state integrity（本地状态完整性）
   的不可重试失败，`recoveryDecision: stop_until_fixed`，
   `completedPublishRule: forbidden`，并保留 `primaryTargetLocator`、
   `sidecarTargetLocator`、`fsyncTarget`、`operationId`、`lane` 或
   explicit unavailable sentinel、`targetMappingOwner` 或 explicit
   unavailable sentinel。

5. 补充 runner_start/discoverItems 的设计验收用例。用例应覆盖
   `loadCatalogBySourceHash` 读取 `graph_vault/catalog/books.yaml` 时触发
   checksum meta backfill/reconcile，并在写
   `books.yaml.sha256.meta.json` 后 fsync `graph_vault/catalog`。期望结果是：
   映射可解析；若 fsync 本身失败则按 durable directory fsync 失败投影；
   不允许出现 `durable target mapping missing: graph_vault/catalog`。

6. 区分 scan root 与 fsync boundary。`preflightScopeRule` 可以继续从文件
   target 派生父目录扫描范围，但 Type DD 必须明确该父目录并不自动成为
   独立 primary target，也不会递归生成 checksum sidecar。目录 fsync 只作为
   当前 durable commit 的 fsync boundary（同步边界）记录证据和映射来源。

## 风险

若不补充上述设计，后续实现仍可能在两种错误之间摇摆：一是继续把
`graph_vault/catalog` 当作缺失的 durable target 并在 runner_start 失败；
二是添加过宽的目录 mapping，把同一目录下不同 owner/lane 的文件 family
错误归并。两者都会削弱 Type DD 对并行 runner durable state 的约束力。
