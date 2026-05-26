# Dev Agent C 最终复审报告

## 结论

PASS。

固定基线仍为 `baseline.md` 中 10 条，未替换或扩展基准。本次复审未发现
阻断项（blocking issue）。当前最终代码已覆盖真实失败形态
`capabilityScope references unknown or not-ready graphCapabilityId(s)`，并且
Python/TypeScript 均以当前 book state 为优先可信来源（source of truth），
拒绝 stale identity/source/document/content；provider transient 与
data compatibility 分类不会被 local projection repair 覆盖。

## 逐条基准结果

1. PASS。真实错误形态已覆盖。`resume-book-workspace.mjs` 和
   `batch-failure-classifier.mjs` 均将
   `capabilityscope references unknown or not-ready graphcapabilityid` 识别为
   local artifact gate，见 `scripts/graphrag/resume-book-workspace.mjs:250`
   和 `scripts/graphrag/batch-failure-classifier.mjs:165`；测试覆盖精确错误
   文本，见 `test/cli.test.ts:1957`、`test/cli.test.ts:4212`。

2. PASS。`query_ready` 且缺少 graph query command checks 的书可通过
   projection-only repair 恢复，不要求删除或手工编辑 `graph_vault`。
   修复路径使用现有 query-ready 生产者 artifacts 重新 complete
   `query_ready`，随后重新同步当前 book 并校验 graph query scope，见
   `scripts/graphrag/resume-book-workspace.mjs:685`、
   `scripts/graphrag/resume-book-workspace.mjs:692`、
   `scripts/graphrag/resume-book-workspace.mjs:711`、
   `scripts/graphrag/resume-book-workspace.mjs:729`。

3. PASS。batch recovery 能在代码修复后通过正常 runner 逻辑 reopen failed
   item。`test/cli.test.ts:4242` 覆盖 query-ready projection gate failure
   reopen，并确认 repair metadata。

4. PASS。repair 不会任意中断当前运行中的其他 book work。repair-only 路径在
   `nextStage` 非空且不是 `query_ready` 时直接跳过，见
   `scripts/graphrag/resume-book-workspace.mjs:678`；持久化 complete 只作用于
   当前 `bookId` 的 `query_ready` stage，见
   `scripts/graphrag/resume-book-workspace.mjs:692`。

5. PASS。观测路径能区分 projection repair 与真实 rebuild/provider retry。
   repair metadata 标记 `readinessSource: local_artifact_gate_repair`、
   `recoveredFromLocalArtifactGateFailure: true` 和
   `repairMode: query_ready_projection_only`，见
   `scripts/graphrag/resume-book-workspace.mjs:701`；返回的
   `repairedCheckpointStages` 仅含 `query_ready`，见
   `scripts/graphrag/resume-book-workspace.mjs:738`。

6. PASS。provider transient failure 仍按 transient 分类，且不会被 local
   projection repair 吞掉。classifier 先处理 provider status code 和 provider
   transient text，再处理 data compatibility 和 local gate，见
   `scripts/graphrag/batch-failure-classifier.mjs:8`、
   `scripts/graphrag/batch-failure-classifier.mjs:33`、
   `scripts/graphrag/batch-failure-classifier.mjs:40`、
   `scripts/graphrag/batch-failure-classifier.mjs:47`；repair guard 拒绝带
   provider status code 或 transient 分类的 checkpoint，见
   `scripts/graphrag/batch-epub-workflow.mjs:718`、
   `scripts/graphrag/batch-epub-workflow.mjs:721`。混合 provider failure 与
   local projection text 的测试见 `test/cli.test.ts:4626`。

7. PASS。永久 data compatibility failure 仍为 stop-until-fixed，不被 derived
   capability fallback 隐藏。classifier 在 local gate 前识别
   `data_compatibility`，见
   `scripts/graphrag/batch-failure-classifier.mjs:40`；repair guard 显式拒绝
   `data_compatibility`，见 `scripts/graphrag/batch-epub-workflow.mjs:721`。
   混合 data compatibility 与 local projection text 的测试见
   `test/cli.test.ts:4478`，非 transient data compatibility 停批测试见
   `test/cli.test.ts:5469`。

