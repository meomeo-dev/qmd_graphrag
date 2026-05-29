# Dev Agent A Reaudit 2: Repository And Catalog Projection

本次复审仅使用 `baseline.md` 中 10 条固定基准，未新增或替换基准。

总体结论：DEV PASS

重点复审结果：第一次复审失败的基准 5 与基准 8 均已修复。legacy
catalog remap 后会执行 document identity dedupe，raw provider payload
metadata 已进入 `sanitizeVaultMetadata` denylist，并被 repository identity
metadata 写入路径复用。

## 基准 1

状态：PASS

证据：

- `src/job-state/repository.ts:1176` 至 `src/job-state/repository.ts:1183`
  按同一 `canonicalBookId/documentId/sourceHash/contentHash` 判断可保留身份。
- `src/job-state/repository.ts:1201` 至 `src/job-state/repository.ts:1212`
  对 qmd 与 graph projection metadata 执行 existing-wins 保护。
- `src/job-state/repository.ts:1223` 至 `src/job-state/repository.ts:1229`
  同一 content identity 下保留 `chunkIds`、`graphDocumentId` 与
  `graphTextUnitIds`。
- `test/book-job-state.test.ts:652` 至 `test/book-job-state.test.ts:724`
  覆盖 qmd corpus registration 与 GraphRAG identity 已记录后再次 register，
  并验证冲突 incoming qmd metadata 未覆盖既有值。

剩余缺口：未发现。

## 基准 2

状态：PASS

证据：

- `src/job-state/repository.ts:1180` 至 `src/job-state/repository.ts:1183`
  只有 `sourceId/sourceHash/contentHash` 全部一致时才视为同一 content
  identity。
- `src/job-state/repository.ts:1223` 至 `src/job-state/repository.ts:1229`
  stale `chunkIds` 与 graph identity 仅在 `preservesContentIdentity` 为 true
  时复制。
- `test/graphrag-book-state.test.ts:876` 至
  `test/graphrag-book-state.test.ts:966` 覆盖 stale GraphRAG sidecar fail
  closed，避免把旧 graph identity 带入新 content identity。

剩余缺口：未发现。

## 基准 3

状态：PASS

证据：

- `src/job-state/repository.ts:1245` 至 `src/job-state/repository.ts:1271`
  `recordGraphTextUnitIdentity` 是从 `GraphTextUnitIdentityMapSchema` 输入写入
  `graphDocumentId` 与 `graphTextUnitIds` 的 repository operation。
- `src/job-state/repository.ts:1224` 至 `src/job-state/repository.ts:1229`
  re-register 只保留同一 content identity 已存在的 graph fields，不创建新的
  GraphRAG text-unit identity。
- `src/job-state/repository.ts:640` 至 `src/job-state/repository.ts:675`
  legacy dedupe 仅合并既有 `DocumentIdentityMap` entries 中的 graph fields。
- `src/job-state/graphrag-book.ts:826` 至
  `src/job-state/graphrag-book.ts:856` sidecar/parquet repair 最终通过
  `repo.recordGraphTextUnitIdentity(mapping)` 写回 repository。

剩余缺口：未发现其它 scoped repository operation 从外部 GraphRAG 输入创建
新的 text-unit identity。

## 基准 4

状态：PASS

证据：

- `src/job-state/repository.ts:2664` 至 `src/job-state/repository.ts:2675`
  `validateQueryReadyGraphIdentity` 读取 `DocumentIdentityMap` 并定位当前
  book/document/content identity。
- `src/job-state/repository.ts:2676` 至 `src/job-state/repository.ts:2683`
  同时要求 `qmdCorpusRegistered === true`、非空 `graphDocumentId` 与非空
  `graphTextUnitIds`。
- `src/job-state/repository.ts:2472` 至 `src/job-state/repository.ts:2503`
  query_ready succeeded checkpoint 写入前调用该校验。
- `src/job-state/repository.ts:2761` 至 `src/job-state/repository.ts:2789`
  读取既有 query_ready 状态时也重新校验 graph identity。
- `test/book-job-state.test.ts:2397` 至 `test/book-job-state.test.ts:2417`
  覆盖缺少 qmd corpus registration 时拒绝 query_ready。

剩余缺口：未发现。

## 基准 5

状态：PASS

证据：

- `src/job-state/repository.ts:1176` 至 `src/job-state/repository.ts:1179`
  主 register path 按当前 `canonicalBookId/documentId` 查找既有 identity。
- `src/job-state/repository.ts:1234` 至 `src/job-state/repository.ts:1237`
  主 register path 过滤同一 `canonicalBookId` 的旧 entries 后写入当前
  identity。
