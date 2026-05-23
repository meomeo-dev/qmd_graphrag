# DSPy 集成研究报告

状态：superseded。当前准生产规范以 `dspy-integration-plan-v10.md` 为准；
本文仅保留为迭代记录，不构成当前实现契约。

## 结论

DSPy 在 qmd_graphrag 中的职责应限定为离线查询扩展策略优化
（offline query expansion policy optimization）。它不应成为 `qmd query`
每次请求的实时依赖，也不应替代 Type DD / JSON Schema 的硬校验。

推荐目标形态：

```text
qmd eval dataset
  -> DSPy query expansion program
  -> GEPA optimization
  -> versioned optimization artifact
  -> evaluation and promotion gate
  -> qmd query consumes promoted expansion policy
```

当前仓库已有 DSPy contract、runtime bridge 和 GEPA 脚本，但还没有用户可调用的
`qmd` 子命令，也没有让线上 `qmd query` 自动消费优化产物。当前状态应视为
“typed offline bridge 已存在，产品化闭环未完成”。

## 证据基线

- DSPy 使用 Signature、Module、LM、Example、trainset 和 optimizer 组织 LM
  程序，适合把 query expansion 建模为显式模块，而不是自由拼接 prompt。
- GEPA 是反思式 prompt optimizer，适合用 score 和 textual feedback 优化查询
  扩展策略。
- DSPy 的 Signature 是软接口，不等于生产级 schema enforcement；线上仍必须
  使用 Type DD schema、validator、retry 和 dead-letter 机制。
- qmd_graphrag 本地已有 `DspyQueryPromptOptimizationRequestSchema`、
  `optimizeQueryPrompt()`、Python bridge 和 `dspy_gepa.py`，但 CLI 与线上 query
  消费路径缺失。

## 集成边界

### 离线优化边界

离线优化只负责产生、评估和推广查询扩展策略。

输入：

- frozen corpus snapshot。
- frozen qmd index snapshot。
- train / validation / test query set。
- gold evidence ids 或 expected retrieval behavior。
- metric version。
- provider/model configuration fingerprint。

输出：

- optimized DSPy program artifact。
- generated expansion records。
- evaluation report。
- promotion decision。

### 在线查询边界

在线 `qmd query` 不运行 GEPA。在线路径只加载已推广的策略 artifact，并把输出
解析为 `QueryExpansionItemSchema`：

```text
user query
  -> promoted query expansion policy
  -> QueryExpansionItem[]
  -> qmd lexical/vector/rerank retrieval
```

若 artifact 缺失、失效或 schema 校验失败，系统按配置选择：

- `fallback_to_builtin_expander`：使用现有 `LlamaCpp.expandQuery()`。
- `strict_refuse`：返回 typed query error。

## 推荐 Type DD 扩展

本节列出的 schema 均为拟议 schema（proposed schema），不是当前已实现代码。
实现时必须以这些名称或等价迁移记录更新 Type DD 与 catalog。

应新增或补强以下拟议 schema，而不是把 DSPy 输出作为裸文件路径传递：

- `DspyOptimizationRunSchema`
- `DspyOptimizationArtifactSchema`
- `DspyExpansionPolicySchema`
- `DspyPolicyPointerSchema`
- `DspyEvaluationDatasetSchema`
- `DspyEvaluationReportSchema`
- `DspyPromotionDecisionSchema`
- `DspyPromotionHistoryEntrySchema`
- `DspyQueryExpansionProgramInputSchema`
- `DspyQueryExpansionProgramOutputSchema`
- `DspyMetricSpecSchema`
- `CorpusSnapshotRefSchema`
- `QmdIndexSnapshotRefSchema`
- `QueryExpansionFailurePolicySchema`
- `VaultRelativePathSchema`
- `EnvVarNameSchema`
- `RedactedTextSchema`

关键字段：

- `artifactId`
- `optimizer`
- `programName`
- `signatureVersion`
- `promptArtifactPath`
- `compiledProgramPath`
- `generatedExpansionPath`
- `corpusSnapshotId`
- `qmdIndexSnapshotId`
- `retrievalConfigFingerprint`
- `providerFingerprint`
- `metricVersion`
- `trainsetHash`
- `valsetHash`
- `testsetHash`
- `schemaVersion`
- `promotionStatus`
- `modelFingerprint`
- `corpusSnapshotFingerprint`
- `indexSnapshotFingerprint`
- `retrieverFingerprint`
- `rerankerFingerprint`
- `schemaFingerprint`
- `seed`
- `logDir`
- `runDir`
- `maxMetricCalls`
- `maxTotalTokens`
- `maxPromptTokens`
- `maxExpansionItems`