8. PASS。Python 与 TypeScript capability 行为一致：均优先使用验证过的当前
   book state，并拒绝 stale explicit catalog data。Python 派生 capability
   用当前 book state 计算期望 `sourceHash/sourceId/documentId/contentHash`，
   并逐项拒绝 mismatch，见 `python/qmd_graphrag/bridge.py:598`、
   `python/qmd_graphrag/bridge.py:629`、
   `python/qmd_graphrag/bridge.py:631`、
   `python/qmd_graphrag/bridge.py:633`、
   `python/qmd_graphrag/bridge.py:635`；加载时对请求的
   `:graph_query` 排除显式目录回退，并在派生失败时抛错，见
   `python/qmd_graphrag/bridge.py:890`、
   `python/qmd_graphrag/bridge.py:927`、
   `python/qmd_graphrag/bridge.py:933`。TypeScript 同样按当前 book state
   匹配 identity，见 `src/graphrag/capability-catalog.ts:411` 至
   `src/graphrag/capability-catalog.ts:419`；并先放入 derived capabilities，
   再跳过同 capabilityId 或同语义键的 explicit capability，见
   `src/graphrag/capability-catalog.ts:456` 至
   `src/graphrag/capability-catalog.ts:479`。

9. PASS。已执行目标 Python bridge 测试、script syntax check 和相关 Node
   回归测试。命令与结果如下：
   `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k "capability_scope"`
   通过，12 passed、17 deselected、8 subtests passed；
   `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k "graph_text_unit_list or request_scope_rejects_identity_with_non_list_graph_text_units or request_scope_rejects_identity_missing_graph_text_units"`
   通过，1 passed、28 deselected；
   `node --check scripts/graphrag/resume-book-workspace.mjs` 通过；
   `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/cli.test.ts -t "classifies query-ready projection failures|reopens query-ready|keeps query_ready resume stage|batch runner script includes recovery controls|mixed provider failure and local projection text does not repair|data compatibility"`
   通过，12 passed、175 skipped；
   `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts -t "loadGraphQueryCapabilities|GraphQueryCapabilities|graph query capabilities|capabilities|query_ready"`
   通过，1 passed、44 skipped；
   `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/unified-query.test.ts -t "does not derive capability when graph identity mismatches book state"`
   通过，1 passed、34 skipped。

10. PASS，且验证缺口已记录。完整
    `python -m pytest test/python/test_graphrag_bridge_scope.py -q` 仍因本地缺少
    可选依赖（optional dependency）`nest_asyncio2` 在非本次目标用例
    `test_graphrag_index_applies_workflows_and_skip_validation` 失败：
    `ModuleNotFoundError: No module named 'nest_asyncio2'`。其余结果为
    26 passed、2 skipped、8 subtests passed。该缺口不改变本次固定基线下的
    PASS 结论，但应在合并前由具备完整 Python optional dependencies 的环境
    复跑全量 Python 测试。

## 新增 request-scope graphTextUnitIds 校验

未发现回归。Python 派生 capability 要求 `graphTextUnitIds` 为非空 list，见
`python/qmd_graphrag/bridge.py:639`；request-scope 校验也要求持久 identity
中的 `graphTextUnitIds` 为非空 list，见 `python/qmd_graphrag/bridge.py:799`
至 `python/qmd_graphrag/bridge.py:806`。对应测试覆盖派生阶段非 list 拒绝和
request-scope 阶段非 list 拒绝，见
`test/python/test_graphrag_bridge_scope.py:1084`、
`test/python/test_graphrag_bridge_scope.py:1169`、
`test/python/test_graphrag_bridge_scope.py:1184`。

## 剩余问题

无阻断问题。

残余风险如下：

- 本次未运行真实长批量（real batch）端到端作业；结论基于代码审计、固定错误
  文本覆盖和目标回归测试。
- 完整 Python 文件测试受本地缺少 `nest_asyncio2` 阻断，需在完整依赖环境复跑。
- repair-only 持久 projection 刷新通过 `completeStage(query_ready)` 到
  `publishGraphCapabilities()`、再到 `recordGraphCapability()` 的调用链确认，
  见 `src/job-state/repository.ts:2472`、`src/job-state/repository.ts:2555`、
  `src/job-state/repository.ts:2590`、`src/job-state/repository.ts:2660`；本轮未
  增加或修改测试，仅复审既有覆盖。

## 建议修复

无必需修复项。建议在合并前使用安装了 `nest_asyncio2` 的完整 Python 环境复跑
全量 `test/python/test_graphrag_bridge_scope.py`，并在条件允许时补充一次真实
batch fixture 或沙箱作业，以降低 projection-only repair 在真实工作负载中的
残余集成风险。