- `src/job-state/repository.ts:678` 至 `src/job-state/repository.ts:699`
  `dedupeDocumentIdentityMaps` 对 remap 后的 identity catalog 去重。
- `src/job-state/repository.ts:640` 至 `src/job-state/repository.ts:675`
  去重时合并 `chunkIds`、aliases、metadata 与 graph identity，避免丢失旧
  entry 的 query-ready identity。
- `src/job-state/repository.ts:2181` 至 `src/job-state/repository.ts:2195`
  `rewriteLegacyCatalogReferences` 将 old book id 改写为 stable book id 后调用
  `dedupeDocumentIdentityMaps`。
- `test/graphrag-book-state.test.ts:1592` 至
  `test/graphrag-book-state.test.ts:1682` 覆盖 old 与 stable document identity
  同时存在时，legacy remap 后只保留一个 stable book/document identity，并保留
  legacy graph identity。

剩余缺口：未发现。结论限于 repository 生成或迁移出的有效 identity catalog；
schema-invalid 的手工冲突 catalog 不作为本基准的阻断缺口。

## 基准 6

状态：PASS

证据：

- `src/job-state/repository.ts:1184` 至 `src/job-state/repository.ts:1191`
  aliases 合并既有 aliases、既有 normalized path、source identity/name 与当前
  normalized path。
- `src/job-state/repository.ts:1230` 使用 `Set` 对 aliases 去重后写入 identity。
- `src/job-state/repository.ts:988` 至 `src/job-state/repository.ts:992`
  normalized path 进入 job 前通过 portable vault-relative normalization。
- `test/book-job-state.test.ts:599` 至 `test/book-job-state.test.ts:646`
  覆盖 normalized path 变化后 document identity 稳定且 aliases 保留新旧路径。

剩余缺口：未发现。

## 基准 7

状态：PASS

证据：

- `src/job-state/repository.ts:988` 至 `src/job-state/repository.ts:992`
  caller-provided normalized path 使用 `normalizePortableVaultRelativePath`。
- `src/job-state/repository.ts:1005` 至 `src/job-state/repository.ts:1011`
  caller-provided canonical source path 同样通过 portable vault-relative
  normalization。
- `src/job-state/repository.ts:1522` 校验 qmd corpus registration relative path。
- `src/job-state/repository.ts:2736` 至 `src/job-state/repository.ts:2759`
  root-relative 与 absolute path 转换均校验不能逃逸 graph vault。
- `test/book-job-state.test.ts:730` 至 `test/book-job-state.test.ts:757`
  覆盖非 portable normalized paths 拒绝。
- `test/book-job-state.test.ts:763` 至 `test/book-job-state.test.ts:831`
  覆盖 book job persistence boundary 与 public corpus catalog 非 portable path
  拒绝。
- `test/book-job-state.test.ts:914` 至 `test/book-job-state.test.ts:927`
  覆盖 caller-provided absolute canonical source path 拒绝。

剩余缺口：未发现。

## 基准 8

状态：PASS

证据：

- `src/vault/metadata.ts:4` 至 `src/vault/metadata.ts:8` 定义 sensitive key、
  sensitive value 与 raw provider payload key denylist。
- `src/vault/metadata.ts:19` 至 `src/vault/metadata.ts:23` 对 camelCase 与
  snake/kebab key 统一检测 unsafe metadata keys。
- `src/vault/metadata.ts:25` 至 `src/vault/metadata.ts:52` 递归删除 secret、
  host absolute path string 与 raw provider payload keys。
- `src/job-state/repository.ts:598` 至 `src/job-state/repository.ts:615`
  identity metadata merge 统一调用 `sanitizeVaultMetadata`，并删除
  `workspaceRoot` 与 `originalSourcePath`。
- `src/job-state/repository.ts:1192` 至 `src/job-state/repository.ts:1231`
  `DocumentIdentityMap` metadata 写入使用经过 sanitizer 的 merged metadata。
- `src/job-state/graphrag-book.ts:1621` 至
  `src/job-state/graphrag-book.ts:1627` sync metadata 可展开 `input.metadata`，
  但后续 register/repository 写入路径会经过上述 sanitizer。
- `test/book-job-state.test.ts:2424` 至 `test/book-job-state.test.ts:2484`
  覆盖 persisted metadata 不含 secret、host absolute path、
  `rawProviderRequest`、`providerResponse` 与 raw payload sentinel。

剩余缺口：未发现阻断缺口。测试直接断言 job/checkpoint persisted metadata；
identity metadata 的 raw payload 防护由同一 repository sanitizer 写入路径提供。

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
  2 files passed，69 tests passed。

剩余缺口：未发现。
