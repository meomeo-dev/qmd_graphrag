# Dev Agent B Report: GraphRAG Sidecar Repair

## 总体结论

DEV PASS。

本次为静态开发审计（static development audit），未执行测试命令。审计仅使用
`baseline.md` 中 10 条固定基准。

## 基准审计

### 1. Existing sidecar repair must validate current job identity

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:833` 至 `:840` 从当前 job 构造期望
  `bookId/sourceId/sourceHash/documentId/contentHash/normalizedPath`。
- `src/job-state/graphrag-book.ts:649` 至 `:655` 将 sidecar 对应字段逐项
  比对当前 job identity。

剩余缺口：无。

### 2. Sidecar repair must validate non-empty graph identity fields

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:637` 规范化 `graphTextUnitIds`。
- `src/job-state/graphrag-book.ts:656` 至 `:657` 要求
  `graphDocumentId` 和 `graphTextUnitIds` 均非空。

剩余缺口：无。

### 3. Sidecar repair must prove referenced text unit ids exist

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:751` 至 `:775` 读取
  `text_units.parquet` 并验证 expected ids 是实际 ids 的子集。
- `src/job-state/graphrag-book.ts:772` 至 `:774` 在存在 `document_id`
  列时按 `graphDocumentId` 收窄校验范围。
- `src/job-state/graphrag-book.ts:811` 至 `:823` 在 sidecar 引用缺失
  text unit 时抛错。

剩余缺口：测试未单独覆盖 sidecar 引用不存在 text unit 的负例；运行代码已有
fail-closed 分支。

### 4. Mismatched sidecar must fail closed without parquet fallback

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:797` 至 `:802` 仅在 sidecar 缺失时返回
  `null`。
- `src/job-state/graphrag-book.ts:803` 至 `:809` 在 sidecar 存在但不匹配时
  抛出错误。
- `src/job-state/graphrag-book.ts:843` 至 `:849` 使用 `??` fallback；sidecar
  mismatch 抛错会阻止 parquet extraction。
- `test/graphrag-book-state.test.ts:940` 至 `:966` 覆盖 stale sidecar 并断言
  sync 抛出 `sidecar does not match`。

剩余缺口：无。

### 5. Missing sidecar may fall back to validated parquet extraction

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:797` 至 `:802` sidecar 缺失时返回 `null`。
- `src/job-state/graphrag-book.ts:843` 至 `:845` 在 sidecar 缺失后 fallback 到
  `readGraphTextUnitIdentity`。
- `src/job-state/graphrag-book.ts:677` 至 `:683` 要求
  `documents.parquet` 和 `text_units.parquet` 存在。
- `src/job-state/graphrag-book.ts:691` 至 `:696` 优先按 direct
  `documentId` 匹配，且只在单文档 output 时允许首行 fallback。
- `src/job-state/graphrag-book.ts:734` 至 `:736` 要求 parquet extraction 产生
  非空 text unit ids。
- `src/job-state/graphrag-book.ts:1171` 至 `:1193` 要求 output producer
  manifest 匹配当前 book、document、content、fingerprint 和 locator。
- `src/job-state/graphrag-book.ts:1418` 至 `:1430` 和 `:1500` 至 `:1517`
  提供 book-scoped artifact set validation。
- `src/job-state/repository.ts:2380` 至 `:2404` 在 `query_ready` checkpoint
  完成时校验 producer stages 和 query artifacts。
- `test/graphrag-book-state.test.ts:704` 至 `:772` 覆盖无 sidecar 时从 parquet
  记录 graph identity。

剩余缺口：fallback 函数本身不内联调用 `validateBookArtifactSet`；validated
性质由 producer manifest、artifact readiness 和 checkpoint validation 链路提供。

### 6. Multi-document repair must use valid sidecar or direct identity match

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:691` 至 `:696` 多文档 output 仅允许 direct
  `documentId` match；首行 fallback 只在 `len(documents.index) == 1` 时触发。
- `src/job-state/graphrag-book.ts:691` 至 `:713` 未按 title 选择 document。
- `test/graphrag-book-state.test.ts:807` 使用 multi-document GraphRAG output。
- `test/graphrag-book-state.test.ts:826` 至 `:838` 为 multi-document output 提供
  valid sidecar。
- `test/graphrag-book-state.test.ts:868` 至 `:870` 断言 multi-document sidecar
  repair 写入 expected graph identity。

剩余缺口：测试未单独覆盖 multi-document、无 sidecar、无 direct identity match
时拒绝按首行或 title 猜测；实现路径已拒绝该分支。

### 7. Repair must not edit generated GraphRAG parquet artifacts

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:689` 至 `:690` parquet fallback 只执行
  `pd.read_parquet`。
- `src/job-state/graphrag-book.ts:767` sidecar text unit 校验只读取
  `text_units.parquet`。
- `src/job-state/graphrag-book.ts:857` 至 `:860` repair 写入的是
  `qmd_graph_text_unit_identity.json` sidecar，不是 parquet artifact。
- `src/job-state/graphrag-book.ts:1037` 至 `:1057` 对 GraphRAG parquet 只收集
  artifact metadata。

剩余缺口：测试未断言 parquet hash 或 mtime 不变；运行代码未发现 parquet 写路径。

### 8. Repair must write mapping through repository and refresh sidecar

状态：PASS

证据：

- `src/job-state/graphrag-book.ts:856` 通过
  `repo.recordGraphTextUnitIdentity(mapping)` 写回 repository state。
- `src/job-state/repository.ts:1148` 至 `:1193` 更新匹配的
  `DocumentIdentityMap` entry，并写入 `graphDocumentId` 与
  `graphTextUnitIds`。
- `src/job-state/graphrag-book.ts:857` 至 `:860` 以固定 JSON 格式刷新 sidecar。
- `src/job-state/repository.ts:1119` 至 `:1124` 对同一 content identity 的
  upsert 保留既有 graph identity。
- `test/book-job-state.test.ts:652` 至 `:718` 覆盖同书再次注册时保留 graph
  identity。

剩余缺口：无阻断缺口；可补充 unordered sidecar ids 被规范化输出的测试。

### 9. Tests must cover real failure shape

状态：PASS

证据：

- `test/graphrag-book-state.test.ts:778` 定义真实失败形态回归测试：
  sidecar 存在、catalog graph identity 缺失、sync repair。
- `test/graphrag-book-state.test.ts:792` 至 `:802` 先注册当前 book identity。
- `test/graphrag-book-state.test.ts:826` 至 `:838` 写入
  `qmd_graph_text_unit_identity.json`。
- `test/graphrag-book-state.test.ts:842` 至 `:852` 重新执行
  `syncGraphRagBookWorkspace`。
- `test/graphrag-book-state.test.ts:868` 至 `:870` 断言
  `DocumentIdentityMap` 修复出 `graphDocumentId` 和 `graphTextUnitIds`。

剩余缺口：无。

### 10. Tests must cover negative sidecar mismatch or stale identity

状态：PASS

证据：

- `test/graphrag-book-state.test.ts:876` 定义 sidecar mismatch/stale 负例测试。
- `test/graphrag-book-state.test.ts:940` 至 `:952` 写入 stale
  `contentHash` 的 sidecar。
- `test/graphrag-book-state.test.ts:956` 至 `:966` 断言 sync 抛出
  `sidecar does not match`。

剩余缺口：负例覆盖 stale `contentHash`；未分别覆盖 `bookId`、`sourceHash`、
`normalizedPath` mismatch 或 missing text unit id，但固定基准要求的 stale
identity 负例已满足。
