# Implementation Turn 002 Audit Agent 1

auditDate: 2026-06-06
overallStatus: PASS_WITH_RISK

审计范围（scope）：

- `src/graphrag/upper-index/bookshelf-membership.ts`
- `dist/graphrag/upper-index/bookshelf-membership.js`
- `scripts/graphrag/build-bookshelf-membership.mjs`
- `test/graphrag-bookshelf-membership.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

结论（conclusion）：

- implementation-turn_001 的 I06 阻断项已修复。
- 真实 `software-architecture-core/current` 的
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 中 `files[]` 不再包含自身。
- `files[]` 中 11 个闭包条目的 `sha256`、`bytes` 与实际文件和
  `.sha256` sidecar 一致。
- `validateBookshelfMembership` 已能捕获闭包 mismatch（closure mismatch）。
- 10 项固定基准在 membership 审计边界内通过。宽 runner query-ready
  集成套件仍失败，保留为非 membership 阻断的剩余风险。

## Verification Summary

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-bookshelf-membership.test.ts`：
  3 tests passed。
- 对真实 `graph_vault/catalog/bookshelves/software-architecture-core/current`
  执行独立闭包校验：`filesCount=11`、`hasSelfReference=false`、
  `closureIssues=[]`、`manifestSidecarMatches=true`。
- `validateBookshelfMembership({ graphVault: "graph_vault",
  bookshelfId: "software-architecture-core" })`：`ok: true`、
  `diagnostics: []`、`memberCount: 3`。
- 在临时副本中复制真实 current 和 3 个真实成员包后，只篡改
  `runs/.../status.json` 并同步更新该文件 sidecar；validator 返回
  `ok: false`，诊断为
  `manifest_file_sha256_mismatch:runs/software-architecture-core-\
  membership-441f83a0fc86eabd/status.json`。
- `node scripts/graphrag/build-bookshelf-membership.mjs --graph-vault \
  graph_vault --bookshelf-id software-architecture-core --book-id ...`：
  `ok: true`、`memberCount: 3`、`queryReady: false`。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-book-hotplug-catalog.test.ts`：
  12 tests passed。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli-graphrag-route.test.ts`：
  9 tests passed。
- `npm run test:types`：passed。
- 风险命令：`CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/graphrag-runner-query-ready-manifest.test.ts`：
  8 failed / 2 passed。失败集中在 runner status、terminal evidence
  checksum fixture、row-count checksum fixture 与 timeout；不改变本轮
  membership 直接基准判断。

## I01 单书包不被污染

status: PASS

证据（evidence）：