线上只允许消费 active pointer 指向的 promoted decision。decision 引用的 artifact
必须是不可变、可推广、可校验的 offline artifact；artifact 的
`promotionStatus` 保留产物写入时状态，不作为线上开关。

边界定义：

- `DspyOptimizationRunSchema` 是一次优化执行记录，可变直到 terminal state。
- `DspyOptimizationArtifactSchema` 是不可变产物，保存 compiled program、prompt
  artifact、日志目录、数据集 hash 和 fingerprint。
- `DspyEvaluationReportSchema` 是不可变评估报告，引用 artifact 和 dataset。
- `DspyPromotionDecisionSchema` 是不可变决策记录，引用 artifact、report 和 previous
  pointer state；它只承载 gate verdict 与 lineage，不记录 pointer transition event。
- `DspyPromotionHistoryEntrySchema` 是 append-only pointer transition event；它只记录
  `pointerBefore`、`pointerAfter`、`decisionId`、actor、time 和 recovery marker，不拥有
  artifact、report、policy 或 gate verdict 内容。
- `DspyPolicyPointerSchema` 是唯一可变线上指针，指向当前 promoted decision。
- `DspyExpansionPolicySchema` 是由 pointer + decision + artifact 投影出的只读
  runtime policy，不复制 prompt 正文。

配置只能引用 `DspyPolicyPointerSchema`。不可把不可变 artifact 路径误当成 active
policy pointer。

`DspyQueryExpansionProgramInputSchema` 必须包含用户 query、可选 intent、可选
conversation context、policy id、runtime fingerprint set。`DspyQueryExpansionProgramOutputSchema`
必须只包含 `QueryExpansionItemSchema[]`。policy id、artifact id、validation
metadata 进入 query trace sidecar，不进入 online query expansion bus。GEPA
textual feedback、reflection trace、candidate lineage 只属于离线
`DspyEvaluationReportSchema`，不得进入 online query expansion bus。

`QueryExpansionFailurePolicySchema` 必须显式覆盖：

| failure reason | fallback mode | strict mode |
| --- | --- | --- |
| `pointer_missing` | `fallback_to_builtin_expander` | `fallback_to_builtin_expander` |
| `decision_missing` | `fallback_to_builtin_expander` | `fallback_to_builtin_expander` |
| `policy_unavailable` | `fallback_to_builtin_expander` | `fallback_to_builtin_expander` |
| `artifact_missing` | `fallback_to_builtin_expander` | `strict_refuse` |
| `artifact_stale` | `fallback_to_builtin_expander` | `strict_refuse` |
| `schema_invalid` | `fallback_to_builtin_expander` | `strict_refuse` |
| `runtime_error` | `fallback_to_builtin_expander` | `strict_refuse` |

默认值为 `fallback_to_builtin_expander`。`strict_refuse` 返回 typed query error。
`strict_schema: true` 只表示必须执行 schema validation；失败后的行为由
`QueryExpansionFailurePolicySchema` 决定。

stale 判定规则：

```text
isStale =
  current.modelFingerprint != policy.modelFingerprint ||
  current.providerFingerprint != policy.providerFingerprint ||
  current.retrievalConfigFingerprint != policy.retrievalConfigFingerprint ||
  current.corpusSnapshotFingerprint != policy.corpusSnapshotFingerprint ||
  current.indexSnapshotFingerprint != policy.indexSnapshotFingerprint ||
  current.retrieverFingerprint != policy.retrieverFingerprint ||
  current.rerankerFingerprint != policy.rerankerFingerprint ||
  current.schemaFingerprint != policy.schemaFingerprint
```

所有 fingerprint 比较都是规范化字符串全等比较。`providerFingerprint` 覆盖 provider
endpoint、model provider、secret env name、reasoning settings、stream/structured
output settings。`retrievalConfigFingerprint` 覆盖 top-k、chunk strategy、BM25/vector
weight、rerank model 和 threshold。

producer / consumer 对照：

