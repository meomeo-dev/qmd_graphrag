# GraphRAG Responses Output None Recovery 设计审计

## 结论

当前 `docs/design` 与 `docs/operations` 没有充分覆盖 OpenAI Responses
provider/SDK 返回 malformed 或 empty response 的恢复分类。现有设计可覆盖
network/HTTP transient、partial output、provider auth、data compatibility、
local artifact gate 和 producer lineage repair，但没有把 `response.output=None`
这类 provider 边界完整性失败（provider response integrity failure）纳入
书级状态机（book job state machine）和批量恢复契约。

架构层已经出现 `provider_response_invalid` typed error code，但它主要落在
query/retrieval execution code 语境，未被回填到 EPUB batch 的 GraphRAG
`extract_graph` producer stage 恢复路径。因此当前真实失败会从 Python
`TypeError: 'NoneType' object is not iterable` 下沉为 `unknown`、
`retryable=false`、`recoveryDecision=stop_until_fixed`，这是设计缺口。

建议把本次失败优先定义为 transient provider response integrity failure，
而不是 SDK compatibility bug。只有在有证据证明 SDK shape 或本地 wrapper
实现与有效 provider 响应不兼容时，才升级为
`provider_sdk_compatibility`/implementation compatibility 并保持
`stop_until_fixed`。

## Blocking Findings

### BF-1：书级恢复分类缺少 provider response integrity 类型

`docs/design/job-state/book-job-state.md` 的恢复分类只列出：
`provider transient`、`orphan running`、`partial output`、
`repairable projection`、`repairable producer lineage`、`rebuild required`
和 `permanent integrity error`。其中 `provider transient` 明确覆盖网络、
HTTP 429/5xx、timeout 和 provider unavailable，但未覆盖 provider 已返回
terminal/completed 对象而必需输出字段为空、缺失或不可解析的场景。

影响：`response.output=None` 没有稳定落点，容易被泛化为 `unknown` 或
误归入 SDK bug、data compatibility、local artifact gate。

### BF-2：批量 runbook 的 transient 列表未覆盖 invalid/empty payload

`docs/operations/graphrag-epub-batch-runbook.md` 的 transient 列表包含
concurrency、rate limit、timeout、HTTP 429/5xx、structured GraphRAG query
provider unavailable，以及 Jina/OpenAI/httpx/aiohttp/urllib3 连接类错误。
它没有列出 `provider_response_invalid`、`response.output=null`、empty
Responses output、malformed structured response 或 stream completed without
text 等 provider payload integrity 失败。

影响：操作者只能看到 `stop_until_fixed`，无法按同一 `runId` 的 provider
recovery wait 语义恢复当前 `graph_extract` stage。

### BF-3：`provider_response_invalid` 已存在但未接入 batch state machine

`docs/architecture/unified-retrieval-plane.md` 与
`docs/architecture/unified-retrieval-plane.type-dd.yaml` 已把
`provider_response_invalid` 定义为 GraphRAG execution error code。但是
Type DD 的 transient failure policy 仍偏向 transport/stream/network
错误，未明确包括 terminal response object 违反最小输出契约的情况。

影响：架构 code 名称与书级状态机、batch runbook、status JSON 观测面之间
没有闭环，开发实现缺少固定目标。

### BF-4：当前没有安全边界防止 broad TypeError matcher 掩盖真实错误

如果实现只匹配 `"'NoneType' object is not iterable"`，会把 GraphRAG 内部
data compatibility、local artifact gate、SDK compatibility 或普通代码 bug
误判为 provider transient。设计必须要求 Python Responses adapter 在 provider
边界先把 invalid response 转换为稳定、脱敏、typed error；legacy TypeError
只能在有 Responses adapter 证据时窄域重分类。

影响：错误分类可能绕过 `stop_until_fixed`，并在高成本 stage 上重复消费
provider budget 或污染输出目录。

### BF-5：验收标准没有固定 artifact gate 与 retry observability

现有文档没有规定 `response.output=None` 后必须保持哪些 producer checkpoint
不发布、哪些状态字段必须出现在 item checkpoint/status JSON/recovery summary、
以及重试前如何处理失败尝试留下的 stage-owned residual output。

影响：实现可能只修 classifier，使 batch 继续跑，但无法证明没有发布半成品
GraphRAG artifact、producer manifest 或 query capability。

## 建议设计

### 类型命名

建议采用以下命名，尽量复用既有 `failureKind`，避免无必要 schema 扩张：

| 概念 | 建议名称 | 用途 |
| --- | --- | --- |
| provider payload 完整性失败 | `provider_response_integrity` | recovery taxonomy/category |
| typed execution code | `provider_response_invalid` | 复用既有 GraphRAG execution error code |
| status/reason 字段 | `providerRecoveryReason=provider_response_integrity` | status JSON 与 recovery summary |
| SDK/adapter 兼容 bug | `provider_sdk_compatibility` | non-transient implementation code |

