# Bookshelf Membership 实施审计报告：Agent 3

## 审计范围

- 实现文件 (implementation):
  `src/graphrag/upper-index/bookshelf-membership.ts`
- 可运行目标 (runnable target):
  `scripts/graphrag/build-bookshelf-membership.mjs`
- 测试文件 (tests):
  `test/graphrag-bookshelf-membership.test.ts`
- 真实产物根目录 (published artifact root):
  `graph_vault/catalog/bookshelves/software-architecture-core/current`
- 唯一 Type DD 合同 (Type DD contract):
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

仓库检索仅发现一个层级 library index Type DD 合同文件：
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。

## 验证命令

- `npx vitest run --reporter=verbose --testTimeout 60000
  test/graphrag-bookshelf-membership.test.ts`
  - 结果：2 个测试通过。
- `npx vitest run --reporter=verbose --testTimeout 60000
  test/cli-graphrag-route.test.ts
  test/graphrag-book-hotplug-runtime-gate.test.ts
  test/graphrag-book-hotplug-catalog.test.ts`
  - 结果：30 个测试通过。
- `node scripts/graphrag/build-bookshelf-membership.mjs`，输入为从真实
  3 本 ready 包复制到临时 vault 的包集合。
  - 结果：`ok: true`、`memberCount: 3`、`queryReady: false`。
- 对 `graph_vault/catalog/bookshelves/software-architecture-core/current`
  执行本地 checksum 与 digest 校验脚本。
  - 结果：所有 `.sha256` sidecar 均匹配当前文件字节；发现
    `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的 manifest 内部自引用 digest
    与最终文件 digest 不一致。

## I01 单书包不被污染

Status: PASS

证据：

- `resolveBookshelfMembership` 的写入根位于
  `graph_vault/catalog/bookshelves/{bookshelfId}`，写入目标为
  `staging/{generation}`、`current` 和 `CURRENT.json`。
- 成员单书包访问通过 `readBookManifest`、包校验器
  (package validator) 和 runtime gate 校验完成，均为读取行为。
- membership 测试在物化后确认成员 `BOOK_MANIFEST.json` 仍存在。
- 实现中未发现写入 `graph_vault/books/{bookId}` 的路径。

剩余风险：

- 测试只确认单书 manifest 存在，未对每个单书包做发布前后 checksum
  对比；当前结论依赖源码写入面检查。

## I02 只写 `catalog/bookshelves` 派生物

Status: PASS

证据：

- 实现写入位置限定为：
  - `catalog/bookshelves/{bookshelfId}/staging/{generation}/...`
  - `catalog/bookshelves/{bookshelfId}/current/...`
  - `catalog/bookshelves/{bookshelfId}/CURRENT.json`
- 真实产物位于
  `graph_vault/catalog/bookshelves/software-architecture-core/current`，
  以及同一书架根目录下的 `CURRENT.json`。
- CLI runnable target 在临时 vault 中成功运行，并只生成请求书架的
  membership catalog 派生物。

剩余风险：

- `bookshelfId` 直接参与路径拼接。当前审计输入安全，但本轮未覆盖
  path segment hardening。

## I03 不读取 `catalog/batch-runs` 作为语义输入

Status: PASS

证据：

- membership 实现、脚本和 membership 测试中未发现 `catalog/batch-runs`
  或 `batch-runs` 引用。
- Type DD 明确禁止 runner ledger 作为语义输入。
- 实现从显式 `bookIds` 和包内 readiness artifacts 派生成员，不从
  runner ledger 推断成员语义。

剩余风险：

- 下层包校验器可能读取包内 run evidence 作为 readiness 证据；这不同于
  `catalog/batch-runs` 作为语义输入，本轮未展开审计。

## I04 只接受包内 publish、quality、runtime gate 通过成员

Status: PASS

证据：

- `readBookManifest` 要求以下条件全部成立：
  - `BOOK_MANIFEST.json` 存在。
  - `PUBLISH_READY.json` 存在。
  - `state/hotplug-quality-gate.json` 满足 `status: "passed"` 和
    `copyDistributionAllowed: true`。
  - `state/hotplug-runtime-gate.json` 满足
    `currentState: "query_ready"`、`queryReady: true` 和
    `copyDistributionAllowed: true`。
  - `validatePublishedBookHotplugPackage(...).ok` 为 true。
  - `validateHotplugRuntimeQueryGate(...).ok` 为 true。
  - `manifest.graphrag.queryReady === true`。
- 负向测试删除一个成员的 runtime gate，确认抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，且不发布
  `current`。
- 真实 3 个成员均满足：
  - `manifest.graphrag.queryReady=true`
  - `quality.status=passed`
  - `runtime.currentState=query_ready`
  - `runtime.queryReady=true`

剩余风险：

- 当前测试覆盖 runtime gate 缺失拒绝；failed quality gate 和 stale
  publish marker 的显式 membership 测试仍可补强。

## I05 membership manifest queryReady=false 且不发布 BOOKSHELF_MANIFEST

Status: PASS

证据：

- `BookshelfMembershipManifestSchema` 要求
  `bookshelfIdentity.queryReady` 为 `false`。
- `MembershipQualityGateSchema` 要求 `queryReady` 为 `false`。
- 实现只写 `nextStage.requiredManifest: "BOOKSHELF_MANIFEST.json"`，不写
  `BOOKSHELF_MANIFEST.json`。
- membership 测试确认：
  - membership manifest `queryReady === false`
  - `current/BOOKSHELF_MANIFEST.json` 不存在
- 真实 current 产物确认：
  - `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 中 `queryReady: false`
  - `CURRENT.json` 中 `queryReady: false`
  - `current` 下不存在 `BOOKSHELF_MANIFEST.json`

