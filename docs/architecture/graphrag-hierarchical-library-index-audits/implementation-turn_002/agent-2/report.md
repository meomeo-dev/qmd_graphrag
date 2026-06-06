# implementation-turn_002 agent-2 membership 实施审计报告

overallStatus: PASS

## 审计范围

被审计对象：

- `src/graphrag/upper-index/bookshelf-membership.ts`
- `dist/graphrag/upper-index/bookshelf-membership.js`
- `scripts/graphrag/build-bookshelf-membership.mjs`
- `test/graphrag-bookshelf-membership.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current`
- `graph_vault/catalog/bookshelves/software-architecture-core/CURRENT.json`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定复用 implementation-turn_001 的 10 项实施基准：

- I01 单书包不被污染。
- I02 只写 `catalog/bookshelves` 派生物。
- I03 不读取 `catalog/batch-runs` 作为语义输入。
- I04 只接受包内 publish、quality、runtime gate 通过成员。
- I05 membership manifest `queryReady=false` 且不发布
  `BOOKSHELF_MANIFEST.json`。
- I06 manifest、checksum、digest、gate、status、events、checkpoints、
  recovery-summary 闭环。
- I07 typed failure 不发布 `current`。
- I08 敏感信息和绝对路径不进入可发布 membership 产物。
- I09 测试和真实 runnable target 覆盖至少 3 本 ready 包。
- I10 单书 GraphRAG 查询和单书质量门不回归。

## 总体结论

本轮 implementation-turn_002 通过审计。implementation-turn_001 的 I06 阻断缺陷
已修复：真实
`graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MEMBERSHIP_MANIFEST.json`
的 `files[]` 不再包含自身；`files[]` 11 个条目的 sha256、bytes 均与实际文件和
对应 `.sha256` sidecar 一致；manifest 自身由 sidecar 和 `CURRENT.json` 的
`manifestSha256` 证明。

`validateBookshelfMembership` 已形成 manifest-to-files checksum closure。临时副本
篡改验证中，validator 可捕获 `manifest_file_sha256_mismatch`、
`manifest_file_bytes_mismatch` 和 `manifest_self_reference_forbidden`。真实
`software-architecture-core` current 验证返回
`ok=true`、`diagnostics=[]`、`memberCount=3`。

## I01 单书包不被污染

status: PASS

证据：

- `resolveBookshelfMembership` 的写入根为
  `catalog/bookshelves/{bookshelfId}`，并在 staging generation 完成后提升为
  `current`。实现未写入 `graph_vault/books/{bookId}`。
- 成员读取只通过单书包内的 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  `state/hotplug-quality-gate.json` 和 `state/hotplug-runtime-gate.json` 完成。
- 正向测试在 materialize 后断言三个单书 `BOOK_MANIFEST.json` 仍存在。

剩余风险：

- `bookshelfId` 和 `bookId` 仍未显式收敛为路径安全 ID schema。可信参数下满足本项；
  面向不可信 CLI 输入时仍应拒绝 `/`、`..`、URL scheme 和盘符路径。

## I02 只写 catalog/bookshelves 派生物

status: PASS

证据：

- membership 产物写入
  `catalog/bookshelves/{bookshelfId}/staging/{generation}`、
  `catalog/bookshelves/{bookshelfId}/current` 和
  `catalog/bookshelves/{bookshelfId}/CURRENT.json`。
- 真实产物只位于
  `graph_vault/catalog/bookshelves/software-architecture-core` 下，包含
  membership manifest、members、decisions、split plan、state、runs、checkpoints
  和 sidecar。
- 审计扫描未发现 membership 实现向 `graph_vault/books/**`、
  `graph_vault/catalog/batch-runs/**` 或查询运行目录写入。

剩余风险：

- 与 I01 相同，路径安全 ID 约束仍建议作为后续 hardening 项。

## I03 不读取 catalog/batch-runs 作为语义输入

status: PASS

证据：

- `src/graphrag/upper-index/bookshelf-membership.ts`、
  `scripts/graphrag/build-bookshelf-membership.mjs` 和
  `test/graphrag-bookshelf-membership.test.ts` 未引用 `catalog/batch-runs`。
- 成员 evidenceRefs 只引用包内 manifest、publish marker、quality gate 和 runtime
  gate。
- Type DD 明确禁止 runner ledger events 作为 classification evidence。

剩余风险：