- Type DD 将 `graph_vault/catalog/**` 定义为派生状态，不得改变单书包
  身份、文件闭包或直接单书查询的 `query_ready` 判定：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:980`。
- membership root 固定为
  `graphVault/catalog/bookshelves/{bookshelfId}`；staging/current 与
  `CURRENT.json` 均从该 root 派生：
  `src/graphrag/upper-index/bookshelf-membership.ts:546`、
  `src/graphrag/upper-index/bookshelf-membership.ts:759`、
  `src/graphrag/upper-index/bookshelf-membership.ts:765`。
- 成员记录只保存包相对定位符（relative locator），例如
  `packageRoot: books/{bookId}` 与
  `books/{bookId}/graphrag/output/**`：
  `src/graphrag/upper-index/bookshelf-membership.ts:427`、
  `src/graphrag/upper-index/bookshelf-membership.ts:296`。
- 真实 current 仅引用 3 个单书包，未在
  `graph_vault/books/{bookId}` 下生成 membership 文件。

剩余风险（remaining risk）：

- 当前测试验证单书 `BOOK_MANIFEST.json` 仍存在，但未做完整
  `graph_vault/books/**` 写入快照断言。

## I02 只写 catalog/bookshelves 派生物

status: PASS

证据：

- 实现只在 `catalog/bookshelves/{bookshelfId}` 下创建
  `staging/{generation}`、提升为 `current`，并写入 `CURRENT.json`：
  `src/graphrag/upper-index/bookshelf-membership.ts:546`、
  `src/graphrag/upper-index/bookshelf-membership.ts:548`、
  `src/graphrag/upper-index/bookshelf-membership.ts:763`、
  `src/graphrag/upper-index/bookshelf-membership.ts:765`。
- CLI 只把 `--graph-vault`、`--bookshelf-id` 和重复 `--book-id`
  传给 resolver/validator，不声明其他写入根：
  `scripts/graphrag/build-bookshelf-membership.mjs:33`、
  `scripts/graphrag/build-bookshelf-membership.mjs:53`、
  `scripts/graphrag/build-bookshelf-membership.mjs:62`。
- 真实 `software-architecture-core` 的可见产物位于
  `graph_vault/catalog/bookshelves/software-architecture-core`。

剩余风险：

- `CURRENT.json` 属于 publish pointer（发布指针）。Type DD 应继续保持
  该指针与 membership 阶段 publish semantics 的一致命名。

## I03 不读取 catalog/batch-runs 作为语义输入

status: PASS

证据：

- Type DD 禁止 `catalog/batch-runs/**`、`runs/**`、`events.jsonl` 与
  recovery summaries 作为语义检索、成员推断或 GraphRAG 社区生成输入：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:984`。
- membership 成员 evidenceRefs 限定为包内
  `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、quality gate 与 runtime
  gate：
  `src/graphrag/upper-index/bookshelf-membership.ts:397`。
- `rg` 未发现 membership 实现读取 `catalog/batch-runs` 作为成员语义输入。

剩余风险：

- runtime gate validator 会校验包内 producer run bindings
  （package-local lineage），但本轮未发现其读取 `catalog/batch-runs`
  作为 membership 语义输入。

## I04 只接受包内 publish/quality/runtime gate 通过成员

status: PASS

证据：

- `readBookManifest` 依次检查 `BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、包内 `hotplug-quality-gate.json`、
  `hotplug-runtime-gate.json`、published package boundary、runtime query
  gate 与 manifest `graphrag.queryReady`：
  `src/graphrag/upper-index/bookshelf-membership.ts:310`、
  `src/graphrag/upper-index/bookshelf-membership.ts:315`、
  `src/graphrag/upper-index/bookshelf-membership.ts:328`、
  `src/graphrag/upper-index/bookshelf-membership.ts:336`、
  `src/graphrag/upper-index/bookshelf-membership.ts:344`、
  `src/graphrag/upper-index/bookshelf-membership.ts:349`、
  `src/graphrag/upper-index/bookshelf-membership.ts:363`。
- membership 失败测试删除成员 runtime gate 后，resolver 抛出
  `upper_quality_gate_failed:package_runtime_gate_failed`，且不创建 current：
  `test/graphrag-bookshelf-membership.test.ts:258`、
  `test/graphrag-bookshelf-membership.test.ts:283`、
  `test/graphrag-bookshelf-membership.test.ts:291`。
- 真实 current 的 3 个成员均存在 publish marker、quality gate 与 runtime
  gate，且单书 manifest `graphrag.queryReady=true`。

剩余风险：

- membership 阶段验证已发布 gate 状态，不重新计算单书 gate；该行为符合
  package-first authority（包优先权威）。

## I05 membership manifest queryReady=false 且不发布 BOOKSHELF_MANIFEST

status: PASS

证据：

- schema 要求 membership manifest 的
  `bookshelfIdentity.queryReady` 为 `false`：
  `src/graphrag/upper-index/bookshelf-membership.ts:127`。
- 写入 manifest 时显式设置 `queryReady: false`，并把下一阶段所需文件
  声明为 `BOOKSHELF_MANIFEST.json`：
  `src/graphrag/upper-index/bookshelf-membership.ts:715`、
  `src/graphrag/upper-index/bookshelf-membership.ts:730`。
- quality gate 与 `CURRENT.json` 同样声明 `queryReady: false`：
  `src/graphrag/upper-index/bookshelf-membership.ts:586`、
  `src/graphrag/upper-index/bookshelf-membership.ts:773`。
- membership 测试断言 manifest `queryReady=false`，且
  `BOOKSHELF_MANIFEST.json` 不存在：
  `test/graphrag-bookshelf-membership.test.ts:175`、
  `test/graphrag-bookshelf-membership.test.ts:191`。
- 真实 current 中未发布 `BOOKSHELF_MANIFEST.json`。

剩余风险：

- 无。

## I06 manifest/checksum/digest/gate/status/events/checkpoints/recovery 闭环

status: PASS

证据：

- generator 现在构造 `manifest.files[]` 时只列入 members、decisions、
  split plan、quality gate、diagnostics、events、status、recovery summary
  与 checkpoints；随后单独写入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`。`files[]` 不再包含 manifest
  自身：
  `src/graphrag/upper-index/bookshelf-membership.ts:741`、
  `src/graphrag/upper-index/bookshelf-membership.ts:753`；
  `dist/graphrag/upper-index/bookshelf-membership.js:582`、
  `dist/graphrag/upper-index/bookshelf-membership.js:594`。
- validator 逐项规范化 scope-relative path，禁止
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 自引用，检查实际 `bytes`、
  实际 `sha256` 与 `.sha256` sidecar：
  `src/graphrag/upper-index/bookshelf-membership.ts:845`、
  `src/graphrag/upper-index/bookshelf-membership.ts:851`、
  `src/graphrag/upper-index/bookshelf-membership.ts:860`、
  `src/graphrag/upper-index/bookshelf-membership.ts:862`、
  `src/graphrag/upper-index/bookshelf-membership.ts:865`、
  `src/graphrag/upper-index/bookshelf-membership.ts:873`。
- validator 还检查 manifest 自身 sidecar、members digest、decisions digest、
  split plan digest、run required files 与 member checkpoints：
  `src/graphrag/upper-index/bookshelf-membership.ts:877`、
  `src/graphrag/upper-index/bookshelf-membership.ts:882`、
  `src/graphrag/upper-index/bookshelf-membership.ts:886`、
  `src/graphrag/upper-index/bookshelf-membership.ts:890`、
  `src/graphrag/upper-index/bookshelf-membership.ts:904`、
  `src/graphrag/upper-index/bookshelf-membership.ts:915`。
- 真实 current 状态：
  `generation=membership-441f83a0fc86eabd`、
  `memberCount=3`、`queryReady=false`、`filesCount=11`、
  `hasSelfReference=false`、
  `manifestSha=59282a1e073882b199262c509b6beaaab73db4e4a61c3032ef0a116c900bf72f`、
  `manifestSidecarMatches=true`、`closureIssues=[]`。
- 真实 current 共有 12 个主文件及 12 个 sidecar；manifest `files[]`
  正确排除自身，仅列入 11 个可交接闭包文件。
- 在临时副本中只篡改 `runs/.../status.json` 并更新该文件 sidecar 后，
  `validateBookshelfMembership` 返回
  `manifest_file_sha256_mismatch:runs/software-architecture-core-\
  membership-441f83a0fc86eabd/status.json`，证明闭包 mismatch 可被捕获。
- `test/graphrag-bookshelf-membership.test.ts` 新增 mismatch 回归测试，
  篡改 `manifest.files[0].sha256` 后断言 validator 返回 false 并包含
  `manifest_file_sha256_mismatch:*`：
  `test/graphrag-bookshelf-membership.test.ts:212`、
  `test/graphrag-bookshelf-membership.test.ts:240`、
  `test/graphrag-bookshelf-membership.test.ts:248`。

剩余风险：

- 当前 validator 检查 checkpoint 文件存在及 sidecar 存在，但未逐个校验
  checkpoint sidecar 内容。由于 checkpoints 已列入 `manifest.files[]`，
  本轮真实闭包已通过逐项 sidecar 校验；后续可增加专门的 checkpoint
  sidecar 篡改测试。

## I07 typed failure 不发布 current

status: PASS

证据：

- 包缺失、publish marker 缺失、quality gate 失败、runtime gate 失败、
  boundary 失败、runtime query gate 失败、manifest schema 失败和
  member not query-ready 均使用 `upper_quality_gate_failed:*`：
  `src/graphrag/upper-index/bookshelf-membership.ts:312`、
  `src/graphrag/upper-index/bookshelf-membership.ts:315`、
  `src/graphrag/upper-index/bookshelf-membership.ts:333`、
  `src/graphrag/upper-index/bookshelf-membership.ts:341`、
  `src/graphrag/upper-index/bookshelf-membership.ts:345`、
  `src/graphrag/upper-index/bookshelf-membership.ts:350`、
  `src/graphrag/upper-index/bookshelf-membership.ts:356`、
  `src/graphrag/upper-index/bookshelf-membership.ts:363`。
- `llm_suggested` 直接 fail closed：
  `src/graphrag/upper-index/bookshelf-membership.ts:534`。
- current promotion 发生在成员收集、gate、diagnostics、events、status、
  recovery-summary、checkpoints 与 manifest 写入之后：
  `src/graphrag/upper-index/bookshelf-membership.ts:554`、
  `src/graphrag/upper-index/bookshelf-membership.ts:644`、
  `src/graphrag/upper-index/bookshelf-membership.ts:753`、
  `src/graphrag/upper-index/bookshelf-membership.ts:759`。
- 失败测试证明缺少 runtime gate 时 resolver reject，且
  `catalog/bookshelves/{bookshelfId}/current` 不存在：
  `test/graphrag-bookshelf-membership.test.ts:283`、
  `test/graphrag-bookshelf-membership.test.ts:291`。

剩余风险：

- resolver 在成员收集前创建 staging 目录。成员校验失败时可能留下空
  staging generation；该残留不是 current publish，但应纳入后续 cleanup
  策略。

## I08 敏感信息和绝对路径不进入可发布 membership 产物

status: PASS

证据：

- member evidenceRefs、`packageRoot` 与 graph artifacts 均为
  graph_vault-relative/package-relative locator：
  `src/graphrag/upper-index/bookshelf-membership.ts:397`、
  `src/graphrag/upper-index/bookshelf-membership.ts:427`、
  `src/graphrag/upper-index/bookshelf-membership.ts:296`。
- manifest `files[]` 使用 scope-relative path：
  `src/graphrag/upper-index/bookshelf-membership.ts:466`。
- validator 拒绝空路径、绝对路径、`..`、Windows drive path 与 URI-like
  path：
  `src/graphrag/upper-index/bookshelf-membership.ts:281`。
- manifest 声明 forbidden fields 与 locator rule：
  `src/graphrag/upper-index/bookshelf-membership.ts:737`。
- 对真实 current 的 12 个可发布主文件扫描未发现 `/Users/`、`/tmp/`、
  bearer token、`sk-*`、password-like assignment 等泄漏值。

剩余风险：

- `title` 与 `decidedBy` 来自输入或 package manifest；真实产物干净，
  但后续应增加字段级敏感扫描测试。

## I09 测试和真实 runnable target 覆盖至少 3 本 ready 包

status: PASS

证据：

- membership 单测构造 3 个 ready book package，并断言
  `memberCount=3`、成员 id 顺序、checkpoint 存在：
  `test/graphrag-bookshelf-membership.test.ts:132`、
  `test/graphrag-bookshelf-membership.test.ts:137`、
  `test/graphrag-bookshelf-membership.test.ts:173`、
  `test/graphrag-bookshelf-membership.test.ts:189`。
- CLI 支持重复 `--book-id`，运行后调用 validator，并输出 validation
  结果：
  `scripts/graphrag/build-bookshelf-membership.mjs:37`、
  `scripts/graphrag/build-bookshelf-membership.mjs:53`、
  `scripts/graphrag/build-bookshelf-membership.mjs:62`、
  `scripts/graphrag/build-bookshelf-membership.mjs:69`。
- 真实 current 包含 3 个成员：
  `book-00474fb29e5e-59d02d41`、
  `book-04366e35670a-a4fc3c05`、
  `book-046be61c0c1b-0d3fd739`。
- 真实 runnable target 返回 `ok=true`、`memberCount=3`、
  `queryReady=false`。

剩余风险：

- CLI import `dist/.../bookshelf-membership.js`。本轮确认 `dist` 与源码的
  I06 修复一致；后续仍应由 build/typecheck 保持同步。

## I10 单书 GraphRAG 查询和单书质量门不回归

status: PASS

证据：

- membership 实现不接入 `qmd query --graphrag --graph-book-id` 查询路径。
  单书查询仍按 `graphBookId` 过滤 capability，并把所选单书
  `graphrag/output` 作为 runtime dataDir：
  `src/cli/qmd.ts:3479`、
  `src/cli/qmd.ts:3516`、
  `src/cli/qmd.ts:3529`、
  `src/cli/qmd.ts:3546`、
  `src/cli/qmd.ts:3563`。
- `test/cli-graphrag-route.test.ts` 通过 9 tests；其中
  `qmd query --graphrag uses the selected book scoped output` 断言
  `selectedBookIds=["book-cli-second"]` 且 dataDir 指向该单书输出：
  `test/cli-graphrag-route.test.ts:928`、
  `test/cli-graphrag-route.test.ts:942`、
  `test/cli-graphrag-route.test.ts:946`。
- `test/graphrag-book-hotplug-catalog.test.ts` 通过 12 tests，覆盖单书
  manifest `graphrag.queryReady`、quality/runtime gate、runtime reports
  排除、provider payload 拒绝、producer runs 缺失和 artifact metadata
  缺失时不派生 query capability：
  `test/graphrag-book-hotplug-catalog.test.ts:263`、
  `test/graphrag-book-hotplug-catalog.test.ts:770`、
  `test/graphrag-book-hotplug-catalog.test.ts:851`、
  `test/graphrag-book-hotplug-catalog.test.ts:956`、
  `test/graphrag-book-hotplug-catalog.test.ts:1006`、
  `test/graphrag-book-hotplug-catalog.test.ts:1116`。

剩余风险：

- 宽 runner query-ready 集成套件仍失败 8/10。失败位于 batch runner
  recovery/status/fixture 层，不是 membership writer、validator、单书
  CLI route 或单书 hotplug quality gate 的直接回归证据。

## Final Assessment

implementation-turn_001 的 I06 bug 已修复并由源码、`dist`、真实 current、
单测和临时 mismatch 反例共同验证。membership 阶段仍只发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`，不授予 bookshelf query readiness，
不发布 `BOOKSHELF_MANIFEST.json`。本轮未修改实现代码。
