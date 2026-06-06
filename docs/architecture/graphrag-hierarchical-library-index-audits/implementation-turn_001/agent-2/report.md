# implementation-turn_001 agent-2 membership 实现审计报告

overallStatus: FAIL

## 审计范围

被审计实现：

- `src/graphrag/upper-index/bookshelf-membership.ts`
- `scripts/graphrag/build-bookshelf-membership.mjs`
- `test/graphrag-bookshelf-membership.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定实施基准：

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

本轮 membership 实现未通过实施审计。I06 失败：真实
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的 sidecar checksum 与文件内容一致，
但 manifest 内 `files[]` 记录的自身 digest 是第一次写入的旧 digest，不等于最终
manifest 文件 digest。`validateBookshelfMembership` 对真实产物返回 `ok: true`，
说明当前 validator 未覆盖 manifest `files[]` 全量 checksum 闭环。

其余 9 项当前判定为 PASS。membership 阶段没有发布
`BOOKSHELF_MANIFEST.json`，只生成 membership-only handoff 产物；真实
`software-architecture-core/current` 包含 3 本 ready 成员；包内 publish marker、
hotplug quality gate、runtime gate 和单书 GraphRAG 查询回归测试均通过。

## I01 单书包不被污染

status: PASS

证据：

- membership 实现的写入根为
  `graphVault/catalog/bookshelves/{bookshelfId}`，具体在
  `resolveBookshelfMembership` 中构造 `root`、`stagingRoot`、`currentRoot`
  和 `CURRENT.json`；未对 `graph_vault/books/{bookId}` 写入。
- 成员读取通过 `resolveBookManifestPath`、`resolveBookPublishReadyPath`、
  `resolveBookRoot` 和包内 gate 文件完成，只读取单书包发布产物。
- `test/graphrag-bookshelf-membership.test.ts` 在生成 membership 后确认三个单书
  `BOOK_MANIFEST.json` 仍存在。
- 回归命令 `npm run test:node -- test/graphrag-bookshelf-membership.test.ts`
  通过，2 项测试通过。

剩余风险：

- `bookshelfId` 和 `bookId` 当前缺少显式安全 ID schema。正常 ID 下不污染单书包；
  任意字符串输入的路径穿越防护仍应由后续实现补强。

## I02 只写 catalog/bookshelves 派生物

status: PASS

证据：

- 实现只在 `catalog/bookshelves/{bookshelfId}/staging/{generation}`、
  `catalog/bookshelves/{bookshelfId}/current` 和
  `catalog/bookshelves/{bookshelfId}/CURRENT.json` 下发布 membership 派生物。
- 真实产物位于
  `graph_vault/catalog/bookshelves/software-architecture-core/current`，文件包括
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、`bookshelf_members.json`、
  `membership_decisions.jsonl`、`bookshelf_split_plan.json`、`state/*` 和
  `runs/*`。
- 审计范围内未发现 membership 代码写入 `graph_vault/books/**`、
  `graph_vault/catalog/batch-runs/**` 或查询运行目录。

剩余风险：

- 与 I01 相同，`bookshelfId` 未被限制为路径安全标识符。基于可信参数运行时满足
  该项；若 CLI 接收不可信 ID，需要显式拒绝 `/`、`..`、URL scheme 和盘符路径。

## I03 不读取 catalog/batch-runs 作为语义输入

status: PASS

证据：

- `src/graphrag/upper-index/bookshelf-membership.ts`、
  `scripts/graphrag/build-bookshelf-membership.mjs` 和
  `test/graphrag-bookshelf-membership.test.ts` 中未出现 `batch-runs` 或
  `catalog/batch-runs`。
- membership 成员证据只引用 `books/{bookId}/BOOK_MANIFEST.json`、
  `books/{bookId}/PUBLISH_READY.json`、`state/hotplug-quality-gate.json` 和
  `state/hotplug-runtime-gate.json`。
- Type DD 禁止 membership 使用 runner ledger events 作为 classification
  evidence，并禁止 `catalog/batch-runs/**` 作为语义输入。

剩余风险：

- 代码允许 `policy.sourceKind` 选择 taxonomy 或 deterministic rule，但本轮实现尚未
  接入外部 taxonomy 文件。后续扩展 taxonomy 输入时必须继续隔离 runner ledger。

## I04 只接受包内 publish/quality/runtime gate 通过成员

status: PASS

证据：

- `readBookManifest` 要求 `BOOK_MANIFEST.json` 存在，否则抛出
  `upper_quality_gate_failed:missing_manifest:{bookId}`。
- `readBookManifest` 要求 `PUBLISH_READY.json` 存在，否则抛出
  `upper_quality_gate_failed:missing_publish_marker:{bookId}`。
- 包内 `state/hotplug-quality-gate.json` 必须满足 `status=passed` 且
  `copyDistributionAllowed=true`。
- 包内 `state/hotplug-runtime-gate.json` 必须满足
  `currentState=query_ready`、`queryReady=true` 和
  `copyDistributionAllowed=true`。
- 实现还调用 `validatePublishedBookHotplugPackage` 和
  `validateHotplugRuntimeQueryGate`，并要求 manifest 中 `graphrag.queryReady`
  为 true。
- 真实三个成员包的 hotplug quality gate 均为 `passed`，runtime gate 均为
  `query_ready` 且 `queryReady=true`。

剩余风险：

- failure 使用字符串化 `Error` 表示 typed failure。语义上已带
  `upper_quality_gate_failed` 前缀，但不是结构化错误对象。

## I05 membership manifest queryReady=false 且不发布 BOOKSHELF_MANIFEST

status: PASS

证据：

- `BookshelfMembershipManifestSchema` 固定
  `bookshelfIdentity.queryReady` 为 `false`。
- membership quality gate schema 固定 `readyState=membership_resolved` 且
  `queryReady=false`。
- manifest `nextStage.requiredManifest` 固定为 `BOOKSHELF_MANIFEST.json`，规则明确
  membership manifest 不授予书架查询就绪。
- 真实
  `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MEMBERSHIP_MANIFEST.json`
  中 `bookshelfIdentity.queryReady=false`。
- 真实 `current` 目录不存在 `BOOKSHELF_MANIFEST.json`。
- `test/graphrag-bookshelf-membership.test.ts` 明确断言
  `BOOKSHELF_MANIFEST.json` 不存在。

剩余风险：

- 后续查询层不得把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 注册为 query-ready scope。
  当前 membership 实现本身未执行该注册。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery-summary 闭环

status: FAIL

证据：

- Type DD 的 membership 合同要求 membership 阶段输出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、checksum sidecar、
  `membership_decisions.jsonl`、`bookshelf_members.json`、split plan、
  `state/membership-quality-gate.json`、diagnostics、events、status、
  checkpoints 和 recovery-summary。
- 真实 `current` 目录存在上述文件及 `.sha256` sidecar，包括 3 个 checkpoint。
- `bookshelf_members.json`、`membership_decisions.jsonl`、
  `bookshelf_split_plan.json`、`state/membership-quality-gate.json`、
  `state/diagnostics.json`、events、status、recovery-summary 和 3 个 checkpoint
  的 sidecar checksum 均与文件内容一致。
- 真实 `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256` 也与最终 manifest 文件内容一致：
  `0a15e8fd01f2b94a5376c6621dc4e9afce22334e579c52b534eb7b271e811abf`。
- 但 manifest 内 `files[]` 对自身
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 记录的 digest 为
  `64e81d1cb1086edc0174720fc868d37a88b1bf8bc7a60bad227b156981812481`，
  与最终文件实际 digest
  `0a15e8fd01f2b94a5376c6621dc4e9afce22334e579c52b534eb7b271e811abf`
  不一致。
- 根因位于实现写入顺序：先写 manifest，取得 `writtenManifest`，再把该旧 digest
  放入 `files[]` 生成 `completeManifest` 并重写 manifest；重写后的 digest 不再等于
  `files[]` 中保存的旧 digest。
- `validateBookshelfMembership({ graphVault: "graph_vault",
  bookshelfId: "software-architecture-core" })` 对真实产物返回
  `{"ok":true,"diagnostics":[],"memberCount":3}`，说明 validator 未检查
  manifest `files[]` 中每个条目的实际 checksum，尤其未捕获 manifest 自身 digest
  漂移。

剩余风险：

- 下游如果信任 manifest `files[]`，会把不一致的自身 digest 当作闭环证据。
- 目前验证器只检查关键 digest 字段和若干文件存在性，未形成完整
  manifest-to-files checksum closure。

## I07 typed failure 不发布 current

status: PASS

证据：

- 成员 gate 失败路径在 `collectMembers` 阶段触发，发生在 staging 提升为
  `current` 之前。
- `test/graphrag-bookshelf-membership.test.ts` 删除一个成员包的
  `state/hotplug-runtime-gate.json` 后，`resolveBookshelfMembership` 抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，并断言目标
  `catalog/bookshelves/architecture-core/current` 不存在。
- membership 写入 `current` 的 rename 发生在 manifest、gate、diagnostics、
  run status、events、recovery-summary 和 checkpoints 写完之后。

剩余风险：

- typed failure 目前是错误消息字符串，不是统一 typed error 数据结构。
- 若未来在 current rename 之后增加失败校验，需要保持 publish marker 和 current
  提升顺序的 fail-closed 约束。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

status: PASS

证据：

- membership 可发布产物中的成员路径为 `books/{bookId}/...` 或
  `state/...`、`runs/...` 等相对 locator。
- 真实 `current` 产物未出现 `/Users/`、`/var/`、`/private/`、`graph_vault/`
  等绝对或仓库根 locator。
- 真实 manifest 中出现的 `providerRequestPayload`、`providerResponsePayload`、
  `rawPrompt`、`rawCompletion`、`apiKey`、`credential`、
  `absoluteLocalPath`、`queryLogContent` 仅作为
  `sensitivityPolicy.forbiddenFields` 的禁止字段名，不是敏感值。
- Type DD 明确禁止 raw LLM prompt/completion、provider payload、query log、
  absolute local path 和 runner ledger events 进入上层可发布产物。

剩余风险：

- `policy.decidedBy`、taxonomy 字段、`bookshelfId` 和 manifest title 目前没有
  独立 redaction schema。当前真实产物通过扫描；后续 CLI 应限制这些可写入字段的
  字符集、长度和禁止路径形态。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

status: PASS

证据：

- `test/graphrag-bookshelf-membership.test.ts` 的正向用例创建
  `book-shelf-a`、`book-shelf-b`、`book-shelf-c` 三个 query-ready hotplug 包，
  再 materialize membership generation。
- 真实
  `graph_vault/catalog/bookshelves/software-architecture-core/current/bookshelf_members.json`
  的 `members` 数量为 3。
- 三个真实成员分别为：
  `book-00474fb29e5e-59d02d41`、
  `book-04366e35670a-a4fc3c05`、
  `book-046be61c0c1b-0d3fd739`。
- 三个真实成员的 `BOOK_MANIFEST.json` 均声明 `graphrag.queryReady=true`，
  且 hotplug quality/runtime gate 均通过。
- `node scripts/graphrag/build-bookshelf-membership.mjs --help` 能从 `dist`
  载入 runnable target 并显示命令参数。

剩余风险：

- 未在审计中重新运行真实 target 写入同一个 `current`，避免改变真实产物时间戳和
  digest。已用真实 `current` 与 validator 结果证明当前 runnable 产物存在。

## I10 单书 GraphRAG 查询和单书质量门不回归

status: PASS

证据：

- membership 实现未修改单书 GraphRAG 查询路由、runtime bridge、hotplug quality
  gate 或 runtime gate 代码路径。
- `npm run test:node -- test/cli-graphrag-route.test.ts` 通过，9 项测试通过，
  覆盖 `qmd query --graphrag`、`--graph-book-id` 单书选择、多书无 scope 拒绝和
  auto route。
- `npm run test:node -- test/graphrag-book-hotplug-runtime-gate.test.ts` 通过，
  9 项测试通过，覆盖 manifest sidecar、publish marker、runtime compatibility、
  artifact metadata 和 producer binding 的 fail-closed 行为。
- `npm run test:node -- test/graphrag-book-hotplug-creation-gate.test.ts` 通过，
  1 项测试通过，覆盖单书创建只在 package validation gates 通过后发布。
- `npm run test:types` 通过。

剩余风险：

- 本轮没有实现书架级 query-ready `BOOKSHELF_MANIFEST.json`，因此 I10 只证明
  单书 GraphRAG 查询和单书质量门未回归，不证明书架查询能力已可用。

## 验证命令

- `npm run test:node -- test/graphrag-bookshelf-membership.test.ts`
  结果：1 个测试文件通过，2 项测试通过。
- `npm run test:types`
  结果：通过。
- `node --import tsx -e "import { validateBookshelfMembership } from
  './src/graphrag/upper-index/bookshelf-membership.ts'; const result = await
  validateBookshelfMembership({ graphVault: 'graph_vault', bookshelfId:
  'software-architecture-core' }); console.log(JSON.stringify(result, null, 2));"`
  结果：`ok=true`、`diagnostics=[]`、`memberCount=3`。
- `npm run test:node -- test/cli-graphrag-route.test.ts`
  结果：1 个测试文件通过，9 项测试通过。
- `npm run test:node -- test/graphrag-book-hotplug-runtime-gate.test.ts`
  结果：1 个测试文件通过，9 项测试通过。
- `npm run test:node -- test/graphrag-book-hotplug-creation-gate.test.ts`
  结果：1 个测试文件通过，1 项测试通过。

## 修复门槛

overallStatus 从 FAIL 转为 PASS 的最低条件：

- 重新设计 membership manifest 自身 digest 表达，避免不可满足的自引用 checksum，
  或明确从 `files[]` 排除 manifest 自身并由 sidecar 证明 manifest digest。
- `validateBookshelfMembership` 必须检查 manifest `files[]` 每个条目的存在性、bytes
  和 sha256，并检查对应 `.sha256` sidecar。
- 真实
  `graph_vault/catalog/bookshelves/software-architecture-core/current` 重新生成后，
  manifest `files[]`、sidecars、membership digests、gate、status、events、
  checkpoints 和 recovery-summary 必须全量一致。
