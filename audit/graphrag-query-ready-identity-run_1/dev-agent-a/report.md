# Dev Agent A Audit Report

审计范围限定为固定基准文件中的 10 条基准（baseline criteria）。

总体结论：DEV FAIL

主要原因：`query_ready` gate 仍然严格，但 repository/catalog projection 的
非破坏性合并（non-destructive merge）没有完全保护已记录的 qmd corpus
registration metadata；同时 raw provider payload 禁止存储缺少结构性证据。

## 基准 1

状态：FAIL

证据：
- `src/job-state/repository.ts:1096` 至 `src/job-state/repository.ts:1124`
  只在 source/content identity 保持一致时保留 `chunkIds` 与 graph identity。
- `src/job-state/repository.ts:1126` 至 `src/job-state/repository.ts:1134`
  将既有 metadata 与当前 job metadata 合并。
- `src/job-state/repository.ts:598` 至 `src/job-state/repository.ts:605`
  合并顺序为 existing 后 incoming，incoming 可覆盖既有 metadata 键。
- `src/job-state/repository.ts:1421` 至 `src/job-state/repository.ts:1444`
  qmd corpus registration 写入 `qmdCorpusRegistered`、`qmdCollection`、
  `qmdRelativePath`。
- `test/book-job-state.test.ts:652` 至 `test/book-job-state.test.ts:717`
  覆盖了无冲突 re-register 后保留 chunks、qmd flag 与 graph identity。

剩余缺口：如果再次 `registerBookSource` 的 `metadata` 携带
`qmdCorpusRegistered`、`qmdCollection` 或 `qmdRelativePath` 冲突值，
当前合并顺序会覆盖既有 qmd corpus registration metadata。该基准要求
保留该 metadata，因此不满足严格非破坏性合并。

## 基准 2

状态：PASS

证据：
- `src/job-state/repository.ts:1092` 至 `src/job-state/repository.ts:1099`
  只有同一 `sourceId/sourceHash/contentHash` 才设置 `preservesContentIdentity`。
- `src/job-state/repository.ts:1118` 至 `src/job-state/repository.ts:1124`
  stale `graphDocumentId` 与 `graphTextUnitIds` 不会在 identity 变化时复制。
- `src/job-state/repository.ts:1137` 至 `src/job-state/repository.ts:1145`
  写回当前 canonical identity，避免把旧 graph identity 带入新 identity。
- `test/graphrag-book-state.test.ts:876` 至
  `test/graphrag-book-state.test.ts:966` 覆盖 stale sidecar fail closed。

剩余缺口：未发现该基准下的剩余缺口。

## 基准 3

状态：PASS

证据：
- `src/job-state/repository.ts:1148` 至 `src/job-state/repository.ts:1174`
  `recordGraphTextUnitIdentity` 是将 parsed GraphRAG text-unit identity 写入
  `DocumentIdentityMap` 的 repository 方法。
- `src/job-state/repository.ts:1119` 至 `src/job-state/repository.ts:1124`
  `upsertDocumentIdentityMap` 只回写同一 content identity 已存在的 graph fields，
  不从外部 GraphRAG identity 输入创建新 graph identity。
- `src/job-state/graphrag-book.ts:842` 至
  `src/job-state/graphrag-book.ts:856` sidecar/parquet repair 最终通过
  `repo.recordGraphTextUnitIdentity(mapping)` 写回 repository。

剩余缺口：未发现其它 repository operation 直接写入新的 GraphRAG
text-unit identity；该结论限于本次审计范围内文件。

## 基准 4

状态：PASS

证据：
- `src/job-state/repository.ts:2565` 至 `src/job-state/repository.ts:2576`
  `validateQueryReadyGraphIdentity` 读取 `DocumentIdentityMap`。
- `src/job-state/repository.ts:2577` 至 `src/job-state/repository.ts:2584`
  同时要求 `qmdCorpusRegistered === true`、非空 `graphDocumentId`、
  非空 `graphTextUnitIds`。
- `src/job-state/repository.ts:2373` 至 `src/job-state/repository.ts:2405`
  query_ready succeeded checkpoint 写入前调用该校验。
- `src/job-state/repository.ts:2662` 至 `src/job-state/repository.ts:2690`
  读取已存在 query_ready 状态时也重新校验 graph identity。
- `test/book-job-state.test.ts:2337` 至 `test/book-job-state.test.ts:2411`
  覆盖缺少 qmd corpus registration 时拒绝 query_ready。

剩余缺口：未发现该基准下的剩余缺口。

## 基准 5

状态：UNCLEAR

证据：
- `src/job-state/repository.ts:1092` 至 `src/job-state/repository.ts:1095`
  re-register 主路径按 `canonicalBookId` 与 `documentId` 查找既有 identity。
- `src/job-state/repository.ts:1137` 至 `src/job-state/repository.ts:1140`
  re-register 主路径过滤同一 book 的旧 identity 后写入一个新 identity。