| payload | writer | reader | storage | mutation authority |
| --- | --- | --- | --- | --- |
| `DspyOptimizationRunSchema` | optimize typed service | evaluate, audit | graph_vault/dspy/runs | optimize only |
| `DspyOptimizationArtifactSchema` | optimize typed service | evaluate, promote | graph_vault/dspy/artifacts | immutable |
| `DspyEvaluationReportSchema` | evaluate typed service | promote, audit | graph_vault/dspy/reports | immutable |
| `DspyPromotionDecisionSchema` | promote typed service | pointer loader, audit | graph_vault/dspy/promotions | immutable |
| `DspyPromotionHistoryEntrySchema` | promote/rollback/disable typed service | audit | graph_vault/dspy/history | append only |
| `DspyPolicyPointerSchema` | promote/rollback/disable typed service | qmd query loader | graph_vault/dspy/policies/current.yaml | single writer |
| `DspyQueryExpansionProgramInputSchema` | qmd query | DSPy expansion runtime service | transient | qmd query |
| `DspyQueryExpansionProgramOutputSchema` | DSPy expansion runtime service | qmd query | transient | runtime service |
| `QueryExpansionFailurePolicySchema` | config loader | qmd query | .qmd/index.yml | config loader |

`VaultRelativePathSchema` is used by every persisted path field. `EnvVarNameSchema`
is used by every secret reference. `RedactedTextSchema` is used by bridge
stdout/stderr, error messages, logs, and report diagnostic text.

`DspyPromotionDecisionSchema` required lineage fields:

- `decisionId`
- `artifactId`
- `artifactHash`
- `reportId`
- `reportHash`
- `previousDecisionId`
- `previousPointerState`
- `pointerBefore`
- `pointerAfter`
- `historyEntryId`
- `decisionReason`
- `promotionStatus`

`previousPointerState` 必须覆盖 `builtin`、`disabled`、`missing` 和 `promoted`。
`pointerBefore` 与 `pointerAfter` 使用 `DspyPolicyPointerSchema` 的 canonical
projection 或明确的 null-state projection，保证 builtin / disabled / null 状态也可审计。

## CLI 设计

建议新增 `qmd dspy` 命令组。

```text
qmd dspy optimize-query-prompt
  --program <program-id-or-version>
  --metric <metric-id-or-version>
  --trainset <path>
  --valset <path>
  --testset <path>
  --model <provider/model>
  --reflection-model <provider/model>
  --auto light|medium|heavy
  --max-metric-calls <n>
  --max-total-tokens <n>
  --seed <n>
  --log-dir <vault-relative-path>
  --run-dir <vault-relative-path>
  --save-artifact <vault-relative-path>
```

职责：

- 构造 `DspyQueryPromptOptimizationRequest`。
- 调用 `createQmdGraphRagRuntime().optimizeQueryPrompt()`。
- 写入 `DspyOptimizationRun` 与 `DspyOptimizationArtifact`。
- 失败可按 `runId`、`runDir`、input hash 和 provider fingerprint 幂等恢复。
- 失败不得修改 active expansion policy pointer。
- `--testset` 是 acceptance testset，只能由 final acceptance 使用，不参与 optimizer
  update 或 candidate selection。

```text
qmd dspy evaluate-expansion-policy
  --artifact <path>
  --dataset <path>
  --index <path>
  --report <path>
```

职责：

- 运行 frozen eval。
- 计算 Recall@k、MRR、nDCG、schema validity、cost、latency。
- 产出 `DspyEvaluationReport`。
- evaluation 只读取 artifact 和 frozen snapshot，不更新 active pointer。

```text
qmd dspy promote-expansion-policy
  --artifact <path>
  --report <path>
  --min-recall-at-k <n>
  --max-cost-class <class>
```

职责：

- 校验 evaluation gate。
- 写入 `DspyPromotionDecision`。
- 更新 qmd config 中的 active expansion policy pointer。
- 保存 previous pointer 到 promotion history。

```text
qmd dspy rollback-expansion-policy
  --to <promotion-decision-id>

qmd dspy disable-expansion-policy
```

`rollback` 将 active pointer 恢复到历史 promotion decision。`disable` 清空 active
policy pointer，并使 `qmd query` 回到内置 expansion 默认行为。

所有命令都必须走 typed service。不得在 CLI 中新增裸 `subprocess` 旁路。

## 配置设计

`.qmd/index.yml` 应持有策略指针，不直接嵌入 prompt 正文。

```yaml
query:
  expansion_policy:
    provider: dspy
    policy_ref: graph_vault/dspy/policies/query-expansion/current.yaml
    failure_policy: fallback_to_builtin_expander
    strict_schema: true
```

artifact 路径必须 portable / vault-relative。secret 只允许通过 env name 引用。
配置不得直接嵌入 prompt 正文。未启用 promoted policy 时，默认行为保持为现有
`LlamaCpp.expandQuery()`。

模式矩阵：

