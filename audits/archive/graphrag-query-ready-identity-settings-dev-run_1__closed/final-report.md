# GraphRAG Query-Ready Identity Settings Development Audit

Result: PASS

## Scope

本轮审计覆盖 GraphRAG 产物隔离、`query_ready` 阶段门控、
managed settings projection、per-book recovery state，以及 batch runner
在上游网络或 provider 波动后的 typed recovery observability。

固定审计基准位于：

- `dev-agent-a/baseline.md`
- `dev-agent-b/baseline.md`
- `dev-agent-c/baseline.md`

通过报告为：

- `dev-agent-a/reaudit-2.md`
- `dev-agent-b/reaudit-2.md`
- `dev-agent-c/reaudit-3.md`

## Decision

三个固定基准审计代理均已通过。前序失败项已修复：

- repair-only classifier 覆盖四条 observed `query_ready` local gate failure。
- persisted `stop_until_fixed` local gate 可进入 repair/reopen。
- repair/rejection metadata 不再被 schema strip，并投影到 checkpoint、event、
  recovery summary。
- user-owned `settings.yaml` fail-closed，managed drift 只重写 managed 文件。
- invalid source config 在 resume/repair settings projection 命令中稳定 typed 为
  `rejected_invalid_source`。
- 未知 Jina embedding profile 显式拒绝，不再退化为泛化 TypeError。

## Verification

已通过的验证命令：

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts -t "managed GraphRAG settings writer refuses|sync managed GraphRAG settings writer refuses|rewrites drifted managed|rewrites managed GraphRAG settings|rejects user-owned|normalizedPath mismatches|rejects unknown Jina embedding profiles"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts`
- `npm run test:types`
- `npm run build`
- `git diff --check`

Residual risk: 本报告确认开发审计门禁通过；真实 23 本 EPUB batch runner 仍在运行中，
其最终状态应由后续 batch status 与 per-book command checks 判定。
