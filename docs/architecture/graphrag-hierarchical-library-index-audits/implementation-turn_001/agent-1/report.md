# Membership Implementation Audit Agent 1

auditDate: 2026-06-06
overallStatus: FAIL

审计范围（scope）：

- `src/graphrag/upper-index/bookshelf-membership.ts`
- `scripts/graphrag/build-bookshelf-membership.mjs`
- `test/graphrag-bookshelf-membership.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

阻断项（blocking items）：I06。其余项目在当前审计边界内通过，
但 I10 仍保留更宽 runner 回归套件失败的风险记录。

## Verification Summary

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-bookshelf-membership.test.ts`：
  2 tests passed。
- `node scripts/graphrag/build-bookshelf-membership.mjs` 在临时
  `graph_vault` 中复制 3 个真实 ready book package 后返回
  `ok: true`、`memberCount: 3`、`queryReady: false`。
- `node --input-type=module` 调用 `dist` validator 校验真实
  `software-architecture-core/current`：`ok: true`、`memberCount: 3`。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-book-hotplug-catalog.test.ts`：
  12 tests passed。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli-graphrag-route.test.ts`：
  9 tests passed。
- `npm run test:types` passed。
- 风险命令：`test/graphrag-runner-query-ready-manifest.test.ts`
  当前运行结果为 8 failed / 2 passed，含 timeout 与 runner status
  断言失败。该结果不改变 membership 直接基准判断，但不能被忽略。

## I01 单书包不被污染

status: PASS

证据（evidence）：

