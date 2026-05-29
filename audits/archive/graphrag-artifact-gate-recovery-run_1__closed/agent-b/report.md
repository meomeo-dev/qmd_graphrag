# Agent B 审计报告：GraphRAG Artifact Isolation 与 Provider Boundary

审计对象：当前未提交工作区。

审计基准：
`audit/graphrag-artifact-gate-recovery-run_1__closed/agent-b/baseline.md`

## 逐条结论

1. PASS

   基准：GraphRAG index request 必须要求显式 per-book `reportDir`，
   缺失时必须在调用 Python bridge 前失败。

   证据：
   - `src/contracts/graphrag.ts:78-83` 定义 `GraphRagIndexRequestSchema`，
     `reportDir` 是必填 `z.string().min(1)`。
   - `src/integrations/graphrag.ts:286-304` 在 `callPythonBridge()` 前执行
     `GraphRagIndexRequestSchema.parse(request)`。
   - `scripts/graphrag/resume-book-workspace.mjs:801-823` 使用同一个
     `join(reportRoot, sync.job.bookId, nextStage)` 作为 stage log 与
     `graphIndex.reportDir`。
   - `python/qmd_graphrag/bridge.py:1822-1824` Python 层也 fail-closed
     校验缺失 `reportDir`。

2. PASS

   基准：Raw GraphRAG reports 必须写入当前 book-scoped workspace，不得写入
   共享默认 `output/reports`。

   证据：
   - `scripts/graphrag/resume-book-workspace.mjs:801-823` stage report path 为
     `reportRoot/<bookId>/<stage>`，且 health check 与 index request 使用同一路径。
   - `scripts/graphrag/batch-epub-workflow.mjs:3098-3099` batch runner 将
     `--report-root` 固定为 `logRoot/graphrag-reports`。
   - `python/qmd_graphrag/bridge.py:1837-1841` 将该 `reportDir` 投影到
     GraphRAG `reporting.base_dir`。
   - `catalog/data-bus.catalog.yaml:469-474` 记录 `inputDir`、`dataDir` 和
     `reportDir` 的边界：`reportDir` 位于 batch `logRoot`，不是 portable
     graph_vault state。
   - `scripts/graphrag/batch-epub-workflow.mjs:2721-2746` 批量 runner 会拒绝
     `graph_vault/books/<bookId>/output/reports` 中残留 raw logs，避免 raw
     reports 被登记为可移植图产物。

3. PASS

   基准：`resume-book-workspace` 和 batch runners 必须始终向 TypeScript 与
   Python GraphRAG 层传递相同的隔离 per-book report directory。

   证据：
   - `scripts/graphrag/batch-epub-workflow.mjs:3075-3100` batch runner 调用
     `resume-book-workspace` 并传入 `--report-root logRoot/graphrag-reports`。
   - `scripts/graphrag/resume-book-workspace.mjs:91-96` 缺少 `--report-root`
     直接失败。
   - `scripts/graphrag/resume-book-workspace.mjs:801-823` 同一
     `join(reportRoot, sync.job.bookId, nextStage)` 同时用于 log offset、
     `graphIndex.reportDir` 与 stage report health check。
   - `src/integrations/graphrag.ts:304-310` TypeScript 将解析后的 request
     原样传给 Python bridge。
   - `python/qmd_graphrag/bridge.py:423-425`、`python/qmd_graphrag/bridge.py:1837-1841`
     Python bridge 使用该 `reportDir` 作为 GraphRAG reporting base directory。

4. PASS

   基准：Provider request artifacts 必须捕获显式 request scope，且不得从无关
   catalog capabilities 扩展 lineage。

   证据：
   - `src/integrations/graphrag.ts:241-253` query provider request fingerprint
     输入只包含 method、query、responseType 和显式 `capabilityScope`。
   - `src/integrations/graphrag.ts:290-301` index provider request fingerprint
     输入只包含 method、storage overrides、workflow controls 和显式
     `indexScope`。
   - `src/integrations/graphrag.ts:80-115` provider request artifact 只保存
     redacted fingerprint 与 adapter metadata，不保存 provider-private body。
   - `src/query/unified-router.ts:225-230` GraphRAG route decision 的
     `graphArtifactIds` 只来自 selected capabilities。
   - `test/unified-query.test.ts:760-793` 覆盖无关 candidate capability 不会进入
     GraphRAG provider request scope。

5. PASS

   基准：Indexing cost ledger 只能使用显式 index scope 和 request artifact
   lineage，不能使用另一阶段的 query-ready artifacts。

   证据：
   - `src/integrations/graphrag.ts:206-219` `indexCostLineage()` 只读取
     `indexScope` 的 source/document/book/content/artifactIds。
   - `src/integrations/graphrag.ts:312-330` index 成本记录使用
     `indexCostLineage(parsed.indexScope)`，并只附加 request artifact。
   - `src/integrations/graphrag.ts:151-153` ledger `artifactIds` 由
     `requestArtifactId` 与传入 lineage artifactIds 去重组成。
   - `test/integrations/graphrag-cost.test.ts:340-407` 明确验证 index ledger
     包含 `artifact-current-stage`，不包含 community report、LanceDB、
     workflow name 或 capability id。

