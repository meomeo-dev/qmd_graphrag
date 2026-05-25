# Dev Agent A Reaudit 1: Repository And Catalog Projection

本次复审仅使用 `baseline.md` 中 10 条固定基准，未新增或替换基准。

总体结论：DEV FAIL

失败原因：初审基准 1 的 qmd corpus registration metadata 覆盖问题已修复；
但基准 5 的 legacy catalog rewrite 仍可能引入同一 book/document 的重复
canonical identity，基准 8 仍缺少阻止 raw provider payload 进入 identity
metadata 的结构性边界。

## 基准 1

状态：PASS

证据：

- `src/job-state/repository.ts:1098` 至 `src/job-state/repository.ts:1114`
  按同一 `canonicalBookId/documentId/sourceHash/contentHash` 判定可保留身份。
- `src/job-state/repository.ts:1123` 至 `src/job-state/repository.ts:1131`
  仍先合并 existing 与 incoming metadata。
- `src/job-state/repository.ts:1132` 至 `src/job-state/repository.ts:1143`
  对 `qmdCorpusRegistered`、`qmdCollection`、`qmdRelativePath`、
  `qmdChunkCount`、`graphDocumentId`、`graphTextUnitCount` 执行
  existing-wins 保护。
- `src/job-state/repository.ts:1154` 至 `src/job-state/repository.ts:1162`
  同一内容身份保留 `chunkIds`、`graphDocumentId`、`graphTextUnitIds` 与
  protected metadata。
- `test/book-job-state.test.ts:652` 至 `test/book-job-state.test.ts:724`
  覆盖 qmd 与 GraphRAG identity 已记录后再次 register，并用冲突 incoming
  qmd metadata 验证既有值未被覆盖。

剩余缺口：未发现。

## 基准 2

状态：PASS

证据：

- `src/job-state/repository.ts:1111` 至 `src/job-state/repository.ts:1114`
  只有 `sourceId/sourceHash/contentHash` 全部一致才保留既有 content identity。
- `src/job-state/repository.ts:1154` 至 `src/job-state/repository.ts:1160`
  `chunkIds` 与 graph identity 只在 `preservesContentIdentity` 为 true 时复制。
- `test/graphrag-book-state.test.ts:876` 至
  `test/graphrag-book-state.test.ts:966` 覆盖 stale sidecar 负例并 fail closed。

剩余缺口：未发现。

## 基准 3

状态：PASS

证据：

- `src/job-state/repository.ts:1176` 至 `src/job-state/repository.ts:1203`
  `recordGraphTextUnitIdentity` 是 repository 中写入 `graphDocumentId` 与
  `graphTextUnitIds` 的操作。
- `src/job-state/repository.ts:1115` 至 `src/job-state/repository.ts:1162`
  `upsertDocumentIdentityMap` 仅保留同一 content identity 已存在的 graph fields，
  不从外部 GraphRAG 输入创建新 graph identity。
- `src/job-state/graphrag-book.ts:826` 至 `src/job-state/graphrag-book.ts:856`
  sidecar/parquet 修复路径最终通过 `repo.recordGraphTextUnitIdentity(mapping)`
  写回 repository。

剩余缺口：未发现其它 scoped repository operation 直接创建新的 GraphRAG
text-unit identity。

## 基准 4

状态：PASS

证据：

- `src/job-state/repository.ts:2593` 至 `src/job-state/repository.ts:2604`
  `validateQueryReadyGraphIdentity` 读取 `DocumentIdentityMap` 并定位当前 identity。
- `src/job-state/repository.ts:2605` 至 `src/job-state/repository.ts:2626`
  同时要求 qmd corpus registration、非空 `graphDocumentId` 与非空
  `graphTextUnitIds`。
- `src/job-state/repository.ts:2401` 至 `src/job-state/repository.ts:2432`
  query_ready succeeded checkpoint 写入前调用该校验。
- `src/job-state/repository.ts:2690` 至 `src/job-state/repository.ts:2718`
  读取既有 query_ready 状态时也重新校验 graph identity。
- `test/book-job-state.test.ts:2397` 至 `test/book-job-state.test.ts:2418`
  覆盖缺少 qmd corpus registration 时拒绝 query_ready。

剩余缺口：未发现。

## 基准 5

状态：FAIL

证据：

- `src/job-state/repository.ts:1107` 至 `src/job-state/repository.ts:1114`
  主 register path 按当前 `canonicalBookId/documentId` 查找既有 identity。
- `src/job-state/repository.ts:1165` 至 `src/job-state/repository.ts:1169`
  主 register path 过滤同一 `canonicalBookId` 的旧 identity 后只写入一个新
  identity。
- `test/book-job-state.test.ts:599` 至 `test/book-job-state.test.ts:646`
  覆盖 normalized path 变化时只保留一个 document identity。
- `src/job-state/repository.ts:2107` 至 `src/job-state/repository.ts:2124`
  legacy catalog reference rewrite 仅将 `oldBookId` 映射为 `newBookId`，没有过滤
  或合并已存在的 `newBookId/documentId` identity。
