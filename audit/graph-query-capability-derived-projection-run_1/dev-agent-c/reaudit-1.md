# Dev Agent C Re-audit 1

结论：PASS

上次 FAIL 已修复。Python capability 派生现在与 TypeScript 一样，以当前
`books.yaml` 的 source/document/content 状态为准，并拒绝 stale identity。
repair-only 路径通过重新完成 `query_ready` 触发持久
`catalog/graph-capabilities.yaml` 刷新；真实失败形态
`capabilityScope references unknown or not-ready graphCapabilityId(s)` 仍被覆盖。

## 逐条基准状态

1. PASS。真实错误文本仍在 `resume-book-workspace.mjs` 与
   `batch-failure-classifier.mjs` 的 local artifact gate 识别列表中，batch
   测试覆盖该文本后可进入 repair-only reopen。
2. PASS。缺失 `graph_query` capability 的 `query_ready` book 可通过
   `repairQueryReadyProjectionIfPossible` 从 producer checkpoint/artifact
   evidence 重新发布 `query_ready`，无需删除或手工编辑 `graph_vault`。
3. PASS。batch repair-only 输出 `status: repaired` 后仍会写入
   `item_local_artifact_gate_repair_reopened`，把 failed item 恢复为 pending，
   后续走正常 runner command checks。
4. PASS。repair 只处理 failed、非 transient、非 data_compatibility 的本地
   projection gate failure；同 book active running 检查与 running lease 逻辑
   未被绕过。
5. PASS。repair-only 输出和 checkpoint metadata 使用
   `repairMode: query_ready_projection_only`、`repairReason`、
   `repairedProjection`、`repairEvidenceLocator`，未标记为 provider/network
   retry。
6. PASS。provider status/transient failure 仍优先分类；含 provider status
   code 的 mixed local projection text 不会触发 local artifact gate repair。
7. PASS。data compatibility failure 仍保持 `stop_until_fixed`，并且不会被
   derived capability fallback 隐藏。
8. PASS。Python `_derive_graph_query_capability` 已校验
   `sourceHash`、`sourceId`、`documentId`、`contentHash` 均匹配当前 book state；
   `_load_graph_capabilities` 对请求的 `:graph_query` 优先派生并排除 stale
   explicit catalog fallback。TypeScript 仍通过 derived capability 优先于
   validated explicit catalog。
9. PASS。已执行 targeted Python bridge tests 与 `node --check` 语法检查。
10. PASS。剩余验证缺口已记录：完整 Python 文件测试仍因本地缺少
    `nest_asyncio2` 失败，未被当作功能通过。

## 重点复核

### Python stale identity/source/document/content 拒绝

`python/qmd_graphrag/bridge.py:598` 至 `python/qmd_graphrag/bridge.py:636`
现在从当前 book state 计算 expected source hash、source id、document id 和
content hash，并要求 document identity 全量匹配。手动临时断言分别篡改
`sourceHash`、`sourceId`、`documentId`、`contentHash`，均被拒绝。

`python/qmd_graphrag/bridge.py:908` 至 `python/qmd_graphrag/bridge.py:936`
对请求的 `book:graph_query` 总是尝试从当前 book state 派生；若派生失败，直接
抛出派生错误，不再回退使用 stale explicit catalog。该行为与
`src/graphrag/capability-catalog.ts:411` 至
`src/graphrag/capability-catalog.ts:480` 的 TypeScript 当前状态优先策略一致。

### Repair-only 持久 projection 刷新

`scripts/graphrag/resume-book-workspace.mjs:685` 至
`scripts/graphrag/resume-book-workspace.mjs:709` 在 repair-only 中重新
`repo.completeStage({ stage: "query_ready" })`，并使用 validated producer
artifact evidence。

`src/job-state/repository.ts:2472` 至 `src/job-state/repository.ts:2503`
对 `query_ready` success checkpoint 重新校验 producer stages、query artifacts
和 graph identity。随后 `src/job-state/repository.ts:2555` 至
`src/job-state/repository.ts:2660` 调用 `publishGraphCapabilities` 和
`recordGraphCapability`，刷新持久 `catalog/graph-capabilities.yaml`。

### 真实错误形态覆盖

`capabilityScope references unknown or not-ready graphCapabilityId(s)` 仍被分类为
local artifact gate failure。相关 batch tests 覆盖了该文本的 reopen metadata，
并确认 provider/data compatibility 混合场景不会误触发 repair。

## 剩余问题

无阻断问题。

残余风险：

- 缺少直接断言 repair-only 后 `catalog/graph-capabilities.yaml` 文件内容已刷新
  的专项测试；当前结论基于 `repo.completeStage(query_ready)` 调用链静态审计和
  既有 capability catalog tests。
- 完整 Python 文件测试仍受本地可选依赖 `nest_asyncio2` 缺失影响。
- 未执行真实大 batch 样本恢复；当前判断基于 targeted tests、手动临时断言和
  静态路径审计。

## 验证记录

- `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k "capability_scope"`：
  12 passed, 16 deselected, 8 subtests passed。
- `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k "capability_scope and (explicit_catalog or derived_capability)"`：
  5 passed, 23 deselected。
- 手动临时 Python 断言：
  stale identity cases rejected: sourceHash sourceId documentId contentHash。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/cli.test.ts -t "classifies query-ready projection failures|reopens query-ready|keeps query_ready resume stage|batch runner script includes recovery controls|mixed provider failure and local projection text does not repair|data compatibility"`：
  12 passed, 175 skipped。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts -t "loadGraphQueryCapabilities|GraphQueryCapabilities|graph query capabilities|capabilities|query_ready"`：
  1 passed, 44 skipped。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/unified-query.test.ts -t "does not derive capability when graph identity mismatches book state"`：
  1 passed, 34 skipped。
- `python -m pytest test/python/test_graphrag_bridge_scope.py -q`：
  1 failed, 25 passed, 2 skipped, 8 subtests passed；失败原因仍为
  `ModuleNotFoundError: No module named 'nest_asyncio2'`。

备注：曾执行一次无效的 pytest `-k` 表达式，命令因表达式语法错误退出，未计入
通过验证。
