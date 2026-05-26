# Dev Agent C 审计报告

结论：FAIL

本次修复覆盖了真实失败文本
`capabilityScope references unknown or not-ready graphCapabilityId(s)`，
并能通过 batch 的本地投影修复路径（local projection repair path）重开失败项。
但 Python capability 派生逻辑仍可能用与当前 book state 不一致的
document identity 生成 ready capability，未达到基准 8 的 Python/TypeScript
一致性要求。

## 逐条基准结果

1. PASS。`resume-book-workspace.mjs` 与
   `batch-failure-classifier.mjs` 均识别目标错误文本为本地 artifact gate
   失败；Python `_load_graph_capabilities` 可为缺失的请求 capability 派生
   `graph_query`。
2. PASS。`query_ready` 已成功但 `graph-capabilities.yaml` 缺项时，Python
   可从 book/checkpoint/artifact evidence 派生 capability；resume 修复路径
   可重新完成 `query_ready`，无需删除或手工编辑 `graph_vault`。
3. PASS。batch 侧 `canRepairLocalArtifactGate`、`repairLocalArtifactGate` 和
   `item_local_artifact_gate_repair_reopened` 事件可把失败项恢复为 pending，
   之后进入正常 runner 逻辑。
4. PASS。修复路径只处理 failed 且非 transient/data_compatibility 的本地门禁
   失败；正常 running item 和同 book active running 检查仍保留。
5. PASS。修复输出包含 `repairReason`、`repairedProjection`、
   `repairEvidenceLocator` 和 `repairMode: query_ready_projection_only`，不会把
   投影修复标成 provider/network retry。
6. PASS。failure classifier 先识别 provider status/transient failure；
   `canRepairLocalArtifactGate` 明确拒绝 provider status code 与 transient
   failure。
7. PASS。data compatibility failure 仍被分类为 `data_compatibility`，并触发
   `stop_until_fixed`；派生 capability fallback 不会覆盖该路径。
8. FAIL。TypeScript `deriveCapabilitiesFromBookState` 要求 identity 与当前
   `books.yaml` 的 `sourceHash`、`documentId`、`contentHash` 精确一致；Python
   `_derive_graph_query_capability` 只按 `canonicalBookId` 取 identity，未校验
   identity 是否匹配当前 book 的 source/document/content。
9. PARTIAL。已执行 targeted Python capability tests 和 resume 脚本语法检查；
   完整 Python 文件测试仍因缺少可选依赖失败，见基准 10。
10. PASS。验证缺口已明确记录：完整
    `test/python/test_graphrag_bridge_scope.py` 失败于
    `ModuleNotFoundError: No module named 'nest_asyncio2'`。

## 发现的问题

### High: Python capability 派生可接受过期 identity

位置：
`python/qmd_graphrag/bridge.py:590`、
`python/qmd_graphrag/bridge.py:851`。

Python `_derive_graph_query_capability` 从
`_load_document_identity_map_by_book` 取 `canonicalBookId == bookId` 的
identity 后，直接把 identity 的 `sourceId`、`documentId`、`contentHash`
写入派生 capability。该函数没有校验：

- `identity.sourceId == "sha256:" + book.sourceHash`
- `identity.sourceHash == book.sourceHash`
- `identity.documentId == book.documentId`
- `identity.contentHash == book.normalizedContentHash ?? book.sourceHash`

相比之下，TypeScript
`src/graphrag/capability-catalog.ts:397` 至 `src/graphrag/capability-catalog.ts:419`
在派生 capability 时执行了这些当前 book state 校验，并且
`src/graphrag/capability-catalog.ts:456` 至 `src/graphrag/capability-catalog.ts:480`
优先使用 derived capability 覆盖 stale explicit catalog。

影响：
当 `document-identity-map.yaml` 或 explicit capability catalog 与当前
`books.yaml` 不一致但同一 `bookId` 仍存在时，Python 可能生成带过期
source/document/content identity 的 ready capability。正常 TS CLI 生成的
`capabilityScope` 多数情况下会降低触发概率，但 Python bridge 入口本身没有
达到“validated current book state 优先于 stale catalog data”的基准。

### Medium: 缺少真实 resume 修复函数级覆盖

位置：
`scripts/graphrag/resume-book-workspace.mjs:667`。

现有 TS batch 测试验证了 batch 看到 repair-only 输出后的重开行为，也验证了
错误分类和元数据形态；但针对新增
`repairQueryReadyProjectionIfPossible` 的真实函数路径，未看到直接集成测试。
这不阻断当前判定，因为脚本语法检查与 batch 观测路径已通过，但会增加未来
回归风险。

## 建议修复

1. 在 Python `_derive_graph_query_capability` 中加入与 TypeScript 相同的
   当前 book state 校验，不匹配时抛出明确错误或拒绝派生。
2. 在 `_load_graph_capabilities` 或 `_capability_identity_failure` 中也校验
   explicit capability 与当前 `books.yaml` 的 source/document/content 一致，
   防止 stale explicit catalog 在 Python 路径被接受。
3. 新增 Python 测试：explicit `graph-capabilities.yaml` 缺项但 book state
   当前时应派生成功；identity 或 explicit capability stale 时必须拒绝。
4. 新增 resume 集成测试，使用真实 `repairQueryReadyProjectionIfPossible`
   从 succeeded producer checkpoints 重新发布 `query_ready`，再由 batch 重开
   pending。
5. 补齐或隔离 `nest_asyncio2` 依赖，使
   `test/python/test_graphrag_bridge_scope.py` 能完整运行，避免把环境缺口误判为
   修复通过。

## 验证记录

- `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k "capability_scope"`：
  10 passed, 16 deselected, 8 subtests passed。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/cli.test.ts -t "classifies query-ready projection failures|reopens query-ready|keeps query_ready resume stage|batch runner script includes recovery controls"`：
  7 passed, 180 skipped。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts -t "loadGraphQueryCapabilities|GraphQueryCapabilities|graph query capabilities|capabilities"`：
  1 passed, 44 skipped。
- `python -m pytest test/python/test_graphrag_bridge_scope.py -q`：
  1 failed, 23 passed, 2 skipped, 8 subtests passed；失败原因为缺少
  `nest_asyncio2`。

## 残余风险

未执行真实大 batch（real batch）恢复；当前 batch 恢复判断基于 targeted
Vitest、脚本语法检查和静态路径审计。完整端到端恢复仍建议在修复 High 问题
后用真实 `graph_vault` 样本复跑。
