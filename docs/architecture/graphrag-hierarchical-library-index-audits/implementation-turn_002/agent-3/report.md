# implementation-turn_002 agent-3 实施审计报告

auditDate: 2026-06-06
overallStatus: PASS

## 审计范围

- 实现文件 (implementation):
  `src/graphrag/upper-index/bookshelf-membership.ts`
- 可运行目标 (runnable target):
  `scripts/graphrag/build-bookshelf-membership.mjs`
- 测试文件 (tests):
  `test/graphrag-bookshelf-membership.test.ts`
- 真实产物根目录 (published artifact root):
  `graph_vault/catalog/bookshelves/software-architecture-core/current`
- 合同文件 (Type DD contract):
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮固定复用 implementation-turn_001 的 10 项实施基准。重点复核结论：
implementation-turn_001 的 I06 自引用 digest bug 已修复。真实
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的 `files[]` 不包含自身，
`files[]` 每一项的 `sha256` 和 `bytes` 均与实际文件及 `.sha256`
sidecar 一致；`validateBookshelfMembership` 能捕获闭包 mismatch
(closure mismatch) 和 manifest 自引用。

## 验证命令

- `npm run test:node -- test/graphrag-bookshelf-membership.test.ts`
  - 结果：3 tests passed。
- `npm run test:node -- test/cli-graphrag-route.test.ts`
  - 结果：9 tests passed。
- `npm run test:node -- test/graphrag-book-hotplug-runtime-gate.test.ts`
  - 结果：9 tests passed。
- `npm run test:node -- test/graphrag-book-hotplug-catalog.test.ts`
  - 结果：12 tests passed。
- `npm run test:types`
  - 结果：passed。
- `validateBookshelfMembership` 校验真实
  `software-architecture-core/current`
  - 结果：`ok: true`、`diagnostics: []`、`memberCount: 3`。
- 对真实 current 执行本地 manifest file closure 校验。
  - 结果：manifest 文件自身 sidecar 匹配；`files[]` 共 11 项，
    不包含 `BOOKSHELF_MEMBERSHIP_MANIFEST.json`；11 项均与实际
    文件 bytes、sha256 和 sidecar 一致。
- 在临时 vault 中篡改 `files[0].bytes` 和 `files[0].sha256`。
  - 结果：validator 返回 `ok: false`，诊断包含
    `manifest_file_bytes_mismatch:bookshelf_members.json`、
    `manifest_file_sha256_mismatch:bookshelf_members.json` 和
    `manifest_sidecar_mismatch`。
- 在临时 vault 中向 `files[]` 追加
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 自引用条目。
  - 结果：validator 返回 `ok: false`，诊断包含
    `manifest_self_reference_forbidden`。
- `node scripts/graphrag/build-bookshelf-membership.mjs` 在临时 vault
  中复制真实 3 本 ready book package 后运行。
  - 结果：`ok: true`、`memberCount: 3`、`queryReady: false`。

## I01 单书包不被污染

status: PASS

证据：

- Type DD 的 `package_first_authority` 和 `catalog_is_derivative`
  约束要求单书包权威来自 `graph_vault/books/{bookId}`，书架与
  library 只能读取已验证包产物或其 catalog projection，且不得改变
  单书包身份、文件闭包或单书查询的 `query_ready` 判定。
- membership 实现的写入根为
  `graphVault/catalog/bookshelves/{bookshelfId}`，只创建 staging、
  current 和 `CURRENT.json`。
- 成员读取通过 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内
  quality gate、包内 runtime gate、package validator 和 runtime gate
  validator 完成。
- membership 正向测试在发布后确认 3 个成员单书包的
  `BOOK_MANIFEST.json` 仍存在。
- 本轮未发现 membership 代码写入 `graph_vault/books/{bookId}`。

剩余风险：

- 测试仍以 manifest 存在性证明未污染单书包，未做单书包发布前后
  全量 checksum 快照对比。

## I02 只写 `catalog/bookshelves` 派生物

status: PASS

证据：

- `resolveBookshelfMembership` 将 `root` 固定在
  `catalog/bookshelves/{bookshelfId}`，发布面为：
  `staging/{generation}/**`、`current/**` 和 `CURRENT.json`。
- 真实产物均位于
  `graph_vault/catalog/bookshelves/software-architecture-core/current`
  及同一书架根下的 `CURRENT.json`。
- CLI runnable target 只调用 resolver 和 validator，不额外写入其他
  catalog 根或单书包根。

剩余风险：

