# 设计复审报告：GraphRAG query-ready recovery reopen

result: PASS

## 复审范围

本次按同一固定基准复审以下设计文件，重点复核上次 FAIL 的两个问题：

- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/architecture/unified-retrieval-plane.md`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml`
- `catalog/data-bus.catalog.yaml`

## 修复复核

### 真实 failure text 的 focused regression tests

状态：PASS

设计已把两个历史真实失败形状固定为 focused regression：

- `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`
- `capabilityScope references unknown or not-ready graphCapabilityId(s):
  book-356ff4920cdf-0bbd8bdb:graph_query`

runbook 要求两者都从 persisted `stop_until_fixed` checkpoint reopen 到 pending
repair，并分别验证 identity projection repair 与 graph capability projection
repair。Type DD acceptance 进一步要求保留高成本 producer run ids、走正常
`query_ready` / command-check path、不得直接写 completed。

证据：

- `docs/operations/graphrag-epub-batch-runbook.md:155`
- `docs/operations/graphrag-epub-batch-runbook.md:157`
- `docs/operations/graphrag-epub-batch-runbook.md:161`
- `docs/operations/graphrag-epub-batch-runbook.md:165`
- `docs/architecture/unified-retrieval-plane.md:835`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1964`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1971`

### reopen 后 BatchItemCheckpoint 审计字段约束

状态：PASS

设计已明确 reopened item checkpoint 的 machine-readable repair metadata，包括
`reopenedFromStatus`、`reopenedToStatus`、`reopenedFromRecoveryDecision`、
`repairReason`、`repairFailureText`、`repairedProjection`、
`repairEvidenceLocator`、`reusedProducerRunIds` 和
`normalCommandChecksRequired=true`。runbook 要求 `events.jsonl` 与
`recovery-summary.json` 投影同一事实；Type DD 明确 event log 和 recovery summary
是 reopened item checkpoint 的投影，catalog 也补充了 event 与 summary 的 repair
evidence 说明。

证据：

- `docs/operations/graphrag-epub-batch-runbook.md:81`
- `docs/operations/graphrag-epub-batch-runbook.md:96`
- `docs/architecture/unified-retrieval-plane.md:735`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:382`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1620`
- `catalog/data-bus.catalog.yaml:71`
- `catalog/data-bus.catalog.yaml:117`
- `catalog/data-bus.catalog.yaml:1099`

## 剩余发现

无剩余阻断发现。

上次两项 FAIL 均已在设计层补齐：测试契约覆盖真实 failure text，checkpoint、
event log 和 recovery summary 的 reopen observability 也已有明确约束。

## 残余风险

- 设计已满足固定基准，但实现仍需确保 classifier 只能从 persisted failure text
  和当前 validated artifacts 触发 reopen，不能被 operator intent 单独触发。
- `BatchItemCheckpoint.metadata` 字段需要进入实际 schema、fixture 和 contract
  tests，否则设计约束可能无法被 CI 强制执行。
- graph capability projection repair 仍需实现层验证 catalog derived capability 与
  explicit catalog merge 顺序，避免读取旧 not-ready projection。
- `--status-json` 的只读语义仍需测试，确保复算 recovery projection 时不写入
  checkpoint、event log 或 producer manifest。
