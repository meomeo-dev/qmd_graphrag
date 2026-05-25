# GraphRAG Settings Projection Re-Audit 3 - Agent C

Result: PASS

## 结论

当前未提交实现已修复 `dev-agent-c/reaudit-2.md` 中的审计问题。未发现需
标记为 FAIL 的 `file:line` finding。

## 验证证据

- `scripts/graphrag/batch-epub-workflow.mjs:810` 增加本地
  settings projection source config 预检（local preflight）。它覆盖
  OpenAI Responses 端点、stream、strict structured output、
  `providers.jina.embedding_profile` 与 `graphrag.concurrent_requests`。
- `scripts/graphrag/batch-epub-workflow.mjs:871` 在
  `resume-book-*` 与 `repair-local-artifact-gate-*` 命令失败时，基于当前
  `--config` 指向的配置重新加载并执行本地预检，而不是只依赖 stderr 文本。
- `scripts/graphrag/batch-epub-workflow.mjs:846` 对本地预检失败稳定写入
  `settingsProjectionDecision: "rejected_invalid_source"`、
  `settingsProjectionRewritten: false`、source fingerprint、project config
  locator、settings locator、evidence locator 与 reason。
- `scripts/graphrag/batch-epub-workflow.mjs:783` 对不可解析 YAML 使用源
  字节 hash 构造 fallback fingerprint，避免 syntactically invalid
  `.qmd/index.yml` 丢失 source fingerprint observability。
- `scripts/graphrag/batch-epub-workflow.mjs:3422` 将 settings projection
  rejection metadata 写入 `command_failed` event。
- `scripts/graphrag/batch-epub-workflow.mjs:4754` 与
  `scripts/graphrag/batch-epub-workflow.mjs:4800` 将同一 metadata 写入最终
  failed checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:4820` 将同一 metadata 写入
  `item_failed` event；`scripts/graphrag/batch-epub-workflow.mjs:3040` 将
  checkpoint metadata 投影到 recovery summary。
- `src/graphrag/settings-projection.ts:88` 读取 Jina embedding profile 后，
  `src/graphrag/settings-projection.ts:90` 显式拒绝未知 profile。因此
  `providers.jina.embedding_profile: audio` 不再落入后续
  `profile.queryTask` 的泛化 TypeError。
- `test/graphrag-book-state.test.ts:259` 固定未知 Jina embedding profile
  的构造器拒绝行为。
- `test/cli.test.ts:4682` 固定 invalid source settings projection
  observability。该测试用 `embedding_profile: audio` 和旧式
  `TypeError: Cannot read properties of undefined (reading 'queryTask')`
  作为 fake resume stderr，断言 batch runner 仍从本地 config 预检得出
  `rejected_invalid_source`，并写入 checkpoint、event 与 summary。

## 聚焦测试

- PASS:
  `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts -t "rejects unknown Jina embedding profiles before projection"`
- PASS:
  `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "invalid source settings projection rejection is observable"`

## 残余风险

- 本次复审限定在固定基准与 `reaudit-2.md` 指出的问题，未扩大审计到无关
  configuration surfaces。
- batch runner 的本地预检逻辑与 projection 构造器存在重复规则
  （duplicated rules）。当前风险已由测试覆盖；未来若新增 projection source
  约束，需要同步更新 batch preflight 或抽取共享校验以避免规则漂移。
- 未运行全量测试套件；仅运行了与本次风险直接相关的两个聚焦 Vitest 用例。