- `bookshelfId` 仍直接参与路径拼接。当前审计输入是可信 ID；不可信
  CLI 输入的路径段安全约束仍应独立硬化。

## I03 不读取 `catalog/batch-runs` 作为语义输入

status: PASS

证据：

- Type DD 的 `no_runner_ledger_as_semantic_input` 明确禁止
  `graph_vault/catalog/batch-runs/**`、`runs/**`、`events.jsonl` 和
  recovery summaries 作为语义检索、成员推断或 GraphRAG 社区生成内容
  输入。
- membership 实现、CLI 脚本和 membership 测试中未出现
  `catalog/batch-runs` 或 `batch-runs` 引用。
- membership decisions 的 evidence refs 限定在成员包内 manifest、
  publish marker、quality gate 和 runtime gate。

剩余风险：

- 下层 runtime gate validator 会读取包内 producer run binding 等包内
  lineage 证据；这不等同于读取 `catalog/batch-runs` 作为 membership
  语义输入。

## I04 只接受包内 publish、quality、runtime gate 通过成员

status: PASS

证据：

- `readBookManifest` 要求 `BOOK_MANIFEST.json` 和 `PUBLISH_READY.json`
  存在。
- 包内 `state/hotplug-quality-gate.json` 必须满足
  `status: "passed"` 和 `copyDistributionAllowed: true`。
- 包内 `state/hotplug-runtime-gate.json` 必须满足
  `currentState: "query_ready"`、`queryReady: true` 和
  `copyDistributionAllowed: true`。
- 实现继续调用 `validatePublishedBookHotplugPackage` 和
  `validateHotplugRuntimeQueryGate`，并要求
  `manifest.graphrag.queryReady === true`。
- 负向测试删除成员 runtime gate 后抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，且不发布
  `current`。
- 真实 3 个成员均为 ready 包，membership 中 `queryReady: true`。

剩余风险：

- 当前 membership 测试重点覆盖 runtime gate 缺失；显式篡改 quality
  gate、publish marker stale 等场景可继续补强。

## I05 membership manifest `queryReady=false` 且不发布 `BOOKSHELF_MANIFEST`

status: PASS

证据：

- `BookshelfMembershipManifestSchema` 要求
  `bookshelfIdentity.queryReady` 为 `false`。
- `MembershipQualityGateSchema` 要求 `readyState` 为
  `membership_resolved` 且 `queryReady` 为 `false`。
- manifest 的 `nextStage.requiredManifest` 为
  `BOOKSHELF_MANIFEST.json`，表示 membership handoff 不授予书架
  query readiness。
- 正向测试断言 membership manifest `queryReady === false`，并确认
  `current/BOOKSHELF_MANIFEST.json` 不存在。
- 真实 current 中不存在 `BOOKSHELF_MANIFEST.json`；
  `CURRENT.json` 也保持 `queryReady: false`。

剩余风险：

- 无直接剩余风险。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery 闭环

status: PASS

证据：

- 真实 current 必需产物存在：
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、`bookshelf_members.json`、
  `membership_decisions.jsonl`、`bookshelf_split_plan.json`、
  `state/membership-quality-gate.json`、`state/diagnostics.json`、
  `runs/.../events.jsonl`、`runs/.../status.json`、
  `runs/.../recovery-summary.json` 和 3 个 checkpoints。
- 每个主文件均存在 `.sha256` sidecar，且 sidecar 与当前文件内容
  sha256 一致。
- 真实 manifest 文件：
  - `sha256` 为
    `59282a1e073882b199262c509b6beaaab73db4e4a61c3032ef0a116c900bf72f`。
  - `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256` 与上述 digest 一致。
  - `CURRENT.json.manifestSha256` 与上述 digest 一致。
  - `bytes` 为 3902。