剩余风险：

- 对本轮 membership-only handoff 行为无实质剩余风险。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery-summary 闭环

Status: FAIL

证据：

- 真实 current generation 中必需文件存在：
  - `BOOKSHELF_MEMBERSHIP_MANIFEST.json`
  - `bookshelf_members.json`
  - `membership_decisions.jsonl`
  - `bookshelf_split_plan.json`
  - `state/membership-quality-gate.json`
  - `state/diagnostics.json`
  - `runs/.../events.jsonl`
  - `runs/.../status.json`
  - `runs/.../recovery-summary.json`
  - 3 个 `runs/.../checkpoints/*.json`
- 每个文件均有 `.sha256` sidecar，且 sidecar 与当前文件字节匹配。
- manifest 中 membership digest 与实际内容匹配：
  - `membersDigest`
  - `decisionsDigest`
  - `splitPlanDigest`
- 失败点：manifest 的 `files[]` 中
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 条目记录的 sha256 为
  `64e81d1cb1086edc0174720fc868d37a88b1bf8bc7a60bad227b156981812481`，
  但最终文件和 `.sha256` sidecar 的 sha256 为
  `0a15e8fd01f2b94a5376c6621dc4e9afce22334e579c52b534eb7b271e811abf`。
- 源码先写一次 manifest，并把第一次写入的 digest 放进 `files[]`，
  随后又用扩展后的 `files[]` 重写 manifest；因此自引用 digest 过期。

剩余风险：

- `validateBookshelfMembership` 未逐项校验 manifest `files[]` 与当前文件
  字节和 sidecar 的一致性，因此当前 validator 和测试不会捕获该闭环缺口。

## I07 typed failure 不发布 `current`

Status: PASS

证据：

- 失败路径在提升 `current` 前抛出 `upper_quality_gate_failed:*`。
- `current` promotion 发生在成员收集、schema parse、artifact 写入和
  manifest 构造之后。
- 负向测试对缺失 runtime gate 的成员确认 typed failure 字符串，并确认
  `catalog/bookshelves/architecture-core/current` 不存在。

剩余风险：

- typed failure 当前表现为错误字符串，不是结构化导出的 error type；
  对 fail-closed publication 基准而言已满足。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

Status: PASS

证据：

- membership 可发布产物使用相对 locator，例如：
  - `books/{bookId}`
  - `books/{bookId}/BOOK_MANIFEST.json`
  - `books/{bookId}/graphrag/output/*.parquet`
  - `current/bookshelf_members.json`
- 对真实 current 产物扫描结果：
  - `forbiddenKeyOccurrences=0`
  - `absolutePathStringOccurrences=0`
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 中出现 forbidden field 名称的位置是
  sensitivity policy 声明，不是敏感 payload。

剩余风险：

- CLI/user-provided 字符串，例如 `--decided-by`、taxonomy 标识和
  `bookshelfId`，尚未在发布前做独立 redaction scan。真实审计产物干净，
  但输入硬化仍不完整。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

Status: PASS

证据：

- membership 测试从 3 本 ready fixture book 物化 generation：
  `book-shelf-a`、`book-shelf-b`、`book-shelf-c`。
- 真实 current 包含 3 个成员：
  - `book-00474fb29e5e-59d02d41`
  - `book-04366e35670a-a4fc3c05`
  - `book-046be61c0c1b-0d3fd739`
- CLI runnable target 在包含这 3 个真实 ready 包副本的临时 vault 中通过：
  - `ok: true`
  - `memberCount: 3`
  - `queryReady: false`

剩余风险：

- runnable target 使用临时复制 vault 运行，以避免覆盖真实 `current`
  generation。

## I10 单书 GraphRAG 查询和单书质量门不回归

Status: PASS

证据：

- 单书 GraphRAG route 测试通过，包括：
  - `qmd query --graphrag --json returns a unified GraphRAG answer`
  - `qmd query --graphrag uses the selected book scoped output`
  - `qmd query --mode auto can be scoped to one graph book`
- hotplug runtime gate 测试通过，包括包内 query-ready 校验和伪造证据
  fail-closed 场景。
- hotplug catalog 测试通过，包括从 package manifest 派生 query
  capability，以及拒绝 runtime reports/provider payloads。
- 真实 3 个成员仍保持单书 query-ready，且包内 quality/runtime gate 均通过。

剩余风险：

- 未运行完整仓库测试套件。本轮运行了 membership、单书查询 route、
  runtime gate 和 hotplug catalog 的目标测试集合。

## 总体结论

overallStatus: FAIL

本轮 membership 实现在隔离单书包、只写 catalog/bookshelves 派生物、包内
gate 约束、not-query-ready handoff、3 本 ready 包 runnable target，以及单书
GraphRAG 回归方面满足基准。未满足项为 I06：最终
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 在自身 `files[]` 中记录了过期 digest，
导致 manifest 内部闭环与最终文件/sidecar 不一致；当前 validator 和测试也未
捕获该 mismatch。
