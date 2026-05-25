# GraphRAG Artifact Gate And Recovery Audit Final Report

## Scope

本轮审计覆盖 GraphRAG 产物隔离、阶段门控、每本书 QMD/GraphRAG
构建状态、上游网络波动下的状态管理与恢复机制，以及查询后输出格式投影。

固定基准在审计前已落盘：

- `agent-a/baseline.md`
- `agent-b/baseline.md`
- `agent-c/baseline.md`

审计期间不得更换基准。所有 PASS/FAIL 结论均以对应 baseline 的 10 条标准为准。

## Audit Results

- Agent A：PASS。阶段门控、full lineage、每书 QMD/GraphRAG 状态满足固定基准。
- Agent B：PASS。`reportDir` 隔离、provider request 边界、统一输出投影满足固定基准。
- Agent C：首次 FAIL，原因是 Type-DD 文档仍保留 stale remote heartbeat 不恢复的冲突规则。
- Agent C rerun 1：FAIL，原因是同一 Type-DD 文件仍有第二处 `running_ownership_rule`
  残留旧语义。
- Agent C rerun 2：PASS。`runner_ownership_rule` 与 `running_ownership_rule`
  均已修正为：fresh remote heartbeat 在 TTL 内只观测不抢占；缺失 ownership、
  heartbeat 超 TTL，或 dead same-host runner PID 时恢复为 pending，并保留
  `recoveryDecision=retry_same_run_id`。

## Fixes Completed

- GraphRAG readiness 不再由 `query_ready` 单点决定，必须验证
  `graph_extract -> community_report -> embed -> query_ready` 完整 lineage。
- Graph extract readiness 纳入 `graphrag_stats_json`。
- GraphRAG raw report 输出通过必填 `reportDir` 隔离到 per-book stage report 目录。
- stale remote runner heartbeat 超 TTL 时可恢复为 retryable pending；fresh remote
  heartbeat 不被抢占。
- provider transient recovery 与 stale runner recovery 分流，避免 orphan recovery
  被误投影为 provider wait。
- Batch 状态暴露 qmd、GraphRAG、query checks，并保留 incomplete manifest。
- `qmd query` 的 `--json`、`--csv`、`--md`、`--xml`、`--files` 均从同一个
  `UnifiedAnswer` 渲染；GraphRAG route 的非 JSON 输出已覆盖测试。

## Verification

- `npm run test:types`：passed。
- `.venv-graphrag/bin/python test/python/test_graphrag_bridge_scope.py`：passed。
- `node ./node_modules/vitest/vitest.mjs run test/unified-query.test.ts test/cli-graphrag-route.test.ts test/integrations/graphrag-cost.test.ts --testTimeout 60000 --reporter=dot`：passed。
- `node ./node_modules/vitest/vitest.mjs run test/book-job-state.test.ts test/graphrag-book-state.test.ts test/integrations/contracts.test.ts --testTimeout 120000 --reporter=dot`：passed。
- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testTimeout 120000 --reporter=dot`：passed。
- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testNamePattern 'stale remote running|fresh remote running|orphaned running|stale provider wait' --testTimeout 120000 --reporter=dot`：passed。

## Final Decision

PASS.

本轮固定基准审计已通过。可以进入分批提交，并继续真实 EPUB 闭环处理。