`provider_response_integrity` 的定义：

- Provider/SDK 调用已到达 terminal success/completed 或等价结束状态。
- 响应违反最小输出契约（minimum output contract），例如
  `response.output` 为 null/None、输出数组为空、没有可用 output text、
  stream completed without text、strict structured response 无有效 JSON 文本。
- 没有更强永久证据，例如 HTTP 401/403、非 429 的 HTTP 4xx、
  provider-not-configured、明确 SDK interface mismatch、GraphRAG data
  compatibility、混书 artifact 或 local projection gate。

### 状态机语义

对当前 `extract_graph` 场景，目标状态应为：

```yaml
stage: graph_extract
graphWorkflow: extract_graph
providerErrorCode: provider_response_invalid
providerRecoveryReason: provider_response_integrity
failureKind: transient
retryable: true
recoveryDecision: retry_same_run_id
retryExhausted: false
```

批量 item 在预算内应保持 `pending` 或可自动恢复状态，并带
`nextRetryAt`、`retryDelaySeconds`、`retryBudgetSeconds`。若进入 provider
recovery wait，则写入 `waitingForProviderRecovery=true`，同一 `runId` 在
`nextRetryAt` 后恢复。不得写入 `completed`。

书级 stage checkpoint 可以记录本次 attempt 失败，但不得发布
`graph_extract` succeeded checkpoint、artifact manifest、producer manifest、
`query_ready` 或 graph capability。`BookResumePlan.nextStage` 必须仍指向
`graph_extract`，前序已成功 stage 保持可复用。

如果后续证据证明是 SDK compatibility bug，状态应改为：

```yaml
providerRecoveryReason: provider_sdk_compatibility
failureKind: permanent
retryable: false
recoveryDecision: stop_until_fixed
```

不要把 SDK compatibility bug 归入 `data_compatibility`。`data_compatibility`
应继续只表示 GraphRAG 已执行后暴露出的确定性数据 shape 兼容问题。

### 文档补充位置

应至少补充以下文档：

1. `docs/design/job-state/book-job-state.md`

   在“恢复分类”中新增 `provider response integrity`。说明它是 provider
   boundary 的 transient subtype，使用 `provider_response_invalid` code、
   `retry_same_run_id`、不发布当前 stage artifact，并且和 SDK compatibility
   bug 区分。

2. `docs/operations/graphrag-epub-batch-runbook.md`

   在“Provider 限流与重试”和“常见故障分流”中加入
   `response.output=null`/empty/malformed Responses output 的操作规则、
   status JSON 期望字段、同一 runId 续跑规则、负例边界。

3. `docs/operations/graphrag-epub-resume-boost.md`

   加入快速分流条目：provider response integrity failure 不新建 runId，
   不手改 checkpoint，不删除 book output，通过同一 runId 重试当前 stage。

4. `docs/architecture/unified-retrieval-plane.type-dd.yaml`

   在 `failure_kind_contract.transient` 与 `transient_failure_policy` 中明确
   terminal provider response invalid/empty payload 属于 retryable transient，
   并要求与 auth、data compatibility、local artifact gate 负例分开。

5. `docs/records/graphrag/2026-05-21-responses-api-streaming-transport.yaml`

   补充 Responses adapter 最小输出契约：完成事件或 completed payload 后必须
   得到非空 output text/structured text；否则抛出 typed、sanitized
   `provider_response_invalid`，不能让 raw Python `TypeError` 泄漏到 batch
   classifier。

可选新增结构化状态机文件：

```text
docs/design/state-machine/recovery-taxonomy.yaml
```

该文件可作为 machine-readable policy，枚举 `provider_response_integrity`、
`provider_auth`、`partial_output`、`data_compatibility`、`local_artifact_gate`、
`provider_sdk_compatibility` 的判定条件、状态字段和禁止转换。

### 与既有类别的区分

| 类别 | 判定证据 | 状态/动作 | 与本次失败的边界 |
| --- | --- | --- | --- |
| provider response integrity | completed/terminal provider response 缺少必需 output | transient，same runId retry | 本次推荐分类 |
| partial output early-stop | stage report 追加片段出现 community report partial-output 信号 | transient，当前 stage 重跑，清理 stage-owned residual output | 依赖 GraphRAG stage report，不是 SDK response field |
| provider auth | HTTP 401/403、INVALID_API_KEY、unauthorized、forbidden、provider not configured | permanent stop，配置变化后 bounded reopen | 本次无 auth/status 证据时不得归入 |
| data compatibility | GraphRAG 已对本地数据执行后出现确定性 data-shape incompatibility | `data_compatibility`，stop until code/data patch | `response.output=None` 发生在 provider boundary，不是 corpus/artifact shape |
| local artifact gate | producer lineage、manifest、identity、capability、settings projection 缺失或漂移 | repair-only 或 rebuild required | 本次不应修 catalog，也不应发布 capability |
| SDK compatibility bug | SDK/API shape 已变化，adapter 对有效 response 的读取逻辑错误 | permanent/implementation stop | 需独立证据，不能仅凭一次 empty output 推断 |

