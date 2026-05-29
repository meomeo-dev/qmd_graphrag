# Agent C Design Audit Report

审计对象：`audit/graphrag-capability-scope-bridge-validation-run_1__closed/design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-c/audit-criteria.md`

## 发现项

1. FAIL - 验证命令中包含当前项目不可执行的 npm script

设计在回归验证命令中列出：

`npm run test:python -- test/python/test_graphrag_bridge_scope.py`

但当前 `package.json` 未定义 `test:python` script。项目现有 Python bridge scope
测试由 `scripts/test-all.mjs` 直接选择 Python 解释器并运行
`test/python/test_graphrag_bridge_scope.py`，不是通过 `npm run test:python`
执行。因此设计没有完全满足“可执行验证命令”的固定基准。

必须修改的设计项：将 Python bridge 验证命令改为当前仓库可执行形式，例如
使用 `QMD_GRAPHRAG_TEST_PYTHON` / `PYTHONPATH` 明确运行
`test/python/test_graphrag_bridge_scope.py`，或先在实现计划中新增并验证
`test:python` npm script。修订后命令必须能由开发者直接复制执行。

## 风险

1. Python 与 TypeScript 的 artifact 投影逻辑存在重复实现风险。设计要求 Python
bridge 补齐 TypeScript 的 `stage + producerRunId + kind` manifest 投影规则，
但两端未来仍可能再次漂移；后续实现需要用覆盖陈旧 stats artifact id 的回归测试
锁住行为。

2. 设计将修复限制在 Python bridge validation 层，这是正确边界，但也意味着真实
EPUB 继续运行仍可能因后续 `community_report`、`embed`、provider、网络或凭据
问题失败。此类失败必须与本地 capability scope validation 漂移区分。

3. 如果实现时只修 `_load_query_ready_lineage_artifact_ids()`，但
`_validate_query_ready_artifacts()` 内部仍用 checkpoint artifact ids 验证 producer
stage，则陈旧 stats id 可能仍在二次验证中失败。设计已经说明输入 artifact ids
应改为当前 manifest 投影结果；开发审计需要重点核对该点。

## 逐条基准结论

1. PASS - 保护 GraphRAG 产物隔离，不允许跨书 capability 污染

证据：设计的 `Artifact Selection` 要求按 `bookId + stage + producerRunId +
requiredKinds` 从当前 `artifacts.yaml` 选择 artifact ids；`Query-Ready
Validation` 要求 artifact 必须 book-scoped，路径位于
`books/<bookId>/output/` 或 book-scoped lancedb 目录。`Invariants` 第 8 条明确
不得让跨书产物通过。

必要修正建议：无。

2. PASS - 保护阶段门控，不允许旧 checkpoint 直接证明当前 `query_ready`

证据：`Invariants` 第 2 条保留 producer lineage、fingerprint、content hash、
book-scoped output 和 artifact hash 校验；第 4 条明确 checkpoint artifact ids
只能作为历史线索，不能覆盖当前 manifest 中按 stage、producer run id、kind 选择
的有效 artifact。`Lineage Projection` 也要求从已验证 producer checkpoints 和
当前 manifest 计算 lineage。

必要修正建议：无。

3. PASS - stats artifact 陈旧 id 的场景可恢复

证据：`Problem` 明确描述 Python bridge 因 checkpoint 中旧
`graphrag_stats_json` artifact id 而失败，当前 `artifacts.yaml` 中已有同一
producer run 的有效 stats artifact。`Artifact Selection` 要求高成本 producer
stage 优先从当前 manifest 按 `stage + producerRunId + requiredKinds` 选择
artifact ids；`Tests` 第 1 条要求 checkpoint stats id 陈旧但当前 manifest 有效
时 `_load_graph_capabilities()` 通过。

必要修正建议：无。

4. PASS - manifest 缺失 stats artifact 的场景继续失败

