# Agent C Design Reaudit Report

审计对象：
`audit/graphrag-capability-scope-bridge-validation-run_1/revised-design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1/agent-c/audit-criteria.md`

复审重点：确认上轮第 10 条“可执行验证命令和提交前工作树卫生要求”是否已补足。

## 发现项

1. FAIL - Python bridge 验证命令仍不可执行

修订设计已移除不存在的 `npm run test:python`，但替换为：

`PYTHONPATH=python python -m unittest test.python.test_graphrag_bridge_scope`

该命令在当前仓库结构下仍不可执行。`test/` 和 `test/python/` 没有
`__init__.py`，不能作为 `test.python.test_graphrag_bridge_scope` 模块导入。
实际核对命令返回：

`ModuleNotFoundError: No module named 'test.python'`

因此第 10 条固定基准仍未满足。

必须修改的设计项：将 Python 验证命令改为当前仓库可执行形式，例如：

`PYTHONPATH=python python test/python/test_graphrag_bridge_scope.py`

如果实现需要 vendor `graphrag-llm` 路径，也应显式写入：

`PYTHONPATH=python:vendor/graphrag/packages/graphrag-llm python test/python/test_graphrag_bridge_scope.py`

或在设计中明确新增 `__init__.py` / `test:python` script 并把对应改动纳入实现。

## 风险

1. Python 验证命令不可执行会导致开发审计无法按设计复现 bridge scope 测试，
从而无法固定验证 `_load_graph_capabilities()` 的陈旧 stats artifact id 恢复场景。

2. 设计中 Python 与 TypeScript 的 manifest projection 仍是重复逻辑。即使命令
修正后，开发审计仍需要重点核对 `_load_query_ready_lineage_artifact_ids()` 和
`_validate_query_ready_artifacts()` 是否都改为按当前 manifest 投影，而不是只修
其中一个入口。

3. 真实 EPUB 后续继续运行仍可能被 `community_report`、`embed`、provider 或凭据
问题阻断。该风险与本地 capability scope validation 漂移不同，后续状态记录需要
保持分类清晰。

## 逐条基准结论

1. PASS - 保护 GraphRAG 产物隔离，不允许跨书 capability 污染

证据：修订设计继续要求按 `bookId + stage + producerRunId + requiredKinds` 从当前
`artifacts.yaml` 选择 artifact ids，并保留 book-scoped output / lancedb 路径约束。
新增 `Request Scope Validation` 明确 capability 解析出的 book 不得超出
`selectedBookIds`，source、document、content hash 和 artifact id 不得越过请求边界。

必要修正建议：无。

2. PASS - 保护阶段门控，不允许旧 checkpoint 直接证明当前 `query_ready`

证据：`Invariants` 继续规定 checkpoint artifact ids 只能作为历史线索，不能覆盖
当前 manifest 投影。`Lineage Projection` 要求从已验证 producer checkpoints 和当前
manifest 计算 lineage，`Query-Ready Validation` 保留 producer run id、stage
fingerprint、provider fingerprint、content hash、book-scoped output 和 artifact hash
校验。

必要修正建议：无。

3. PASS - stats artifact 陈旧 id 的场景可恢复

证据：`Problem` 保留真实失败根因：checkpoint 中旧 stats artifact id 与当前
manifest 的有效 stats artifact 不一致。`Artifact Selection` 要求 GraphRAG 高成本
producer stage 优先从当前 manifest 按 `stage + producerRunId + kind` 选择 artifact
ids；`Tests` 第 1 条要求 `_load_graph_capabilities()` 在该场景通过。

必要修正建议：无。

4. PASS - manifest 缺失 stats artifact 的场景继续失败

证据：`Invariants` 第 6 条要求当前 manifest 无法按 producer run id 和 required kind
补齐产物时 fail closed；`Tests` 第 2 条明确覆盖 manifest 缺失 stats artifact 的失败。

必要修正建议：无。

5. PASS - manifest 中 stats artifact producer lineage 不匹配继续失败

证据：`Tests` 第 3 条覆盖 producer run id 不匹配，第 4 条覆盖 fingerprint、provider
fingerprint 或 content hash 不匹配。`Query-Ready Validation` 保留对应校验边界。

必要修正建议：无。

6. PASS - 要求 Python 单元测试覆盖 `_load_graph_capabilities()`

证据：`Tests` 第 1 条直接要求 `_load_graph_capabilities()` 覆盖陈旧 checkpoint
stats id 但当前 manifest 有效时通过的场景。

必要修正建议：无。

7. PASS - 要求既有 scope validation 测试保持通过

证据：`Tests` 第 5 条要求既有 capability scope 测试保持通过，并增加
`graphCapabilityIds` 边界，证明 selectedBookIds、sourceIds、documentIds、
contentHashes、artifactIds 和 graphCapabilityIds 均不被放宽。

必要修正建议：无。

8. PASS - 不改变 LLM 调用、并发、token 或网络恢复策略

证据：`Proposed Change` 仍将改动限制在 `python/qmd_graphrag/bridge.py` 的 bridge
validation 层。`Invariants` 和 `Non-Goals` 明确不修改 GraphRAG vendor、LLM 请求
参数、输出渲染、research 子命令、EPUB 批处理主流程、并发配置或 token 配置。

必要修正建议：无。

9. PASS - 不改变 qmd / GraphRAG 构建状态展示语义

证据：修订设计只改变查询前 Python bridge scope validation 的 artifact 投影，不修复
或重写历史运行产物，不改变 qmd 查询、输出格式或 EPUB 批处理主流程。错误分类仍要求
真正缺失或不合法 capability 作为本地阻断，而非 transient 网络错误。

必要修正建议：无。

10. FAIL - 可执行验证命令和提交前工作树卫生要求

证据：修订设计已保留 `git diff --check`，也通过 `Non-Goals` 要求不提交运行产物；
但 Python bridge 验证命令仍不可执行。`PYTHONPATH=python python -m unittest
test.python.test_graphrag_bridge_scope` 在当前仓库中无法导入 `test.python` 模块，
不满足“可执行验证命令”要求。

必要修正建议：将 Python 命令改为文件路径执行形式，或同步设计 package/script
改动使模块执行形式真实可用。建议同时补充 `git status --short
--untracked-files=all` 作为提交前工作树卫生检查，明确确认没有 `graph_vault`、
`.qmd`、`inbox`、`tmp` 或 `.tmp-tests` 运行产物进入提交。

## 总体结论

修订设计补强了 request scope validation 边界，也继续保持 manifest 投影、阶段
门控、fail-closed 和非目标约束。但上轮核心 FAIL 项没有完全关闭：Python bridge
回归验证命令虽然更换了形式，仍不是当前仓库可执行命令。因此本轮 Agent C 设计
复审仍不通过。

verdict: design_audit_failed