## 固定验收标准

### 文档验收

- `docs/design/job-state/book-job-state.md` 明确包含
  `provider response integrity` 分类、状态字段、禁止 artifact promotion 规则。
- `docs/operations/graphrag-epub-batch-runbook.md` 明确列出
  `provider_response_invalid`、`response.output=null`、empty output、malformed
  Responses payload 的恢复动作。
- Type DD 中 `provider_response_invalid` 与 batch transient retry policy
  建立显式链接。
- 文档包含与 provider auth、partial output、data compatibility、local artifact
  gate、SDK compatibility bug 的负例边界。

### Adapter 与分类验收

- Python Responses adapter 在迭代 `response.output` 前校验最小输出契约。
- `response.output is None`、缺失 output、empty output、stream completed
  without text 均抛出稳定前缀的 typed sanitized error，例如：
  `OpenAI Responses provider invalid response: response.output is null`。
- error metadata 只包含脱敏字段：provider、code、stage、workflow、
  terminal status、missing field、model/config fingerprint locator 等。
  不得包含 raw provider request body、raw response body、API key、Bearer token、
  `.env` 值或 URL credential。
- Batch classifier 将该 typed error 映射为：
  `failureKind=transient`、`retryable=true`、
  `recoveryDecision=retry_same_run_id`。
- Legacy 当前失败只能在同时具备 `openai_responses`/Responses adapter 证据、
  `graphWorkflow=extract_graph`、`response.output` null/None 证据时重分类。
  单独匹配 `NoneType object is not iterable` 不合格。

### 状态机验收

- 当前 stage 不发布 succeeded checkpoint、artifact manifest、producer manifest、
  `query_ready` 或 graph capability。
- `BookResumePlan.nextStage` 保持为 `graph_extract`，同一 `runId` 重试当前
  high-cost stage；已成功前序 stage 不重跑。
- 失败尝试留下的 stage-owned residual output 必须在下一次 retry 前清理或通过
  attempt-scoped output 隔离，不能被 artifact gate adoption。
- status JSON、item checkpoint、events.jsonl 和 `recovery-summary.json`
  投影同一事实：
  `providerErrorCode=provider_response_invalid`、
  `providerRecoveryReason=provider_response_integrity`、
  `failureKind=transient`、`retryable=true`、
  `recoveryDecision=retry_same_run_id`、`nextRetryAt`。
- provider recovery wait limit 达到后，batch 可为 `incomplete`，但 item 仍保持
  pending/retryable，同一 `runId` 在 `nextRetryAt` 后恢复。

### 负例验收

- HTTP 401/403、INVALID_API_KEY、unauthorized、forbidden 不得归入
  `provider_response_integrity`，仍走 provider auth stop/reopen 规则。
- 非 429 的 HTTP 4xx 不得自动 retry。
- provider-not-configured 不得进入 provider recovery wait。
- GraphRAG orphan text-unit/context 等确定性 data-shape TypeError 仍为
  `data_compatibility`，不被 `NoneType` broad matcher 吞掉。
- GraphRAG document identity missing、capability scope unknown、settings
  projection drift 仍走 local artifact gate repair，不进入 provider wait。
- mixed-book output、source/content mismatch、fingerprint mismatch、
  stale sidecar、missing producer lineage 仍 fail-closed。
- 已证明的 SDK compatibility bug 使用 `provider_sdk_compatibility` 或等价
  implementation code，`retryable=false`、`stop_until_fixed`。

### 回归测试验收

- 新增 focused regression 覆盖真实失败文本：
  `GraphRAG index workflow failed: extract_graph error "'NoneType' object is not iterable"`，
  并验证只有带 Responses adapter invalid-response 证据时才重分类。
- 新增 adapter unit test 覆盖 `response.output=None` 和 empty output。
- 新增 batch classifier/status hydration test，验证 persisted
  `unknown + stop_until_fixed` 可被当前 classifier 投影为 transient pending。
- 新增 negative tests 覆盖 provider auth、non-429 4xx、provider-not-configured、
  data compatibility TypeError、local artifact gate、SDK compatibility bug。
- 新增 artifact gate regression，验证本次 transient retry 不发布半成品
  GraphRAG artifacts，且 retry 前不会采用失败尝试 residual output。

### 真实批次验收

- 对 `epub-batch-20260527-real-resume-1` 执行只读 `--status-json` 时，目标
  item 不再显示 `failureKind=unknown`、`retryable=false`、
  `recoveryDecision=stop_until_fixed`。
- 写入续跑使用同一 `runId`，不得新建 runId、手改 checkpoint、删除整本书
  book-scoped output 或跳过闭环检查。
- 目标书最终只有在 qmd build、GraphRAG build、GraphRAG query 和 27 个固定
  command checks 全部通过后，才可写入 `completed`。
