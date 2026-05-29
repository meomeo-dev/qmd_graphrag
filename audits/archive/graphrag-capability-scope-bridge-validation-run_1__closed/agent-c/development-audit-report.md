# Agent C Development Audit Report

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-c/development-audit-criteria.md`

审计范围：当前工作区 diff、`status.yaml` 验证记录、重点文件
`python/qmd_graphrag/bridge.py` 与 `test/python/test_graphrag_bridge_scope.py`。

## 发现项

未发现阻断性实现缺陷。当前 diff 只修改 Python bridge validation 与对应 Python
scope 测试，没有触及配置模板、LLM 调用、并发、token、网络恢复策略或 EPUB 批处理
主流程。

## 风险

1. Python bridge 与 TypeScript capability projection 仍是双实现。当前测试锁定了
陈旧 stats artifact id 和主要 fail-closed 场景，但后续如新增 artifact kind 或
producer stage，仍需要同步更新两端投影规则。

2. 当前真实失败书 probe 记录为摘要形式：`status.yaml` 记录了 `_load_graph_capabilities`
真实失败书 probe 覆盖两个 book id，但未内嵌完整 stdout。开发审计接受该记录，
后续提交前最好保留可追溯的 probe 脚本或日志路径。

3. 本次 Python 单元测试聚焦 `capability_scope` 子集。该范围符合本 case，但若后续
bridge 非 scope 路径也被改动，应追加完整 Python bridge 文件级测试。

## 逐条基准结论

1. PASS - 实现只触及必要的 bridge validation 和本次回归测试范围

证据：`git diff --name-only` 仅包含 `python/qmd_graphrag/bridge.py` 和
`test/python/test_graphrag_bridge_scope.py`。`bridge.py` 的改动集中在
`_artifact_ids_for_producer_stage()`、`_load_query_ready_lineage_artifact_ids()` 和
`_validate_query_ready_artifacts()`；测试改动集中在 capability scope fixtures 和
回归测试。

必要修正建议：无。

2. PASS - 不改变 LLM 调用、并发、token、网络恢复策略或配置模板

证据：当前 diff 没有修改配置文件、settings projection、LLM adapter、runtime、
batch workflow、token 参数或网络恢复逻辑。只涉及 Python bridge scope validation
和测试。

必要修正建议：无。

3. PASS - 不改变 qmd / GraphRAG 构建状态展示语义

证据：当前 diff 未修改 CLI、batch status、build status schema、GraphRAG build
流程或状态展示代码。错误仍通过 capability scope validation 的本地
`ValueError("capabilityScope references unknown or not-ready ...")` 路径表达，不被
重新分类为 transient 网络错误。

必要修正建议：无。

4. PASS - `_load_graph_capabilities()` 对真实失败书恢复 ready 判定

证据：`status.yaml` 的 `verification.passed` 记录真实失败书 probe：
`PYTHONPATH=python python - <<'PY' ... _load_graph_capabilities real failure probe`
覆盖 `book-356ff4920cdf-0bbd8bdb` 和 `book-2d1d667301e9-e5c877e8`。这两个 book id
正是本 case trigger 中的失败书。实现中 `_load_graph_capabilities()` 会派生
capability 并用 `_load_query_ready_lineage_artifact_ids()` 与
`_validate_query_ready_artifacts()` 重新验证；这些路径现在按当前 manifest
选择 producer artifacts。

必要修正建议：无。

5. PASS - `_load_graph_capabilities()` 对缺失当前 stats artifact 继续失败

证据：新增测试
`test_capability_scope_rejects_manifest_missing_current_stats_artifact` 删除当前
manifest 中的 `artifact-1-stats`，并断言 `_resolve_capability_scoped_book_ids()`
抛出 `unknown or not-ready`。该路径会调用 `_load_graph_capabilities()`。

必要修正建议：无。

6. PASS - `_load_graph_capabilities()` 对 producer run id 不匹配继续失败

证据：新增测试
`test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 将当前 stats artifact
的 `producerRunId` 改为旧 run，并断言 capability 解析失败。实现中
`_validate_artifact_subset()` 继续要求 artifact 的 `producerRunId` 匹配对应 stage
的 expected producer run id。

必要修正建议：无。

7. PASS - `_load_graph_capabilities()` 对 fingerprint 不匹配继续失败

证据：新增测试
`test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint` 将当前 stats
artifact 的 `stageFingerprint` 改为旧值，并断言 capability 解析失败。实现中
`_validate_artifact_subset()` 继续校验 stage fingerprint、provider fingerprint 和
corpus content hash。

必要修正建议：无。

8. PASS - 保留 request scope 中 artifactIds 的 subset 校验

证据：`_validate_capabilities_against_request_scope()` 仍保留
`if requested_artifacts and not artifact_ids.issubset(requested_artifacts): raise
ValueError("graph capability artifactIds outside requested scope")`。新增改动只改变
lineage artifact ids 的来源，不改变 request scope 上界约束。既有
`test_capability_scope_derives_capability_without_explicit_catalog` 仍通过完整
`artifactIds` scope 调用 `_validate_capabilities_against_request_scope()`。

必要修正建议：无。

9. PASS - 所列验证命令是真实执行过的命令，且空匹配测试未被计入

证据：`status.yaml` 的 `verification.passed` 记录了实际通过的命令，包括：

- `python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`
- `python -m py_compile python/qmd_graphrag/bridge.py test/python/test_graphrag_bridge_scope.py`
- `_load_graph_capabilities` 真实失败书 probe，覆盖两个失败 book id
- `npm run test:node -- test/cli.test.ts -t "reopens query-ready 'graph capability' projection gate failures"`
- `npm run test:node -- test/book-job-state.test.ts`
- `npm run typecheck`
- `git diff --check`

`status.yaml` 还明确记录早先 `cli.test.ts -t "capabilityScope references unknown"`
匹配不到测试，且未计入 verification。本审计期间也实际执行了 Python capability
scope 命令，结果为 `Ran 16 tests` / `OK`，并执行了 `git diff --check`，无输出。

必要修正建议：无。

10. PASS - 审计报告给出明确 verdict，且未通过时不得进入提交和真实跑

证据：本报告逐条给出 PASS/FAIL、证据、风险和必要修正建议，并在最后一行使用
固定 verdict 格式。本轮没有阻断性 FAIL。

必要修正建议：无。

## 总体结论

当前实现符合 Agent C 固定开发审计基准。它只在 Python bridge validation 层把
query-ready lineage artifact selection 与当前 `artifacts.yaml` manifest 对齐，并
通过测试覆盖真实 stale stats id 恢复、manifest 缺失 stats、producer run mismatch、
fingerprint mismatch 和 request artifact scope subset 约束。验证记录包含真实失败书
probe，且明确没有把空匹配 CLI 测试计入通过项。

verdict: development_audit_passed
