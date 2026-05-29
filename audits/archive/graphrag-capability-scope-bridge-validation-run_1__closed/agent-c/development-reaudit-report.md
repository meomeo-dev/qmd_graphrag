# Agent C Development Reaudit Report

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-c/development-audit-criteria.md`

复审重点：新增 run record candidate 修复是否仍限于 bridge validation 和测试范围；
验证命令是否真实执行；空匹配测试是否未被计入。

## 发现项

未发现阻断性问题。新增 run record candidate 修复仍只涉及
`python/qmd_graphrag/bridge.py` 与 `test/python/test_graphrag_bridge_scope.py`，
没有无关配置、LLM、token、网络恢复策略或批处理改动。

## 风险

1. Python bridge 现在复制了更多 TypeScript `projectQueryReadyLineage()` 候选选择
逻辑。后续 TypeScript 端若调整 run record candidate 规则，Python bridge 仍需同步。

2. Run record candidate 的 content hash 与 provider fingerprint 由 book state 和
metadata 投影得到，当前实现与 TypeScript 语义一致，但依赖 artifact validator
继续作为最终 gate。开发后续改动不能绕过 `_validate_artifact_subset()`。

3. `status.yaml` 的真实失败书 probe 仍以摘要方式记录；当前可接受，但提交或发布前
最好保留可追溯 probe 输出或脚本。

## 逐条基准结论

1. PASS - 实现只触及必要的 bridge validation 和本次回归测试范围

证据：`git diff --name-only` 仅包含 `python/qmd_graphrag/bridge.py` 和
`test/python/test_graphrag_bridge_scope.py`。新增逻辑包括 run record candidate 读取、
checkpoint candidate 选择、query-ready lineage projection，以及对应 Python scope
回归测试，均属于本 case 的 bridge validation 范围。

必要修正建议：无。

2. PASS - 不改变 LLM 调用、并发、token、网络恢复策略或配置模板

证据：当前 diff 未触及 LLM adapter、runtime、GraphRAG vendor、配置模板、token
参数、并发设置、网络恢复策略或批处理脚本。复审对象只包含 bridge validation 与
测试。

必要修正建议：无。

3. PASS - 不改变 qmd / GraphRAG 构建状态展示语义

证据：当前 diff 未修改 CLI、batch status、build status schema、GraphRAG 构建流程
或状态展示代码。新增 run record candidate 只影响 Python bridge 查询前 capability
scope validation，不改变构建状态展示。

必要修正建议：无。

4. PASS - `_load_graph_capabilities()` 对真实失败书恢复 ready 判定

证据：`status.yaml` 记录真实失败书 probe：
`_load_graph_capabilities real failure probe for book-356ff4920cdf-0bbd8bdb and
book-2d1d667301e9-e5c877e8`。当前实现中 `_load_graph_capabilities()` 通过
`_derive_graph_query_capability()` 调用 `_load_query_ready_lineage_artifact_ids()`，
后者使用 `_project_query_ready_lineage()` 从 checkpoint 与 run record candidates
中选择有效 producer lineage。

必要修正建议：无。

5. PASS - `_load_graph_capabilities()` 对缺失当前 stats artifact 继续失败

证据：测试
`test_capability_scope_rejects_manifest_missing_current_stats_artifact` 删除当前 manifest
中的 stats artifact 后断言 capability 解析失败。实现中即使存在 stale checkpoint
id，最终仍通过 `_validate_artifact_subset()` 要求 required kinds 齐全、artifact 存在
且内容有效。

必要修正建议：无。

6. PASS - `_load_graph_capabilities()` 对 producer run id 不匹配继续失败

证据：测试 `test_capability_scope_rejects_manifest_stats_artifact_wrong_run` 将 stats
artifact 的 `producerRunId` 改为旧 run 并断言失败。实现中
`_artifact_ids_for_producer_stage()` 按 producer run id 选择当前 manifest artifact，
`_validate_artifact_subset()` 也继续校验 producer run id。

必要修正建议：无。

7. PASS - `_load_graph_capabilities()` 对 fingerprint 不匹配继续失败

证据：测试
`test_capability_scope_rejects_manifest_stats_artifact_wrong_fingerprint` 覆盖 manifest
stats artifact stage fingerprint 不匹配。新增测试
`test_capability_scope_rejects_run_record_candidate_without_stage_fingerprint` 还覆盖 run
record candidate 缺失有效 stage fingerprint 时 fail-closed。实现中
`_checkpoint_matches_book()` 和 `_validate_artifact_subset()` 都会校验 stage/provider
fingerprint。

必要修正建议：无。

8. PASS - 保留 request scope 中 artifactIds 的 subset 校验

证据：`_validate_capabilities_against_request_scope()` 仍保留
`requested_artifacts` 非空时 `artifact_ids.issubset(requested_artifacts)` 的校验。
新增 run record candidate 只改变 ready lineage 的来源，不改变 request scope
artifactIds 上界约束。

必要修正建议：无。

9. PASS - 所列验证命令真实执行，且空匹配测试未被计入

证据：`status.yaml` 的 `verification.passed` 记录了 Python unittest、py_compile、
真实失败书 probe、非空匹配的 CLI 测试、`test/book-job-state.test.ts`、
`typecheck` 和 `git diff --check`。`status.yaml` 明确说明早先
`cli.test.ts -t "capabilityScope references unknown"` 匹配不到测试，未计入
verification。本次复审实际运行：
`python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`，
结果为 `Ran 18 tests` / `OK`；同时实际运行 `python -m py_compile ...` 与
`git diff --check`，均通过。

必要修正建议：无。

10. PASS - 审计报告给出明确 verdict，且未通过时不得进入提交和真实跑

证据：本复审报告逐条列出 PASS、证据、风险和必要修正建议；最后一行使用固定
verdict 格式。本轮无阻断性 FAIL。

必要修正建议：无。

## 总体结论

新增 run record candidate 修复没有扩大到无关配置、LLM、token、网络恢复或批处理
改动。Python bridge 现在从 checkpoints 与 `catalog/runs.yaml` backed run records
构造 candidates，并继续通过 book identity、stage/provider/content hash 和 artifact
subset validator fail-closed。验证记录未计入空匹配测试，本次复审也实际确认 Python
scope 命令运行 18 个测试并通过。

verdict: development_audit_passed