| `failure_policy` | `strict_schema` | artifact failure | schema failure |
| --- | --- | --- | --- |
| `fallback_to_builtin_expander` | true | builtin expansion | builtin expansion |
| `strict_refuse` | true | typed query error | typed query error |
| `fallback_to_builtin_expander` | false | builtin expansion | invalid configuration |
| `strict_refuse` | false | typed query error | invalid configuration |

Disabled state:

```yaml
query:
  expansion_policy:
    provider: builtin
```

Disabled or missing `expansion_policy` means current qmd behavior is unchanged.

## Evaluation Metric

GEPA metric 不应只返回标量。建议返回：

```json
{
  "score": 0.82,
  "feedback": "missed document doc-3; query too broad; lex term repeated original query",
  "retrieval": {
    "recallAtK": 0.8,
    "mrr": 0.67,
    "ndcg": 0.72
  },
  "schema": {
    "valid": true,
    "invalidItemCount": 0
  },
  "cost": {
    "promptTokens": 900,
    "completionTokens": 120,
    "estimatedCostClass": "low"
  },
  "latency": {
    "p95Ms": 1200
  }
}
```

metric 需要覆盖：

- gold evidence recall。
- irrelevant candidate penalty。
- lex / vec / hyde item balance。
- duplicated query penalty。
- schema validity。
- cost and latency budget。
- prompt token length and expansion item count.

Anti-overfitting gate:

- trainset is used for optimizer updates.
- valset is used for candidate selection and promotion threshold tuning.
- testset is used only once for final acceptance.
- `valsetHash == trainsetHash` is rejected unless request mode is explicitly
  `batch_search_only`.
- `testsetHash == trainsetHash` is rejected.
- `testsetHash == valsetHash` is rejected.
- `testsetUsedAt` is recorded after final acceptance. A second use of the same
  testset for the same artifact family fails promotion.
- prompt artifacts exceeding `maxPromptTokens` are rejected or penalized.
- expansion output exceeding `maxExpansionItems` is rejected before retrieval.
- `batch_search_only` artifacts are `non_promotable` and cannot produce
  `DspyExpansionPolicySchema` or `DspyPolicyPointerSchema`.

Runtime policy loading:

- evaluation and online runtime load the active pointer, promoted decision,
  and runtime projection before reading expansion records.
- `generatedExpansionPath` is the current online runtime projection.
- prompt artifact and compiled program are diagnostic and offline integrity
  material, not the primary online expansion record source.
- missing runtime projection, hash mismatch, schema mismatch, or incompatible
  DSPy program version yields `artifact_invalid`.
- `artifact_invalid` is a non-configurable fail-closed class. It returns typed
  `strict_refuse` / `no_load` / `no_promote` and never falls back to builtin
  expansion, because fallback would hide corrupted or incompatible promoted
  state.
- rebuilding from prompt creates a new `DspyOptimizationArtifactSchema`; it
  never mutates the existing artifact.

## 实施顺序

1. 增加 proposed schema、vault-relative storage 和 catalog entries。
2. 增加 typed services for optimize/evaluate/promote/rollback/disable。
3. 补 `qmd dspy optimize-query-prompt` 子命令。
4. 增加 `qmd dspy evaluate-expansion-policy` 与 evaluation report schema。
5. 增加 promotion gate、history 和 active policy pointer。
6. 保留现有 `LlamaCpp.expandQuery()` 作为 fallback，并接入 online DSPy policy loader。
7. 修改线上 expansion path，使 `qmd query` 可加载 promoted DSPy policy。
8. 增加 drift detection：schema、corpus、index、retriever、reranker、provider
   fingerprint 变化时标记 policy stale。

## 失败恢复

`DspyOptimizationRun` 状态枚举：

- `pending`
- `running`
- `succeeded`
- `failed`
- `cancelled`

幂等键：

```text
optimizationKey =
  trainsetHash +
  valsetHash +
  optimizer +
  metricVersion +
  providerFingerprint +
  seed +
  budgetFingerprint
```

相同 key 的重试复用 `runDir` 和 `logDir`。`evaluate` 和 `promote` 也必须使用
artifact hash、report hash 和 promotion gate hash 作为幂等键。任何失败都不得
修改 active pointer。`promote` 只有在 decision 写入成功后才原子更新 pointer。

Active pointer 原子切换协议：

```text
acquire single-writer lock
write immutable promotion decision
fsync decision file
write pointer temp file
fsync temp file
atomic rename temp file -> current.yaml
append promotion history entry
fsync history file
release lock
```

崩溃恢复规则：

