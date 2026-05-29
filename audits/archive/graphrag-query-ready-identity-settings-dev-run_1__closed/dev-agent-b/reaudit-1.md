Result: PASS

## Findings

无阻断发现。

## Criteria Review

1. PASS. 运行时契约继续保留 `bookId`、`sourceId`、`sourceHash`、
   `documentId`、`contentHash`、`normalizedPath` 和 GraphRAG text unit ids。
2. PASS. Document identity sidecar 仍为 book-scoped portable evidence，不依赖
   host absolute path。
3. PASS. Sidecar adoption 在 catalog repair 前校验 `sourceHash`、
   `contentHash`、`documentId`、`normalizedPath` 和 text unit existence。
4. PASS. Sidecar mismatch 会 fail-closed，不会静默覆盖 catalog state。
5. PASS. 缺失的 `DocumentIdentityMap` graph projection 只从有效 sidecar 或
   GraphRAG output 映射恢复，后续 query-ready publication 仍受 producer 和
   artifact validation 约束。
6. PASS. Graph capability publication 继续依赖 qmd corpus registration 和有效
   query-ready artifacts。
7. PASS. Capability scope 只引用 selected book/source/document 的 ready
   `graph_query` capability ids。
8. PASS. Stale same-book、same-title 或不同 content identity artifacts 不能满足
   readiness；producer lineage、content hash、provider fingerprint 和
   book-scoped output locator 都被重新验证。
9. PASS. graph capability 不可用时，query route refusal 仍为 typed
   `capability_missing` error。
10. PASS. 测试覆盖 missing identity、sidecar mismatch、normalized path
    mismatch、missing capability projection 和 stale producer lineage。

## Evidence

- `src/contracts/corpus.ts:62` 定义 `DocumentIdentityMapSchema`，包含 canonical
  source/document/content identity 与 portable `normalizedPath`。
- `src/contracts/corpus.ts:78` 定义 `GraphTextUnitIdentityMapSchema`，要求
  `bookId/sourceId/sourceHash/documentId/contentHash/normalizedPath`、
  `graphDocumentId` 和非空 `graphTextUnitIds`。
- `src/contracts/book-job.ts:85` 与 `src/contracts/book-job.ts:151` 保持
  book job/artifact locators portable，并要求 high-cost stage fingerprint fields。
- `src/job-state/graphrag-book.ts:653` 至 `src/job-state/graphrag-book.ts:662`
  校验 sidecar identity 全字段；`src/job-state/graphrag-book.ts:815` 至
  `src/job-state/graphrag-book.ts:827` 校验 sidecar text units 存在。
- `src/job-state/graphrag-book.ts:898` 至 `src/job-state/graphrag-book.ts:945`
  在 qmd corpus registration 前校验 normalized content hash，并写入 corpus
  registration projection。
- `src/job-state/graphrag-book.ts:1175` 至 `src/job-state/graphrag-book.ts:1197`
  校验 GraphRAG output producer manifest 的 book/source/document/content
  identity、provider fingerprint、stage fingerprints 和 portable output locator。
- `src/job-state/graphrag-book.ts:1402` 至 `src/job-state/graphrag-book.ts:1545`
  要求 query-ready producer artifacts 满足 producer run ids、stage
  fingerprints、provider fingerprint、corpus content hash 和 book-scoped output。
- `src/job-state/graphrag-book.ts:1689` 至 `src/job-state/graphrag-book.ts:1703`
  在 query-ready artifacts 存在时要求 qmd corpus registration，并触发 required
  graph identity adoption。
- `src/job-state/repository.ts:1245` 至 `src/job-state/repository.ts:1290`
  只有在 book/source/document/content identity 匹配时更新 graph text unit
  projection。
- `src/job-state/repository.ts:2472` 至 `src/job-state/repository.ts:2503`
  在接受 succeeded `query_ready` checkpoint 前验证 producer stages 和
  query-ready artifacts。
- `src/job-state/repository.ts:2555` 至 `src/job-state/repository.ts:2661`
  只在 validated `query_ready` checkpoint 后发布 graph capabilities。
- `src/job-state/repository.ts:2664` 至 `src/job-state/repository.ts:2698`
  要求 qmd corpus registration、`graphDocumentId` 和非空
  `graphTextUnitIds`。
- `src/job-state/artifact-validation.ts:477` 至
  `src/job-state/artifact-validation.ts:580` 校验 artifact id、kind、book id、
  producer run id、stage/provider fingerprints、corpus content hash 和 artifact
  bytes；`src/job-state/artifact-validation.ts:583` 至
  `src/job-state/artifact-validation.ts:598` 强制 GraphRAG output 为
  `books/<bookId>/output` 范围。
- `src/graphrag/capability-catalog.ts:322` 至
  `src/graphrag/capability-catalog.ts:365` 只保留 ready、具有 qmd corpus graph
  identity 且 query-ready lineage 有效的 explicit capabilities。
- `src/graphrag/capability-catalog.ts:383` 至
  `src/graphrag/capability-catalog.ts:486` 只从 validated book state 派生 ready
  capabilities，并按 requested source/document scope 过滤。
- `scripts/graphrag/resume-book-workspace.mjs:405` 至
  `scripts/graphrag/resume-book-workspace.mjs:428` 从 selected book 的 ready
  graph query capabilities 构造 query scope。
- `src/query/unified-router.ts:481` 至 `src/query/unified-router.ts:494` 在显式
  GraphRAG 请求无 capability 时抛出 typed `capability_missing` error。
- `test/graphrag-book-state.test.ts:778` 验证 valid sidecar 修复 missing catalog
  graph identity；`test/graphrag-book-state.test.ts:876` 验证 stale/mismatched
  sidecar 被拒绝；`test/graphrag-book-state.test.ts:972` 验证
  `normalizedPath` mismatch 被拒绝。
- `test/graphrag-book-state.test.ts:1334` 验证 query-ready publication 使用
  book-scoped validated artifacts 并拒绝 stale producer lineage；
  `test/graphrag-book-state.test.ts:2010` 验证无 qmd corpus registration 时拒绝
  query-ready publication。
- `test/unified-query.test.ts:969`、`test/unified-query.test.ts:1001` 和
  `test/unified-query.test.ts:1036` 分别覆盖缺失 graph identity、identity
  mismatch 和缺失 qmd corpus registration 时不派生 capability。
- `test/cli.test.ts:3944` 覆盖 missing identity 与 missing capability projection
  gate failure 的 fixed repair metadata；`test/cli.test.ts:7294` 覆盖 stale
  GraphRAG producer lineage reopen。

## Residual Risks

- 本次按“只允许写入报告文件”约束执行静态审计，未运行会创建临时工作区或测试产物
  的测试命令。
- 当前工作树包含 settings projection repair 相关改动。复审未发现其破坏本基准范围
  内的 identity sidecar、qmd corpus registration 或 graph capability publication
  invariant；settings repair 自身不在本报告的阻断审计范围内。