- taxonomy、LLM accepted decision 等后续输入尚未完整实现。扩展时必须继续隔离
  runner ledger 与 batch-runs。

## I04 只接受包内 publish/quality/runtime gate 通过成员

status: PASS

证据：

- `readBookManifest` 要求包内 `BOOK_MANIFEST.json` 和 `PUBLISH_READY.json` 存在。
- 包内 `state/hotplug-quality-gate.json` 必须为
  `status=passed` 且 `copyDistributionAllowed=true`。
- 包内 `state/hotplug-runtime-gate.json` 必须为
  `currentState=query_ready`、`queryReady=true` 且
  `copyDistributionAllowed=true`。
- 实现同时调用 `validatePublishedBookHotplugPackage` 和
  `validateHotplugRuntimeQueryGate`，并要求单书 manifest 的
  `graphrag.queryReady=true`。
- 真实 3 个成员包均存在 publish marker，quality gate 为 `passed`，runtime gate 为
  `query_ready` 且 `queryReady=true`。

剩余风险：

- typed failure 当前仍主要以错误消息字符串表达，例如
  `upper_quality_gate_failed:package_runtime_gate_failed`，未升级为统一结构化错误对象。

## I05 membership manifest queryReady=false 且不发布 BOOKSHELF_MANIFEST

status: PASS

证据：

- schema 固定 `bookshelfIdentity.queryReady=false`。
- membership quality gate 固定
  `readyState=membership_resolved`、`queryReady=false`。
- manifest 的 `nextStage.requiredManifest` 为 `BOOKSHELF_MANIFEST.json`，只声明下一阶段
  输入，不授予书架查询就绪。
- 真实 `current/BOOKSHELF_MEMBERSHIP_MANIFEST.json` 中
  `queryReady=false`。
- `graph_vault/catalog/bookshelves/software-architecture-core/current` 下不存在
  `BOOKSHELF_MANIFEST.json`。

剩余风险：

- 后续查询层不得把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 注册为 query-ready scope。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery 闭环

status: PASS

复核结论：

- implementation-turn_001 的 self-reference digest bug 已修复。
- 当前源码在生成 `files[]` 时只纳入 members、decisions、split plan、gate、
  diagnostics、events、status、recovery-summary 和 checkpoints，不纳入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 自身。
- `dist/graphrag/upper-index/bookshelf-membership.js` 与源码一致，真实 CLI runnable
  target 使用的编译产物也包含该修复。

真实产物核验：

- 真实 generation：
  `membership-441f83a0fc86eabd`。
- manifest `queryReady=false`。
- manifest `files[]` 数量为 11。
- manifest `files[]` 不包含
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`。
- manifest digest：
  `59282a1e073882b199262c509b6beaaab73db4e4a61c3032ef0a116c900bf72f`。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256` 与最终 manifest 文件一致。
- `CURRENT.json` 的 `manifestSha256` 与最终 manifest digest 一致，且
  `CURRENT.json.sha256` 与 `CURRENT.json` 文件一致。
- `files[]` 中 11 个条目的 sha256、bytes 均与实际文件一致，且每个实际文件的
  `.sha256` sidecar 均匹配实际 sha256。
- `bookshelf_members.json`、`membership_decisions.jsonl`、
  `bookshelf_split_plan.json`、`state/membership-quality-gate.json`、
  `state/diagnostics.json`、events、status、recovery-summary 和 3 个 checkpoint
  均进入闭包。

validator 复核：

- 对真实 current 运行 `validateBookshelfMembership` 返回：
  `{"ok":true,"diagnostics":[],"memberCount":3}`。
- 在临时副本中篡改 `manifest.files[0].sha256`，validator 返回
  `ok=false`，包含
  `manifest_file_sha256_mismatch:bookshelf_members.json`。
- 在临时副本中篡改 `manifest.files[0].bytes`，validator 返回
  `ok=false`，包含
  `manifest_file_bytes_mismatch:bookshelf_members.json`。