- `test/graphrag-book-state.test.ts:1500` 至
  `test/graphrag-book-state.test.ts:1584` 只覆盖单个 legacy identity 被改写为
  stable identity，未覆盖 old/new identity 同时存在时的 document-level dedupe。

剩余缺口：若 `DocumentIdentityMap` 中同时存在 old 与 new catalog entry，且两者
指向同一 document，`rewriteLegacyCatalogReferences` 会把 old entry 改成
`newBookId` 而不去重，可能持久化同一 book/document 的重复 canonical identity。

## 基准 6

状态：PASS

证据：

- `src/job-state/repository.ts:1115` 至 `src/job-state/repository.ts:1122`
  aliases 合并既有 aliases、既有 normalized path、source identity/name 与当前
  normalized path。
- `src/job-state/repository.ts:1161` 至 `src/job-state/repository.ts:1162`
  aliases 使用 `Set` 去重后写入 identity。
- `src/job-state/repository.ts:919` 至 `src/job-state/repository.ts:923`
  normalized path 进入 job 前通过 `normalizePortableVaultRelativePath` 处理。
- `test/book-job-state.test.ts:599` 至 `test/book-job-state.test.ts:646`
  覆盖 normalized path 变化后 document identity 稳定且 aliases 保留新旧路径。

剩余缺口：未发现。

## 基准 7

状态：PASS

证据：

- `src/job-state/repository.ts:919` 至 `src/job-state/repository.ts:923`
  caller-provided normalized path 通过 portable vault-relative normalization。
- `src/job-state/repository.ts:936` 至 `src/job-state/repository.ts:942`
  caller-provided canonical source path 也通过 portable vault-relative
  normalization。
- `src/job-state/repository.ts:2665` 至 `src/job-state/repository.ts:2688`
  root-relative 与 absolute path 转换均校验不能逃逸 graph vault。
- `test/book-job-state.test.ts:730` 至 `test/book-job-state.test.ts:757`
  覆盖非 portable normalized path 拒绝。
- `test/book-job-state.test.ts:800` 至 `test/book-job-state.test.ts:831`
  覆盖 source/document schema 的非 portable path 拒绝。
- `test/book-job-state.test.ts:914` 至 `test/book-job-state.test.ts:927`
  覆盖 caller-provided absolute canonical source path 拒绝。

剩余缺口：未发现。

## 基准 8

状态：FAIL

证据：

- `src/job-state/repository.ts:598` 至 `src/job-state/repository.ts:615`
  identity metadata 通过 `sanitizeVaultMetadata` 清洗，并删除 `workspaceRoot` 与
  `originalSourcePath`。
- `src/job-state/repository.ts:1123` 至 `src/job-state/repository.ts:1131`
  `DocumentIdentityMap` metadata 会合并并写入 `job.metadata` 的全部剩余键。
- `src/job-state/graphrag-book.ts:432` 至 `src/job-state/graphrag-book.ts:464`
  provider boundary fingerprint 输入会 redact sensitive key/value 与 absolute path。
- `src/job-state/graphrag-book.ts:1621` 至
  `src/job-state/graphrag-book.ts:1627` sync metadata 写入派生
  `providerBoundaryFingerprint`，同时仍展开 `input.metadata`。
- `test/book-job-state.test.ts:2424` 至 `test/book-job-state.test.ts:2475`
  覆盖 persisted metadata 不含 secret 与 host absolute path。
- `test/graphrag-book-state.test.ts:386` 至
  `test/graphrag-book-state.test.ts:451` 覆盖 recovered job catalog 不含
  redaction sentinel 与 host path。

剩余缺口：secret 与 host absolute path 有清洗证据；但 metadata path 没有
allowlist，也没有拒绝 `raw`、`payload`、`providerResponse` 等非敏感 raw provider
payload 对象的证据。由于 `input.metadata` 可继续进入 `job.metadata`，再进入
`DocumentIdentityMap` metadata，该基准未满足。

## 基准 9

状态：PASS

证据：

- `test/book-job-state.test.ts:668` 至 `test/book-job-state.test.ts:689`
  先记录 chunks、qmd corpus registration 与 graph text-unit identity。
- `test/book-job-state.test.ts:691` 至 `test/book-job-state.test.ts:703`
  再次 register 同一 identity，并传入冲突 qmd metadata。
- `test/book-job-state.test.ts:719` 至 `test/book-job-state.test.ts:724`
  断言 `chunkIds`、qmd registration metadata、`graphDocumentId` 与
  `graphTextUnitIds` 均保留。
- `test/graphrag-book-state.test.ts:778` 至
  `test/graphrag-book-state.test.ts:870` 覆盖 catalog graph identity 缺失时可由
  validated sidecar 修复。

剩余缺口：未发现。

## 基准 10

状态：PASS

证据：

- `package.json:41` 定义 `npm run test:types` 为 TypeScript no-emit type check。
- `test/book-job-state.test.ts:162` 定义 repository focused test suite。
- `test/graphrag-book-state.test.ts:103` 定义 GraphRAG book workspace focused
  test suite。
- 本次复审执行 `npm run test:types`：PASS。
- 本次复审执行
  `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts test/book-job-state.test.ts --testTimeout 120000 --reporter=dot`：
  2 files passed，68 tests passed。

剩余缺口：未发现。
