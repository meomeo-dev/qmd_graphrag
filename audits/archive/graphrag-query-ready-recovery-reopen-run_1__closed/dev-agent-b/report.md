result: FAIL

# GraphRAG query-ready recovery reopen 审计报告

## 阻断发现

1. B-01: repair-only producer manifest 恢复会信任未门控的现有
   `qmd_output_manifest.json` stage run id。

   证据：

   - `scripts/graphrag/resume-book-workspace.mjs:536`-`563`：
     `restoreProducerManifestFromEvidence` 读取 `currentManifest` 后直接合并
     `producerRunIdsFromManifest(currentManifest)` 与 checkpoint run id，再用当前
     `bookId`、`sourceHash`、`documentId`、`contentHash`、`stageFingerprints`
     和 `providerFingerprint` 重写 producer manifest。
   - `scripts/graphrag/resume-book-workspace.mjs:271`-`278`：
     `producerRunIdsFromManifest` 只抽取 `stageProducerRunIds`，没有验证
     manifest 的 `bookId`、`sourceHash`、`documentId`、`contentHash`、
     `stageFingerprints` 或 `providerFingerprint`。
   - `src/job-state/graphrag-book.ts:1171`-`1192` 已有
     `outputProducerMatches` 当前身份门控，但该门控只在
     `syncGraphRagBookWorkspace` 收集 GraphRAG output artifacts 时使用，
     没有保护 repair-only 的 manifest run id 恢复路径。

   影响：

   stale 或 mixed-book output manifest 可以向 repair-only 恢复路径提供
   `graph_extract`、`community_report`、`embed` run id。后续 artifact 校验会
   降低误恢复概率，但 producer manifest 恢复本身未满足“以当前
   bookId/sourceHash/documentId/contentHash/stageFingerprints/providerFingerprint
   匹配为前置门控”的固定基准，属于 fail-open 证据入口。

   建议修复：

   - 在 `restoreProducerManifestFromEvidence` 读取现有 manifest 后，先执行与
     `outputProducerMatches` 等价的当前身份门控；不匹配时必须忽略 manifest
     run id，只允许 checkpoint 证据参与恢复。
   - 将 `outputProducerMatches` 提取为可复用导出，或在 resume 脚本中实现同等
     检查，确保字段包括 `bookId`、`sourceHash`、`documentId`、
     `contentHash`、全部 stage fingerprints、`providerFingerprint` 和
     book-scoped `outputDir`。
   - 增加 repair-only 测试：构造 stale/mixed `qmd_output_manifest.json` 且缺失
     producer checkpoint 的场景，断言 repair-only blocked，不重写 current
     producer manifest。

## 逐条基准审计

1. PASS：repair-only 能识别 `query_ready` document identity 缺失和
   not-ready `graphCapabilityId(s)`。证据：
   `scripts/graphrag/resume-book-workspace.mjs:226`-`254`，
   `scripts/graphrag/batch-failure-classifier.mjs:140`-`168`，
   `test/cli.test.ts:1789`-`1821`。

2. PASS：repair-only 调用现有 `syncGraphRagBookWorkspace`。证据：
   `scripts/graphrag/resume-book-workspace.mjs:476`-`506`、
   `scripts/graphrag/resume-book-workspace.mjs:674`-`680`，
   `src/job-state/graphrag-book.ts:1635`-`1689`。

3. PASS：repair-only 分支不调用 `runtime.graphIndex`，且不重跑
   `graph_extract`、`community_report`、`embed` workflow。证据：
   `scripts/graphrag/resume-book-workspace.mjs:626`-`821` 仅执行本地同步、
   manifest/checkpoint/artifact validation；`runtime.graphIndex` 只在普通路径
   `scripts/graphrag/resume-book-workspace.mjs:1062`-`1076`。

4. PASS：repair-only 不调用 `runtime.graphQuery`。证据：
   `scripts/graphrag/resume-book-workspace.mjs:827`-`830` 在创建 runtime 前返回；
   `runtime.graphQuery` 只在普通路径
   `scripts/graphrag/resume-book-workspace.mjs:899`-`915` 和
   `scripts/graphrag/resume-book-workspace.mjs:1139`-`1155`。

5. FAIL：producer manifest 恢复缺少当前 identity/fingerprint 前置门控。证据
   见阻断发现 B-01。

6. PASS：stage checkpoint 恢复使用当前 content hash、stage fingerprint、
   provider fingerprint 和 corpus content hash 匹配的 artifact。证据：
   `scripts/graphrag/resume-book-workspace.mjs:285`-`305`，
   `scripts/graphrag/resume-book-workspace.mjs:333`-`383`，
   `src/job-state/artifact-validation.ts:527`-`557`。

7. PASS：`graph_extract`、`community_report`、`embed` producer run id 复用
   manifest/checkpoint/failed-checkpoint 证据，repair-only 不为这些高成本
   producer stages 生成新 run id。证据：
   `scripts/graphrag/resume-book-workspace.mjs:536`-`563`，
   `scripts/graphrag/resume-book-workspace.mjs:587`-`623`，
   `scripts/graphrag/resume-book-workspace.mjs:687`-`716`。

8. PASS：`query_ready` projection 只在三类 producer stages validated 后补齐。
   证据：`scripts/graphrag/resume-book-workspace.mjs:166`-`224`，
   `scripts/graphrag/resume-book-workspace.mjs:753`-`794`，
   `src/job-state/repository.ts:2472`-`2504`。

9. PASS：graph capability 验证通过 `loadGraphQueryCapabilities`，且该函数基于
   derived capability 和 validated explicit catalog 合并后的 ready capability。
   证据：`scripts/graphrag/resume-book-workspace.mjs:386`-`408`，
   `src/graphrag/capability-catalog.ts:456`-`493`。

10. FAIL：artifact、sidecar、source/content mismatch 和 incomplete artifact 的
    多数路径 fail closed，但 stale/mixed producer manifest 可进入
    repair-only run id 恢复入口，受 B-01 阻断。相关 fail-closed 证据：
    `src/job-state/graphrag-book.ts:625`-`658`，
    `src/job-state/artifact-validation.ts:510`-`580`，
    `scripts/graphrag/batch-epub-workflow.mjs:1817`-`1921`。

## 建议修复

- 优先修复 B-01，把 producer manifest run id 恢复改为“验证通过才读取，
  不通过即忽略或 blocked”的 fail-closed 行为。
- 对 repair-only 增加 stale manifest、mixed-book output、missing producer
  lineage、source/content mismatch 的端到端测试，覆盖真实
  `resume-book-workspace.mjs`，不要只做字符串断言或 fake runner 夹具。
- 修复后重新审计第 5 和第 10 条基准；其余条款当前未发现阻断问题。