- Type DD 将 catalog 定义为派生状态，且不得改变单书包身份、文件闭包
  或单书查询的 `query_ready` 判定：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:980`。
- membership root 固定为
  `graphVault/catalog/bookshelves/{bookshelfId}`，写入 staging/current 与
  `CURRENT.json` 均从该 root 派生：
  `src/graphrag/upper-index/bookshelf-membership.ts:527`、
  `src/graphrag/upper-index/bookshelf-membership.ts:751`。
- 成员记录只持有包相对定位符（relative locator），例如
  `packageRoot: books/{bookId}` 和 `books/{bookId}/graphrag/output/**`：
  `src/graphrag/upper-index/bookshelf-membership.ts:408`。
- 真实 membership current 仅引用 3 个单书包，并未在
  `graph_vault/books/{bookId}` 下生成 membership 文件。

剩余风险（remaining risk）：

- 测试只验证单书 `BOOK_MANIFEST.json` 仍存在，未做完整的
  `graph_vault/books/**` 写入快照断言。

## I02 只写 catalog/bookshelves 派生物

status: PASS

证据：

- 实现只在 `catalog/bookshelves/{bookshelfId}` 下创建
  `staging/{generation}`、提升为 `current`，并写入 `CURRENT.json`：
  `src/graphrag/upper-index/bookshelf-membership.ts:527`、
  `src/graphrag/upper-index/bookshelf-membership.ts:625`、
  `src/graphrag/upper-index/bookshelf-membership.ts:757`。
- CLI 仅把 `--graph-vault`、`--bookshelf-id` 和重复 `--book-id`
  传给 resolver/validator，不额外写其他根：
  `scripts/graphrag/build-bookshelf-membership.mjs:53`。
- 真实 `software-architecture-core` 下可见产物为
  `CURRENT.json`、`current/**` 与空 `staging/` 目录，均位于
  `graph_vault/catalog/bookshelves/software-architecture-core`。

剩余风险：

- `CURRENT.json` 是 catalog/bookshelves publish pointer（发布指针），
  但 membership Type DD 的 `stateWrites` 未显式列出该文件；需在合同
  中确认它属于通用 publish marker，而非额外未声明产物。

## I03 不读取 catalog/batch-runs 作为语义输入

status: PASS

证据：

- Type DD 硬约束禁止 `catalog/batch-runs/**`、`runs/**`、`events.jsonl`
  与 recovery summaries 作为成员推断或 GraphRAG 语义输入：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:984`。
- membership 实现中未出现 `batch-runs` 读取；成员决策 evidenceRefs
  限定为 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 quality gate
  与 runtime gate：
  `src/graphrag/upper-index/bookshelf-membership.ts:378`。
- 单书 layout helper 解析的是 `graph_vault/books/{bookId}` 下的
  `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json`：
  `src/graphrag/book-package-layout.ts:16`。

剩余风险：

- runtime gate validator 会校验包内 producer run bindings
  （package-local lineage），但当前审计未发现它读取
  `catalog/batch-runs` 作为 membership 语义输入。

## I04 只接受包内 publish/quality/runtime gate 通过成员

status: PASS

证据：

- `readBookManifest` 依次检查 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  `state/hotplug-quality-gate.json`、`state/hotplug-runtime-gate.json`、
  published package boundary、runtime query gate 与
  `manifest.graphrag.queryReady`：
  `src/graphrag/upper-index/bookshelf-membership.ts:291`、
  `src/graphrag/upper-index/bookshelf-membership.ts:314`、
  `src/graphrag/upper-index/bookshelf-membership.ts:322`、
  `src/graphrag/upper-index/bookshelf-membership.ts:325`、
  `src/graphrag/upper-index/bookshelf-membership.ts:330`、
  `src/graphrag/upper-index/bookshelf-membership.ts:344`。
- membership 测试删除一个成员的 runtime gate 后，resolver 抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，且不创建 current：
  `test/graphrag-bookshelf-membership.test.ts:207`。
- 真实 current 的 3 个成员均存在 `BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、hotplug quality gate、runtime gate，且
  membership member 记录均为 `queryReady: true`。

剩余风险：

- 当前 membership stage 不重新计算单书 gate，只验证已发布 gate 状态；
  这符合 package-first authority（包优先权威），但依赖单书发布阶段
  的完整性。

## I05 membership manifest queryReady=false 且不发布 BOOKSHELF_MANIFEST

status: PASS

证据：

- membership manifest schema 要求
  `bookshelfIdentity.queryReady` 为 `false`：
  `src/graphrag/upper-index/bookshelf-membership.ts:116`。
- 写入 manifest 时显式设置 `queryReady: false`，并把下一阶段要求声明为
  `BOOKSHELF_MANIFEST.json`：
  `src/graphrag/upper-index/bookshelf-membership.ts:691`、
  `src/graphrag/upper-index/bookshelf-membership.ts:709`。
- quality gate 与 `CURRENT.json` 同样声明 `queryReady: false`：
  `src/graphrag/upper-index/bookshelf-membership.ts:560`、
  `src/graphrag/upper-index/bookshelf-membership.ts:757`。
- membership 测试断言 manifest `queryReady` 为 false，且
  `BOOKSHELF_MANIFEST.json` 不存在：
  `test/graphrag-bookshelf-membership.test.ts:175`、
  `test/graphrag-bookshelf-membership.test.ts:186`。
- 真实 current 中 `hasBookshelfManifest: false`，
  `nextRequiredManifest: BOOKSHELF_MANIFEST.json`。

剩余风险：

- 无。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery 闭环

status: FAIL

证据：

- 真实 current 的 12 个主文件均有 `.sha256` sidecar，sidecar checksum
  与实际文件内容一致。
- manifest 中 `membersDigest`、`decisionsDigest`、`splitPlanDigest`
  分别与 `bookshelf_members.json`、`membership_decisions.jsonl`、
  `bookshelf_split_plan.json` 实际 digest 一致。
- quality gate、diagnostics、events、status、recovery-summary 与 3 个
  checkpoint 文件均存在；真实 runId 为
  `software-architecture-core-membership-441f83a0fc86eabd`。
- 但 manifest 自身在 `files[]` 中记录的
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 条目不等于最终文件：
  记录 `sha256=64e81d1cb1086edc0174720fc868d37a88b1bf8bc7a60bad227b156981812481`、
  `bytes=3902`；实际
  `sha256=0a15e8fd01f2b94a5376c6621dc4e9afce22334e579c52b534eb7b271e811abf`、
  `bytes=4071`。
- 根因位置：实现先写初版 manifest，取该次写入的 digest 加入
  `completeFiles`，随后又重写最终 manifest，但没有更新 manifest
  自身的 `files[]` 条目：
  `src/graphrag/upper-index/bookshelf-membership.ts:734`、
  `src/graphrag/upper-index/bookshelf-membership.ts:738`、
  `src/graphrag/upper-index/bookshelf-membership.ts:746`。
- validator 未校验 `manifest.files[]` 每个条目的 sha/bytes 与真实文件
  是否一致；其校验集中在 schema、成员数量、成员 digest、决策 digest
  与 split plan digest：
  `src/graphrag/upper-index/bookshelf-membership.ts:810`、
  `src/graphrag/upper-index/bookshelf-membership.ts:836`。

剩余风险：

- 下游 handoff 若信任 `manifest.files[]`，会看到过期 manifest digest；
  audit replay（审计重放）与 publish closure（发布闭包）不自洽。

## I07 typed failure 不发布 current

status: PASS

证据：

- 包缺失、publish marker 缺失、quality gate 失败、runtime gate 失败、
  boundary 失败、runtime query gate 失败、manifest schema 失败与
  member not query-ready 均使用 `upper_quality_gate_failed:*` typed error：
  `src/graphrag/upper-index/bookshelf-membership.ts:293`。
- `llm_suggested` 直接抛出
  `upper_quality_gate_failed:llm_suggestion_not_query_ready`：
  `src/graphrag/upper-index/bookshelf-membership.ts:514`。
- current promotion 发生在成员收集、gate、diagnostics、events、status、
  recovery-summary、checkpoint 与 manifest 写入之后：
  `src/graphrag/upper-index/bookshelf-membership.ts:535`、
  `src/graphrag/upper-index/bookshelf-membership.ts:751`。
- membership 失败测试证明缺少 runtime gate 时 resolver reject，且
  `catalog/bookshelves/{bookshelfId}/current` 不存在：
  `test/graphrag-bookshelf-membership.test.ts:232`、
  `test/graphrag-bookshelf-membership.test.ts:240`。

剩余风险：

- resolver 在成员收集前创建 staging 目录；若成员校验失败，可能留下
  空 staging generation。该残留不是 current publish，但应纳入后续
  recovery/cleanup 策略。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

status: PASS

证据：

- membership decisions 的 evidenceRefs 为 graph_vault-relative package
  locator：
  `src/graphrag/upper-index/bookshelf-membership.ts:378`。
- member `packageRoot` 与 `graphArtifacts` 均为相对路径：
  `src/graphrag/upper-index/bookshelf-membership.ts:408`。
- manifest `files[]` 使用 scope-relative path：
  `src/graphrag/upper-index/bookshelf-membership.ts:447`。
- manifest 内声明 forbidden fields 与 locator rule：
  `src/graphrag/upper-index/bookshelf-membership.ts:718`。
- 对真实 current 的结构化值扫描未发现 `/Users/...`、`/tmp/...`、
  bearer token、`sk-*` secret-like value 或绝对路径值。普通文本扫描命中
  的 `apiKey`、`credential`、`rawPrompt` 等仅为
  `sensitivityPolicy.forbiddenFields` 中的禁用字段名，不是泄漏值。

剩余风险：

- `title` 与 `decidedBy` 来自输入/manifest，当前 membership writer 未做
  独立 redaction。真实产物干净，但后续应增加字段级敏感扫描测试。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

status: PASS

证据：

- membership 单测构造 3 个 ready book package，并断言
  `memberCount: 3`、成员 id 顺序、checkpoint 存在：
  `test/graphrag-bookshelf-membership.test.ts:137`、
  `test/graphrag-bookshelf-membership.test.ts:173`、
  `test/graphrag-bookshelf-membership.test.ts:187`。
- CLI 支持重复 `--book-id`，并在运行后调用 validator：
  `scripts/graphrag/build-bookshelf-membership.mjs:13`、
  `scripts/graphrag/build-bookshelf-membership.mjs:37`、
  `scripts/graphrag/build-bookshelf-membership.mjs:62`。
- 真实 current 包含 3 个成员：
  `book-00474fb29e5e-59d02d41`、
  `book-04366e35670a-a4fc3c05`、
  `book-046be61c0c1b-0d3fd739`。
- 在临时复制的真实 `graph_vault/books/{bookId}` 上执行 CLI target，
  返回 `ok: true`、`memberCount: 3`、`queryReady: false`。

剩余风险：

- CLI 直接 import `dist/.../bookshelf-membership.js`。本次审计中 dist
  存在且 runnable target 通过，但源码与 dist 的同步应由 build/check
  流程持续保证。

## I10 单书 GraphRAG 查询和单书质量门不回归

status: PASS

证据：

- membership 实现没有改动 `qmd query --graphrag --graph-book-id` 路由；
  CLI 仍按 `graphBookId` 过滤 capability，并把单书
  `books/{bookId}/graphrag/output` 传给 runtime：
  `src/cli/qmd.ts:3479`、
  `src/cli/qmd.ts:3513`、
  `src/cli/qmd.ts:3546`。
- `test/cli-graphrag-route.test.ts` 通过 9 tests；其中
  `qmd query --graphrag uses the selected book scoped output` 断言
  `selectedBookIds=["book-cli-second"]`，并验证 request `dataDir`
  指向被选择的单书输出：
  `test/cli-graphrag-route.test.ts:928`。
- `test/graphrag-book-hotplug-catalog.test.ts` 通过 12 tests，覆盖
  单书 manifest `graphrag.queryReady`、hotplug quality/runtime gate、
  sensitive runtime reports 排除、provider payload 拒绝，以及缺失
  producer runs/artifact metadata 时不派生 query capability：
  `test/graphrag-book-hotplug-catalog.test.ts:263`、
  `test/graphrag-book-hotplug-catalog.test.ts:770`、
  `test/graphrag-book-hotplug-catalog.test.ts:851`、
  `test/graphrag-book-hotplug-catalog.test.ts:956`。

剩余风险：

- 更宽的 `test/graphrag-runner-query-ready-manifest.test.ts` 当前失败
  8 tests，包含 runner status 对 `qmdBuildStatus`、terminal evidence
  checksum fixture 与 timeout 的断言失败。该风险位于 runner/query-ready
  集成层，不是 membership 直接实现已覆盖的单书 CLI route 或 hotplug gate。

## Final Assessment

overallStatus: FAIL

membership 直接实现满足 package-first authority（包优先权威）、
catalog-only derivative writes（仅 catalog 派生写入）、不读取
`catalog/batch-runs` 作为语义输入、失败不发布 current、以及
membership 不授予 bookshelf query readiness 的核心约束。

发布闭包（publish closure）仍有阻断缺陷：最终
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与其 `files[]` 自身条目不一致。
修复前，不能把该 generation 视为完全可审计闭环。