证据：`Invariants` 第 6 条要求当前 manifest 无法按 producer run id 和 required
kind 补齐产物时 Python bridge 继续 fail closed。`Tests` 第 2 条明确要求当前
manifest 缺失 stats artifact 时同一 capability 继续失败。

必要修正建议：无。

5. PASS - manifest 中 stats artifact producer lineage 不匹配继续失败

证据：`Query-Ready Validation` 要求 producer run id 匹配有效 checkpoint，并继续
校验 stage fingerprint、provider fingerprint 和 corpus content hash。`Tests`
第 3 条覆盖 stats artifact producer run id 不匹配时 fail closed，第 4 条覆盖
fingerprint、provider fingerprint 或 content hash 不匹配时 fail closed。

必要修正建议：无。

6. PASS - 要求 Python 单元测试覆盖 `_load_graph_capabilities()`

证据：`Tests` 第 1 条明确以 `_load_graph_capabilities()` 为验证对象，要求陈旧
checkpoint stats id 但当前 manifest 有效时通过。该测试直接覆盖真实失败发生的
Python bridge capability 加载路径。

必要修正建议：无。

7. PASS - 要求既有 scope validation 测试保持通过

证据：`Tests` 第 5 条要求既有 capability scope 测试保持通过，并明确覆盖
`selectedBookIds`、`sourceIds`、`documentIds`、`contentHashes` 和 `artifactIds`
边界不被放宽。

必要修正建议：无。

8. PASS - 不改变 LLM 调用、并发、token 或网络恢复策略

证据：`Proposed Change` 将改动窄化在 `python/qmd_graphrag/bridge.py` 的 bridge
validation 层。`Invariants` 第 7 条和 `Non-Goals` 第 4 条明确不修改 GraphRAG
vendor、LLM 请求参数、输出渲染、research 子命令、EPUB 批处理主流程、qmd 查询、
并发配置或 token 配置。

必要修正建议：无。

9. PASS - 不改变 qmd / GraphRAG 构建状态展示语义

证据：设计只改变 Python bridge 对 query capability scope 的 artifact 选择与
验证，不修复或重写历史运行产物，不改变 EPUB 批处理主流程，不改变输出格式。
`Invariants` 第 9 条还要求真正缺失或不合法 capability 仍分类为本地阻断，而非
transient 网络错误，保留构建和查询状态诊断语义。

必要修正建议：可选增强：在 `Non-Goals` 中直接增加“不改变 qmd / GraphRAG build
status display semantics”一句，以便后续开发审计更直接核对。

10. FAIL - 可执行验证命令和提交前工作树卫生要求

证据：设计列出了回归验证命令和 `git diff --check`，也在 `Non-Goals` 中要求不
提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或 `.tmp-tests` 运行产物，覆盖了工作
树卫生方向。但第一条验证命令 `npm run test:python -- test/python/test_graphrag_bridge_scope.py`
在当前 `package.json` 中不存在对应 `test:python` script，不能作为可执行命令。

必要修正建议：修订验证命令。可以选择新增 `test:python` script 并在设计中写明，
或改为当前仓库已有的直接 Python 命令，并显式设置 `PYTHONPATH=python:vendor/graphrag/packages/graphrag-llm`
和满足 pandas、PyYAML、pydantic 的 Python 解释器。保留 `git diff --check`，并
建议补充 `git status --short --untracked-files=all` 或等价命令，明确确认无运行
产物进入提交。

## 总体结论

设计在安全边界上基本正确：它保持当前 manifest 为 artifact 真源，继续验证
producer lineage、stage/provider/content hash、book-scoped output 和 artifact
完整性，并覆盖陈旧 stats artifact id 的真实恢复场景及 fail-closed 反例。

本轮不通过的原因是固定基准第 10 条：验证命令包含当前仓库不可执行的
`npm run test:python`。在修订为真实可执行命令前，设计不能通过 Agent C 固定
设计审计。

verdict: design_audit_failed
