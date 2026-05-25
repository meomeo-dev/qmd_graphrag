Result: PASS

## Findings

无阻断发现。

## Criteria Review

1. PASS. 运行时契约（runtime contracts）保留 `bookId`、`sourceId`、
   `sourceHash`、`documentId`、`contentHash`、`normalizedPath` 和 GraphRAG
   text unit ids。
2. PASS. Document identity sidecar 保持 book-scoped 且 portable，不依赖宿主机
   absolute path。
3. PASS. Sidecar adoption 在修复 catalog 前校验 `sourceHash`、`contentHash`、
   `documentId`、`normalizedPath` 和 text unit existence。
4. PASS. Sidecar mismatch 会 fail-closed，不会静默覆盖 catalog state。
5. PASS. 缺失的 `DocumentIdentityMap` graph projection 只从有效 sidecar 或已验证
   GraphRAG output 恢复。
6. PASS. Graph capability publication 依赖 qmd corpus registration 和有效
   query-ready artifacts。
7. PASS. Capability scope 只引用所选 book/source/document 的 ready graph
   capability ids。
8. PASS. Stale same-book 或 same-title artifacts 不能满足不同 content identity。
9. PASS. graph capability 不可用时，query route refusal 保持 typed error。
10. PASS. 测试覆盖 missing identity、sidecar mismatch、normalized path mismatch、
    missing capability projection 和 stale producer lineage。

## Evidence

- `src/contracts/corpus.ts:62` 定义 `DocumentIdentityMapSchema`，包含 canonical
  source/document/content identity 与 `normalizedPath`。
- `src/contracts/corpus.ts:78` 定义 `GraphTextUnitIdentityMapSchema`，包含
  `bookId`、`sourceId`、`sourceHash`、`documentId`、`contentHash`、
  `normalizedPath`、`graphDocumentId` 和非空 `graphTextUnitIds`。
- `src/contracts/book-job.ts:85` 与 `src/contracts/book-job.ts:151` 保留 portable
  book job/artifact identity，并要求 high-cost stages 的 stage/provider
  fingerprints。
- `src/contracts/batch-run.ts:46` 拒绝 absolute、URI 和 parent traversal batch
  locators。
- `src/job-state/graphrag-book.ts:629` 至 `src/job-state/graphrag-book.ts:663`
  在 sidecar adoption 前校验全部身份字段。
- `src/job-state/graphrag-book.ts:755` 至 `src/job-state/graphrag-book.ts:827`
  校验 sidecar text units 存在，mismatch 时抛出错误。
- `src/job-state/graphrag-book.ts:898` 至 `src/job-state/graphrag-book.ts:949`
  仅在 normalized content hash 与 graph identity 一致后登记 qmd corpus。
- `src/job-state/graphrag-book.ts:1175` 至 `src/job-state/graphrag-book.ts:1197`
  验证 producer manifest 与当前 book/source/document/content identity 一致。
- `src/job-state/graphrag-book.ts:1402` 至 `src/job-state/graphrag-book.ts:1545`
  要求当前 producer lineage 和 query-ready artifacts 有效。
- `src/job-state/graphrag-book.ts:1689` 至 `src/job-state/graphrag-book.ts:1703`
  在 query-ready artifacts 存在时要求 qmd corpus registration 和 graph identity。
- `src/job-state/artifact-validation.ts:477` 至
  `src/job-state/artifact-validation.ts:580` 校验 artifact kind、book id、producer
  run id、fingerprints、corpus content hash、path 和 content hash。
- `src/job-state/artifact-validation.ts:583` 至
  `src/job-state/artifact-validation.ts:598` 强制 GraphRAG output 为
  `books/<bookId>/output` 范围。
- `src/job-state/repository.ts:1245` 至 `src/job-state/repository.ts:1290` 只在
  book/source/document/content identity 匹配时更新 graph text unit identity。
- `src/job-state/repository.ts:2472` 至 `src/job-state/repository.ts:2503` 在接受
  succeeded `query_ready` checkpoint 前验证 producer stages 与 query-ready
  artifacts。
- `src/job-state/repository.ts:2555` 至 `src/job-state/repository.ts:2661` 只在
  validated `query_ready` 后发布 graph capabilities。
- `src/job-state/repository.ts:2664` 至 `src/job-state/repository.ts:2698` 要求 qmd
  corpus registration、`graphDocumentId` 和非空 `graphTextUnitIds`。
- `src/graphrag/capability-catalog.ts:322` 至
  `src/graphrag/capability-catalog.ts:365` 通过 graph identity 和 validated
  query-ready lineage 过滤 explicit capabilities。
- `src/graphrag/capability-catalog.ts:383` 至
  `src/graphrag/capability-catalog.ts:486` 只从 validated book state 派生 ready
  capabilities 并按 requested scope 过滤。
- `scripts/graphrag/resume-book-workspace.mjs:405` 至
  `scripts/graphrag/resume-book-workspace.mjs:428` 从 ready graph capabilities 构造
  selected book 的 query capability scope。
- `src/query/unified-router.ts:431` 至 `src/query/unified-router.ts:495` 对显式
  GraphRAG 请求且无 capability 的情况抛出 typed `capability_missing` error。
- `test/graphrag-book-state.test.ts:778` 验证从 validated sidecar 修复 catalog
  graph identity。
- `test/graphrag-book-state.test.ts:876` 验证 stale 或 mismatched sidecar 被拒绝。
- `test/graphrag-book-state.test.ts:972` 验证 `normalizedPath` mismatch 被拒绝。
- `test/graphrag-book-state.test.ts:1334` 验证 query-ready publication 使用
  book-scoped validated artifacts，并拒绝 stale producer ids。
- `test/graphrag-book-state.test.ts:1992` 验证无 qmd corpus registration 时拒绝
  query-ready publication。
- `test/cli.test.ts:3944` 验证 missing identity 与 missing capability projection
  failure 会进入固定本地修复元数据路径。
- `test/cli.test.ts:7170` 验证 stale GraphRAG producer lineage 会重新打开为 stale，
  不会被当作 ready。
- `docs/architecture/unified-retrieval-plane.md:345` 至
  `docs/architecture/unified-retrieval-plane.md:378` 记录 identity、sidecar、
  producer lineage 和 query-ready publication invariants。
- `docs/operations/graphrag-epub-batch-runbook.md:145` 至
  `docs/operations/graphrag-epub-batch-runbook.md:194` 记录 fail-closed checks 和
  required regressions。

## Residual Risks

- 本次为静态审计（static audit），未执行测试套件；结论基于已读取的代码、测试和
  设计文档。
- `recordGraphTextUnitIdentityIfAvailable()` 会在非 required 阶段预填充 graph
  identity projection。当前 capability publication 仍由 qmd corpus registration
  和 query-ready artifact validation 阻断；后续可考虑把预填充也显式绑定到
  validated producer manifest，以减少审计歧义。