- `test/book-job-state.test.ts:599` 至 `test/book-job-state.test.ts:646`
  覆盖同一 source/content 仅保留一个 document identity。
- `src/job-state/repository.ts:2084` 至 `src/job-state/repository.ts:2096`
  legacy catalog reference rewrite 将 old book identity 改成 new book identity，
  但没有在该函数内做 document-level dedupe。

剩余缺口：主 re-register path 有去重证据；legacy remap path 是否会在 old/new
catalog entry 同时存在时留下同一 book/document 的重复 canonical identity，
本次范围内没有直接测试或显式 dedupe 证据。

## 基准 6

状态：PASS

证据：
- `src/job-state/repository.ts:1100` 至 `src/job-state/repository.ts:1125`
  aliases 合并 existing aliases、既有 normalized path、source identity/name 与
  当前 normalized path，并使用 `Set` 去重。
- `src/job-state/repository.ts:904` 至 `src/job-state/repository.ts:908`
  `normalizedPath` 进入 job 前经过 portable vault-relative normalization。
- `test/book-job-state.test.ts:599` 至 `test/book-job-state.test.ts:646`
  覆盖 normalized path 变化后 document identity 稳定且 aliases 保留新旧路径。

剩余缺口：未发现该基准下的剩余缺口。

## 基准 7

状态：PASS

证据：
- `src/job-state/repository.ts:904` 至 `src/job-state/repository.ts:908`
  normalized path 使用 `normalizePortableVaultRelativePath`。
- `src/job-state/repository.ts:2637` 至 `src/job-state/repository.ts:2660`
  root-relative 与 absolute path 转换均校验不能逃逸 graph vault。
- `test/book-job-state.test.ts:723` 至 `test/book-job-state.test.ts:824`
  覆盖 normalized path、book job persistence boundary 与 corpus catalog
  非 portable path 拒绝。
- `test/book-job-state.test.ts:907` 至 `test/book-job-state.test.ts:920`
  覆盖 caller-provided absolute canonical source path 拒绝。

剩余缺口：未发现该基准下的剩余缺口。

## 基准 8

状态：UNCLEAR

证据：
- `src/job-state/repository.ts:598` 至 `src/job-state/repository.ts:614`
  identity metadata 经 `sanitizeVaultMetadata` 清洗，并删除 `workspaceRoot` 与
  `originalSourcePath`。
- `src/job-state/repository.ts:1126` 至 `src/job-state/repository.ts:1134`
  `DocumentIdentityMap` metadata 写入使用上述 metadata merge。
- `src/job-state/graphrag-book.ts:432` 至
  `src/job-state/graphrag-book.ts:464` provider boundary fingerprint 输入会
  redact sensitive key/value 与 absolute path。
- `src/job-state/graphrag-book.ts:1621` 至
  `src/job-state/graphrag-book.ts:1626` sync metadata 仅写入
  `providerBoundaryFingerprint` 等派生值。
- `test/book-job-state.test.ts:2417` 至 `test/book-job-state.test.ts:2468`
  覆盖 persisted metadata 不含 secret 和 host absolute path。
- `test/graphrag-book-state.test.ts:417` 至
  `test/graphrag-book-state.test.ts:451` 覆盖 recovered job catalog 不含
  redaction sentinel 与 host path。

剩余缺口：已有 secret 与 host absolute path 清洗证据；但没有显式 allowlist 或
测试证明 raw provider payload 结构不会通过 `metadata` 原样进入 identity
metadata。因此该基准不能完全判定为 PASS。

## 基准 9

状态：PASS

证据：
- `test/book-job-state.test.ts:652` 至 `test/book-job-state.test.ts:689`
  先记录 chunks、qmd corpus registration 与 graph text-unit identity。
- `test/book-job-state.test.ts:691` 至 `test/book-job-state.test.ts:717`
  再次 register 同一 identity 后断言 `chunkIds`、qmd registration flag、
  `graphDocumentId` 与 `graphTextUnitIds` 均保留。
- `test/graphrag-book-state.test.ts:778` 至
  `test/graphrag-book-state.test.ts:870` 覆盖 catalog graph identity 缺失时可由
  validated sidecar 修复。

剩余缺口：未发现该基准下的剩余缺口。

## 基准 10

状态：PASS

证据：
- `package.json:41` 定义 `npm run test:types` 为 TypeScript no-emit type check。
- `test/book-job-state.test.ts:162` 定义 repository focused test suite。
- `test/graphrag-book-state.test.ts:103` 定义 GraphRAG book workspace focused
  test suite。
- 本次审计执行 `npm run test:types`：PASS。
- 本次审计执行
  `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts test/book-job-state.test.ts --testTimeout 120000 --reporter=dot`：
  2 files passed，68 tests passed。

剩余缺口：未发现该基准下的剩余缺口。