- 在临时副本中向 `files[]` 添加
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`，validator 返回
  `ok=false`，包含 `manifest_self_reference_forbidden`。

## I07 typed failure 不发布 current

status: PASS

证据：

- 成员 package gate 失败发生在 staging 提升为 `current` 之前。
- 测试删除一个成员包的 runtime gate 后，
  `resolveBookshelfMembership` 抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，并断言
  `catalog/bookshelves/architecture-core/current` 不存在。
- current 提升发生在 manifest、sidecar、gate、diagnostics、events、status、
  recovery-summary 和 checkpoints 写入完成之后。

剩余风险：

- typed failure 仍建议结构化，避免后续调用方只能解析字符串。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

status: PASS

证据：

- 可发布 membership 产物中的 locator 为 scope-relative 或
  `books/{bookId}/...` 形式。
- 真实 current 产物扫描未发现 `/Users/`、`/private/`、`/var/` 或
  `graph_vault/` 绝对/仓库根 locator。
- 真实可发布产物未发现 provider payload、raw prompt、raw completion、api key、
  credential、absolute local path 或 query log 作为值进入产物。
- manifest 中出现的 `providerRequestPayload`、`providerResponsePayload`、
  `rawPrompt`、`rawCompletion`、`apiKey`、`credential`、
  `absoluteLocalPath`、`queryLogContent` 只作为
  `sensitivityPolicy.forbiddenFields` 的禁止字段名。

剩余风险：

- `policy.decidedBy`、taxonomy 字段和 `bookshelfId` 等仍建议加长度、字符集和
  forbidden-locator schema。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

status: PASS

证据：

- `test/graphrag-bookshelf-membership.test.ts` 正向用例创建
  `book-shelf-a`、`book-shelf-b`、`book-shelf-c` 三个 query-ready 包并生成
  membership generation。
- 真实 `bookshelf_members.json` 包含 3 个成员：
  `book-00474fb29e5e-59d02d41`、
  `book-04366e35670a-a4fc3c05`、
  `book-046be61c0c1b-0d3fd739`。
- 三个真实成员的 manifest digest 与 membership 记录一致，publish marker 存在，
  quality/runtime gates 均通过，4 个 graph artifact locator 均存在。
- `node scripts/graphrag/build-bookshelf-membership.mjs --help` 能从
  `dist/graphrag/upper-index/bookshelf-membership.js` 加载 runnable target 并输出参数。

## I10 单书 GraphRAG 查询和单书质量门不回归

status: PASS

证据：

- membership 实现未改动单书 GraphRAG 查询路由、runtime bridge、hotplug quality gate
  或 creation gate 的核心路径。
- `test/cli-graphrag-route.test.ts` 9 项通过，覆盖单书 GraphRAG 查询、显式
  `--graph-book-id`、多书无 scope 拒绝和 auto route。
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 9 项通过，覆盖 manifest sidecar、
  publish marker、runtime compatibility、artifact metadata、producer binding 和
  provider fingerprint 的 fail-closed 行为。
- `test/graphrag-book-hotplug-creation-gate.test.ts` 1 项通过，覆盖单书创建只在
  package validation gates 通过后发布。

剩余风险：

- 本轮仍未实现书架级 query-ready `BOOKSHELF_MANIFEST.json`，因此 I10 只证明单书
  GraphRAG 查询和单书质量门未回归，不证明书架查询能力已可用。

## 验证命令

- `npm run test:node -- test/graphrag-bookshelf-membership.test.ts`
  - 结果：1 个测试文件通过，3 项测试通过。
- `npm run test:types`
  - 结果：通过。
- `node --import tsx --input-type=module ... validateBookshelfMembership(...)`
  - 结果：`ok=true`、`diagnostics=[]`、`memberCount=3`。
- `node --import ./dist/graphrag/upper-index/bookshelf-membership.js --input-type=module ...`
  - 结果：`ok=true`、`diagnostics=[]`、`memberCount=3`。
- `node scripts/graphrag/build-bookshelf-membership.mjs --help`
  - 结果：正常输出 CLI usage。
- `npm run test:node -- test/cli-graphrag-route.test.ts`
  - 结果：1 个测试文件通过，9 项测试通过。
- `npm run test:node -- test/graphrag-book-hotplug-runtime-gate.test.ts`
  - 结果：1 个测试文件通过，9 项测试通过。
- `npm run test:node -- test/graphrag-book-hotplug-creation-gate.test.ts`
  - 结果：1 个测试文件通过，1 项测试通过。

## 结论

implementation-turn_002 满足 10 项固定基准。I06 的发布闭包（publish closure）已从
阻断失败转为通过：manifest 不再自引用，真实产物、sidecar、`CURRENT.json`、
gate/status/events/checkpoints/recovery-summary 之间一致，validator 能捕获闭包
mismatch。剩余事项均为 hardening 风险，不阻断本轮通过。
