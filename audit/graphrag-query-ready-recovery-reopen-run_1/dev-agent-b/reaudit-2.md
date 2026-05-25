result: PASS

# GraphRAG query-ready recovery reopen 第 2 轮复审报告

## 结论

本轮按固定基准复审 `repair-only` query-ready recovery reopen 最新修复。
未发现 B 类阻断问题。上一轮阻断的 stale/mixed
`qmd_output_manifest.json` producer run id 恢复入口已改为当前
identity、fingerprint、provider 和 outputDir 匹配后才复用；底层
producer manifest 写入也已避免把不匹配旧 manifest 的
`stageProducerRunIds` 合并回当前 manifest。

验证记录显示 focused 12 tests、`test/cli.test.ts` 180 tests、
`test/graphrag-book-state.test.ts` 25 tests 和 `npm run test:types`
均已通过。证据见 `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:76`、
`audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:89`、
`audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:95`、
`audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:98`。

## 逐条基准审计

1. PASS：repair-only 能识别 `query_ready` document identity 缺失和
   not-ready `graphCapabilityId(s)` 作为本地投影门控失败。证据：
   `scripts/graphrag/resume-book-workspace.mjs:226`-`254` 覆盖
   identity、capability 和 no-ready-capability 错误文本；
   `scripts/graphrag/batch-failure-classifier.mjs:140`-`168` 将同类文本纳入
   local artifact gate 分类；`test/cli.test.ts:1789`-`1803` 覆盖两条真实失败
   文本。

2. PASS：repair-only 调用现有 `syncGraphRagBookWorkspace` 重建 qmd corpus
   registration、document identity 和 artifact manifests。证据：
   `scripts/graphrag/resume-book-workspace.mjs:496`-`527` 封装
   `syncGraphRagBookWorkspace`；`scripts/graphrag/resume-book-workspace.mjs:700`-
   `712`、`752`-`767`、`807`-`819` 在 repair-only 流程中多次同步当前 book
   workspace；`src/job-state/graphrag-book.ts:1640`-`1699` 负责 corpus
   registration、artifact recording 和 graph text unit identity 记录。

3. PASS：repair-only 不调用 `runtime.graphIndex`，不重跑 `graph_extract`、
   `community_report`、`embed` 高成本 workflow。证据：
   `scripts/graphrag/resume-book-workspace.mjs:652`-`852` 的 repair-only 分支只做
   本地同步、manifest 恢复、checkpoint/artifact 校验和 query_ready 投影补齐；
   `scripts/graphrag/resume-book-workspace.mjs:862` 在 repair-only 返回后才创建
   runtime；`scripts/graphrag/resume-book-workspace.mjs:1093`-`1107` 的
   `runtime.graphIndex` 仅位于普通 resume 路径。

4. PASS：repair-only 不调用 `runtime.graphQuery`。证据：
   `scripts/graphrag/resume-book-workspace.mjs:652`-`852` 的 repair-only 分支中无
   `runtime.graphQuery`；`scripts/graphrag/resume-book-workspace.mjs:930`-`946` 和
   `1170`-`1180` 的 query 调用均位于普通路径；`test/cli.test.ts:1805`-`1821`
   对 repair-only 片段做了无 graph query 调用断言。

5. PASS：producer manifest 恢复以当前 bookId、sourceHash、documentId、
   contentHash、stageFingerprints、providerFingerprint 和 outputDir 匹配为前置
   门控。证据：`scripts/graphrag/resume-book-workspace.mjs:285`-`299`
   `outputProducerManifestMatchesSync` 校验当前 identity、producer stage
   fingerprints、provider fingerprint 和 book-scoped output locator；
   `scripts/graphrag/resume-book-workspace.mjs:556`-`589`
   `restoreProducerManifestFromEvidence` 仅在该校验通过时读取
   `producerRunIdsFromManifest`；不匹配时 manifest run id 为空。

6. PASS：恢复 stage checkpoint 时只使用当前 content hash、stage fingerprint、
   provider fingerprint 和 corpus content hash 匹配的 artifacts。证据：
   `scripts/graphrag/resume-book-workspace.mjs:305`-`325` 定义 current artifact
   过滤；`scripts/graphrag/resume-book-workspace.mjs:372`-`383`
   `completeProducerStageFromEvidence` 仅向 artifact readiness 传入 current
   artifacts；`src/job-state/artifact-validation.ts:527`-`557` 校验 producer
   run id、stage fingerprint、provider fingerprint 和 corpus content hash。

7. PASS：`graph_extract`、`community_report`、`embed` producer run ids 复用已有
   manifest/checkpoint 证据，repair-only 不为这些高成本 producer stages 生成新
   run id。证据：`scripts/graphrag/resume-book-workspace.mjs:257`-`279` 只从
   succeeded checkpoint 或已校验 manifest 提取 run id；
   `scripts/graphrag/resume-book-workspace.mjs:707`-`740` 用恢复出的 run id 调用
   `completeProducerStageFromEvidence`；`src/job-state/graphrag-book.ts:1701`-
   `1709` 在 sync 阶段禁用 high-cost bootstrap checkpoint。

8. PASS：若 `query_ready` checkpoint 缺失或 stale，repair-only 只在三类
   producer stages 全部 validated 后补齐 `query_ready` projection。证据：
   `scripts/graphrag/resume-book-workspace.mjs:166`-`224`
   `queryReadyProducerArtifacts` 要求三类 producer checkpoint 均 succeeded 且
   run id 存在，并通过 current artifacts 和 readiness 校验；
   `scripts/graphrag/resume-book-workspace.mjs:782`-`805` 仅在该校验成功后
   `completeStage(query_ready)`；`src/job-state/repository.ts:2472`-`2504` 在
   repository 层再次验证 producer stages、query artifacts 和 graph identity。

9. PASS：graph capability 可用性通过 `loadGraphQueryCapabilities` 派生/显式合并
   后的 ready capability 验证，不只看旧 explicit catalog。证据：
   `scripts/graphrag/resume-book-workspace.mjs:406`-`428` 调用
   `loadGraphQueryCapabilities` 并按当前 bookId scoped；
   `src/graphrag/capability-catalog.ts:456`-`485` 合并 derived capability 与
   validated explicit capability 后只返回 ready 且匹配 scope 的能力；
   `src/graphrag/capability-catalog.ts:488`-`493` 再限定为 graph_query。

10. PASS：mixed-book output、stale sidecar、source/content mismatch、missing
    producer lineage、incomplete artifacts 均 fail closed。证据：
    `src/job-state/graphrag-book.ts:625`-`658` 校验 graph identity sidecar 的
    book/source/document/content/normalizedPath；`src/job-state/graphrag-book.ts:1171`-
    `1239` 只在旧 producer manifest 匹配当前 identity/fingerprint 时合并旧
    `stageProducerRunIds`；`src/job-state/artifact-validation.ts:398`-`474` 校验
    path、hash、parquet、json 和 lancedb 完整性；`test/graphrag-book-state.test.ts:1042`-
    `1110` 覆盖 stale producer run id 不回流；`test/graphrag-book-state.test.ts:1911`-
    `1949` 覆盖非当前 producer artifact 不能完成 GraphRAG stage。

## 复审备注

本次只读审计未修改源码、baseline 或状态文件。工作树存在本轮实现修复和审计目录
变更，未执行额外测试；测试结论引用状态文件中的最新验证记录。