- decision exists and pointer unchanged: retry pointer update.
- temp pointer exists: validate and either complete rename or delete temp.
- history append fails after pointer rename: append recovery entry on next load.
- concurrent promote/rollback/disable fails with typed lock error.

默认预算：

- `auto=light`
- `maxMetricCalls=64`
- `maxTotalTokens=200000`
- `maxPromptTokens=1200`
- `maxExpansionItems=8`
- 超限行为为 fail closed，run 状态为 `failed`，active pointer 不变。

## 测试策略

| layer | required cases |
| --- | --- |
| unit | schema parse, stale comparison, failure policy matrix, redaction |
| integration | bridge optimize response, artifact registry, evaluation report, promotion decision |
| CLI | optimize/evaluate/promote/rollback/disable happy path and failure path |
| online query | promoted policy load, stale fallback, strict refusal, schema invalid fallback |

验收用例：

| case | expected result |
| --- | --- |
| retry same optimization key | reuses runDir and does not create duplicate artifact |
| promote crash before rename | pointer remains old or completes on recovery |
| concurrent promote and rollback | one succeeds, one typed lock error |
| budget exceeded | run failed, active pointer unchanged |
| bridge stderr contains secret-like text | persisted report contains redacted text only |
| stale provider fingerprint | fallback or strict error according to policy |
| compiled artifact hash mismatch | artifact_invalid and no promotion |
| batch_search_only artifact | non_promotable promotion failure |
| run state invalid transition | typed state error and persisted state unchanged |
| pending to running to succeeded | terminal run state with immutable artifact |
| running to failed | failed run with active pointer unchanged |
| cancelled run retry | new or resumed run follows idempotency key rules |
| promote pointer/history mismatch | recovery entry appended and pointer reconciled |
| rollback pointer/history mismatch | recovery entry appended and pointer reconciled |
| disable repeated twice | idempotent disabled state and single effective pointer state |
| failed promote after decision write | recovery completes pointer update or records typed error |

## 安全约束

- secret 值不得进入 artifact、report、log、stdout/stderr、typed error metadata。
- provider key 只允许以 env name 表示。
- bridge stdout/stderr 必须经过 redaction 后进入 report。
- `logDir`、`runDir`、artifact path、prompt path、report path 必须是 vault-relative。
- promotion history and current pointer files use the same path and redaction
  policy.
- 原始 prompt 正文不得写入 `.qmd/index.yml`。

Online runtime boundary:

- online DSPy expansion must be exposed through `createQmdGraphRagRuntime()` and
  `src/integrations/dspy.ts`.
- qmd query code must not call Python directly.
- qmd query code must not read prompt text and execute it directly.
- all online DSPy output must pass through `DspyQueryExpansionProgramOutputSchema`
  and then project to `QueryExpansionItemSchema[]`.

Implementation task table:

| task | artifact | DoD |
| --- | --- | --- |
| schema/storage | contracts + catalog + vault paths | schemas parse, paths portable |
| optimize service | run + artifact | resumable run and redacted logs |
| evaluate service | report | metrics and schema validity recorded |
| promote service | decision + pointer + history | atomic pointer tests pass |
| online loader | runtime policy | fallback/strict/stale tests pass |
| CLI | user commands | CLI happy/failure tests pass |

## 风险与约束

- DSPy 不是硬 schema 系统。必须保留 Zod / JSON Schema validator。
- GEPA 成本受样本量、metric 调用次数和模型影响，需要默认预算上限。
- 优化结果依赖 corpus/index snapshot。缺少 snapshot fingerprint 会导致线上回归
  难以归因。
- 仅优化 query expansion 是第一阶段边界。不要同时优化 answer synthesis、
  reranker 和 graph routing。
- 如果 prompt artifact 被人工编辑，必须改变 artifact hash 并重新 evaluation。

## 参考

- DSPy official overview: `../evidence/dspy-official-overview.md`
- DSPy GEPA official docs: `../evidence/dspy-gepa-official.md`
- GEPA paper: `../evidence/gepa-paper.md`
- DSPy RAG patterns: `../evidence/dspy-rag-patterns.md`
- Query rewriting for RAG: `../evidence/query-rewriting-rag.md`
- Current local boundary: `../evidence/current-qmd-dspy-boundary.md`
- Subagent GEPA findings: `../evidence/subagent-gepa-findings.md`
- Subagent RAG findings: `../evidence/subagent-rag-patterns.md`
- Subagent DSPy core findings: `../evidence/subagent-dspy-core-findings.md`