- 真实 manifest 的 `files[]` 共 11 项，不包含
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`。这修复了
  implementation-turn_001 中 manifest 自引用旧 digest 的失败点。
- `files[]` 中 11 项均与实际文件和 sidecar 一致：
  `bookshelf_members.json`、`membership_decisions.jsonl`、
  `bookshelf_split_plan.json`、`state/membership-quality-gate.json`、
  `state/diagnostics.json`、events、status、recovery-summary 和
  3 个 checkpoint。
- `validateBookshelfMembership` 现在逐项校验：
  - path 必须是 scope-relative 且不得是 manifest 自身。
  - 文件必须存在。
  - 实际 bytes 必须等于 manifest 记录。
  - 实际 sha256 必须等于 manifest 记录。
  - sidecar 必须存在并等于实际 sha256。
  - manifest 自身 sidecar 必须匹配最终 manifest 文件。
- 临时 vault 篡改 `files[0]` 后，validator 捕获
  `manifest_file_bytes_mismatch`、`manifest_file_sha256_mismatch` 和
  `manifest_sidecar_mismatch`。
- 临时 vault 追加 manifest 自引用后，validator 捕获
  `manifest_self_reference_forbidden`。
- membership 单测新增
  `rejects membership manifests with mismatched file closure digests`，
  覆盖 validator 闭包 mismatch 捕获能力。

剩余风险：

- `validateBookshelfMembership` 对 run required 文件和 checkpoint 仍主要
  校验存在性与 checksum sidecar 存在性；这些文件已在 `files[]` 内被
  sha/bytes/sidecar 闭包覆盖。若未来允许 run 文件不进入 `files[]`，
  需同步增加直接 digest 校验。

## I07 typed failure 不发布 `current`

status: PASS

证据：

- 空成员、LLM suggestion、缺失 manifest、缺失 publish marker、包内
  quality gate 失败、包内 runtime gate 失败、package boundary 失败、
  runtime gate 失败、manifest schema 无效和成员非 query-ready 均使用
  `upper_quality_gate_failed:*` 错误前缀。
- current promotion 发生在成员收集、gate、diagnostics、events、
  status、recovery-summary、checkpoints 和 manifest 写入之后。
- 负向测试删除成员 runtime gate 后确认 resolver 抛错，且目标
  `catalog/bookshelves/architecture-core/current` 不存在。

剩余风险：

- typed failure 当前仍是错误消息字符串，不是结构化 error object。
  对 fail-closed publication 基准而言已满足。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

status: PASS

证据：

- membership member 和 decision 只记录 graph_vault-relative 或
  scope-relative locator，例如 `books/{bookId}`、
  `books/{bookId}/BOOK_MANIFEST.json`、`state/...` 和 `runs/...`。
- Type DD 要求诊断仅记录 digest、schema id、check id、bounded
  summary 和 scope-relative locator，不记录 provider payload、raw
  prompt、raw completion、query log、credential 或绝对本地路径。
- 对真实 current 的结构化与文本扫描结果：
  - forbidden payload key hits: 0。
  - absolute path hits: 0。
  - secret-like value hits: 0。
- manifest 中出现敏感字段名的位置仅为
  `sensitivityPolicy.forbiddenFields` 声明，不是敏感 payload。

剩余风险：

- `decidedBy`、taxonomy id/version、title 和 `bookshelfId` 来自输入或
  单书 manifest；当前真实产物干净，但字段级 redaction schema 仍可补强。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

status: PASS

证据：

- membership 正向测试创建并发布 3 本 query-ready fixture book：
  `book-shelf-a`、`book-shelf-b`、`book-shelf-c`。
- 真实 current 包含 3 个成员：
  `book-00474fb29e5e-59d02d41`、
  `book-04366e35670a-a4fc3c05`、
  `book-046be61c0c1b-0d3fd739`。
- CLI runnable target 在临时 vault 中复制上述 3 个真实 ready 包后运行，
  返回 `ok: true`、`memberCount: 3`、`queryReady: false`。
- 真实 validator 返回 `ok: true`、`memberCount: 3`。

剩余风险：

- runnable target 仍通过临时 vault 运行，以避免覆盖真实 current；
  这是审计安全边界，不是功能缺口。

## I10 单书 GraphRAG 查询和单书质量门不回归

status: PASS

证据：

- `test/cli-graphrag-route.test.ts` 9 项通过，覆盖单书 GraphRAG JSON
  回答、非 JSON evidence、auto mode、ambiguous multi-book 拒绝和
  单书 scoped output。
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 9 项通过，覆盖
  manifest sidecar、publish marker、runtime compatibility digest、
  producer binding 和 provider fingerprint 等 fail-closed 场景。
- `test/graphrag-book-hotplug-catalog.test.ts` 12 项通过，覆盖 catalog
  projection、stale manifest、runtime reports/provider payload 拒绝和
  graph capability 派生。
- `npm run test:types` 通过。
- Type DD 将单书 GraphRAG 查询列为 already supported，并要求层级
  membership 不把 `BOOKSHELF_MEMBERSHIP_MANIFEST` 误读为 query-ready
  书架 scope。

剩余风险：

- 本轮未运行仓库全量测试套件；审计覆盖 membership 直接测试、单书
  GraphRAG route、hotplug runtime gate、hotplug catalog 和类型检查。