6. PASS

   基准：User-facing query output 不得泄露 absolute graph vault paths、
   temporary workspace paths、API keys 或 provider-private request details。

   证据：
   - `src/vault/metadata.ts:4-23` 识别 sensitive keys、secret values 和
     absolute path string。
   - `src/vault/metadata.ts:47-61` `sanitizeVaultMetadata()` 清理 metadata。
   - `src/query/unified-answer.ts:79-98` GraphRAG response evidence metadata 在
     投影到 `UnifiedAnswer` 前被 sanitize。
   - `python/qmd_graphrag/bridge.py:1338-1346` Python bridge 生成的 GraphRAG
     evidence locator/metadata 使用 persisted normalized path 与 scoped ids，
     不使用 rootDir/dataDir/reportDir。
   - `src/query/unified-router.ts:293-307` GraphRAG provider runtime error 输出
     使用固定 redacted message，不回显 bridge stderr/provider internals。
   - `test/cli-graphrag-route.test.ts:643-664` 验证 GraphRAG JSON 输出不包含
     graph vault absolute path。
   - `test/cli-graphrag-route.test.ts:666-712` 验证 GraphRAG Markdown、CSV、
     XML 和 files 输出不包含 graph vault absolute path。

7. PASS

   基准：`--json`、`--csv`、`--md`、`--xml`、`--files` 必须是同一个
   post-query answer model 的渲染，不得是独立 query implementation。

   证据：
   - `src/query/unified-router.ts:431-546` `routeQuery()` 统一生成
     `UnifiedAnswer`。
   - `src/cli/qmd.ts:3230-3257` 默认 qmd query 调用 `routeQuery()` 后调用
     `outputUnifiedAnswer()`。
   - `src/cli/qmd.ts:3273-3340` auto query 调用 `routeQuery()` 后调用
     `outputUnifiedAnswer()`。
   - `src/cli/qmd.ts:3375-3445` `--graphrag` query 调用 `routeQuery()` 后调用
     `outputUnifiedAnswer()`。
   - `src/cli/qmd.ts:2839-2849` JSON 与非 JSON 均从同一个 `UnifiedAnswer`
     分支输出。
   - `src/cli/qmd.ts:2733-2827` CSV、Markdown、XML、files 均由
     `outputUnifiedAnswerEvidence()` 投影 answer evidence。

8. PASS

   基准：Non-JSON formats 必须暴露足够与 JSON 对账的 identifier：document ID、
   content hash、book ID、graph capability ID、text-unit ID、artifact ID
   可用时都要输出。

   证据：
   - `src/cli/qmd.ts:2735-2748` files 输出包含 documentId、contentHash、
     bookId、graphCapabilityId、graphTextUnitId 和 artifactId。
   - `src/cli/qmd.ts:2753-2784` CSV header 与 rows 包含上述 identifier。
   - `src/cli/qmd.ts:2692-2706` Markdown 内嵌的 evidence JSON reference
     包含上述 identifier。
   - `src/cli/qmd.ts:2791-2796` Markdown 输出该 evidence JSON reference。
   - `src/cli/qmd.ts:2802-2819` XML item attributes 包含上述 identifier。

9. PASS

   基准：Markdown 与 XML renderings 必须包含 answer text 和 evidence content，
   不得只有 title 或 route summary。

   证据：
   - `src/cli/qmd.ts:2789-2798` Markdown 输出 `answer.answerText`，并在
     evidence 下输出 `item.quote`。
   - `src/cli/qmd.ts:2802-2819` XML 输出 `<text>` 中的 answer text 与
     `<quote>` 中的 evidence content。
   - `test/cli-graphrag-route.test.ts:675-685` 验证 GraphRAG Markdown 包含
     answer text 与 evidence quote。

10. PASS

    基准：测试必须验证 GraphRAG-specific non-JSON output，不得只验证 QMD route
    或 JSON route。

    证据：
    - `test/cli-graphrag-route.test.ts:666-712` 测试
      `qmd query --graphrag` 的 Markdown、CSV、XML 和 files 输出。
    - `test/cli-graphrag-route.test.ts:675-685` Markdown 断言 GraphRAG answer、
      graphCapabilityId、documentId、contentHash、artifactId 与 evidence quote。
    - `test/cli-graphrag-route.test.ts:687-711` CSV、XML、files 断言
      GraphRAG-specific ids/artifacts，并检查不泄露 graph vault absolute path。

## FAIL 修复建议

未发现 FAIL。无需最小修复建议；未发现阻断真实 EPUB 闭环
（real EPUB closed loop）的基准缺口。

## 总体结论

PASS
