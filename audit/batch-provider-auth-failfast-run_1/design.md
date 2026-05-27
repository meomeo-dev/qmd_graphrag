# Batch Provider Auth Fail-Fast Design

## Problem

真实批处理 `epub-batch-20260527-after-bridge-projection-fix` 验证了
GraphRAG bridge projection 修复已越过原 `capabilityScope references unknown
or not-ready graphCapabilityId(s)` 问题，但随后在已 `query_ready` 的图书查询
阶段收到 provider 认证错误：

`Error code: 401 - {'code': 'INVALID_API_KEY', 'message': 'Invalid API key'}`

该错误被正确分类为 permanent provider failure，checkpoint 中记录：

- `failureKind: permanent`
- `retryable: false`
- `providerStatusCode: 401`
- `recoveryDecision: stop_until_fixed`

但 batch runner 当前只在 `data_compatibility` failure 上停批：
`shouldStopBatchAfterFailure()` 要求
`checkpointHasDataCompatibilityFailure(checkpoint)` 为 true。因此 runner 在 401
后仍继续启动下一本书，导致无效凭据场景下继续消耗请求并制造更多失败状态。

## Invariants

1. Provider auth/config permanent 4xx failure 不可通过重试或处理下一本书恢复。
2. 401、403、invalid api key、unauthorized、forbidden、authentication 等错误应
   停止当前 batch runner，避免继续打无效请求。
3. 429 和 5xx 仍是 transient provider failure，继续使用既有 retry budget 和
   provider recovery wait 机制。
4. 一般 400、409 等 4xx 仍可按单书永久失败处理，不在本设计中扩大为全局停批。
5. 本变更不修改 GraphRAG bridge projection、artifact gate、query_ready
   lineage、qmd/GraphRAG build 状态或输出渲染。
6. 停批状态必须可观测：status JSON、events 和 recovery summary 应显示
   `stop_until_fixed`，并保留 provider status code。
7. 已失败的 auth item 不得触发 local artifact gate repair。
8. 新 runner 在同一 run id 上看到已有 auth stop checkpoint 时，必须在处理
   下一本书前停止。
9. 修复不得提交 `graph_vault`、`.qmd`、`inbox` 或 `/tmp` 运行产物。
10. 真实跑恢复前必须先由用户修复外部 API key/proxy 凭据。

## Proposed Change

在 `scripts/graphrag/batch-epub-workflow.mjs` 中引入不可恢复 provider auth
failure 判定：

- 从 checkpoint 和 failed command checks 中读取 provider status code。
- 对 401 和 403 判定为 global stop。
- 对错误文本中包含 `invalid api key`、`invalid_api_key`、`unauthorized`、
  `forbidden`、`authentication`、`auth` 等认证/授权语义时判定为 global stop。
- `shouldStopBatchAfterFailure()` 变为：
  - data compatibility failure 停批。
  - unrecoverable provider auth/config failure 停批。
  - 其他 permanent item failure 不改变当前策略。

保持 `classifyFailure()` 的已有 retryable 类型不变。该函数继续把 4xx 分为
permanent、429 分为 transient、5xx 分为 transient。本设计只改变 batch runner
是否继续处理后续图书。

## Tests

新增或调整 Node CLI tests：

1. 真实运行中命令失败为 provider 401 时，runner 写入 `item_failed` 后必须写入
   `batch_stopped_after_non_transient_failure`，且不能启动后续 item。
2. status-json 对既有 401 failed checkpoint 应显示 `recoveryDecision:
   stop_until_fixed`、`providerStatusCode: 401`，且不得显示 provider recovery wait。
3. 429/5xx transient provider failure 的既有 retry tests 仍通过。
4. 现有 data compatibility stop tests 仍通过。
5. mixed provider failure and local projection text 测试继续证明 401 不进入
   local artifact repair。

验证命令：

- `npm run test:node -- test/cli.test.ts -t "provider"`
- `npm run test:node -- test/cli.test.ts -t "non-transient"`
- `npm run typecheck`
- `git diff --check`

## Non-Goals

1. 不修复用户或代理服务的 API key。
2. 不把 401/403 改为 transient。
3. 不改变 GraphRAG 构建或查询的 artifact validation。
4. 不改变并发、token、LLM proxy 或配置模板。
5. 不恢复或改写已生成的 batch 运行产物。
