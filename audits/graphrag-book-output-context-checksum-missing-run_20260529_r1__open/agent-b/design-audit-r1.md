# Agent B 设计审计 R1

Verdict: PASS

## 审计结论

现有 Type DD 已充分规定 book-scoped output JSON durable target 缺少
checksum sidecar 的处理边界。`context.json` 属于
`graph_vault/books/{bookId}/output/context.json` 生产状态
(production state)，其 `.sha256` sidecar 是 checksum policy 下的派生
durable sidecar。normal `runner_start` 在此类目标上只能执行 read-only
blocking diagnostic，发现 checksum missing 后必须停止在
`blocked_before_claim` / `stop_until_fixed`，默认下一步动作为
`run_explicit_repair`。

下一步允许进入既有 explicit repair 或 migrate-only 流程。无需先补 Type DD。
也不应为了绕过本次 blocker 修剪实现；实现若已产出
`durable_checksum_missing`、`stop_until_fixed`、`normalRunnerAction:
no_book_scoped_mutation` 与 `nextOperatorAction: run_explicit_repair`，则与
设计契约 (design contract) 一致。

## 运行证据

- 审计输入记录真实 run `epub-batch-20260529-203000-full-real` 在
  `runner_start` 阶段失败；primary target 为
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json`，
  sidecar target 为
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json.sha256`。
- 失败分类为 `failureKind: local_state_integrity`、
  `localFailureClass: durable_checksum_missing`、
  `recoveryDecision: stop_until_fixed`。
- 诊断字段已解析到 `lane: checkpointWriterLane` 与
  `targetMappingOwner: graphOutputProducer`。
- durable mode 为 `read_only_blocking_diagnostic`，normal runner action 为
  `no_book_scoped_mutation`，operator action 为 `run_explicit_repair`。
- startup counts 显示 `startupMutationCount: 0`，且 active provider slot、
  subprocess、book lease 均为 0，符合 runner_start read-only 阻断边界。

## Type DD 证据

- `targetMappingContract` 要求每个生产 durable YAML/JSON/JSONL/SQLite
  primary target 必须从 targetMapping 追溯到唯一 lane、owner 与 durable
  kind；辅助 checksum path 必须归一回 primary target，不得成为新的
  primary target。
- `derivedSidecarRule` 规定每个采用 checksum policy 的 durable primary
  target 隐式拥有 `{target}.sha256` 与 `{target}.sha256.meta.json`，sidecar
  继承 primary target 的 lane、owner、durable mode 与 preflight scope；
  当前 YAML/JSON durable replace 必须采用 checksum policy。
- `targetMapping` 明确登记
  `graph_vault/books/{bookId}/output/context.json`，lane 为
  `checkpointWriterLane`，durable kind 为 `json`，owner 为
  `graphOutputProducer`。
- `durableStatePreflight.runnerStart` 明确禁止 normal `runner_start` 对既有
  book-scoped durable target 执行 checksum backfill、checksum meta backfill、
  temp cleanup、primary quarantine、sidecar quarantine 或 corrupt rename。
  对 book-scoped target 的 normal `runner_start` mutation budget 固定为 0。
- 同一 runner_start 规则要求发现 book-scoped checksum mismatch、checksum
  missing、checksum meta conflict、invalid target、unknown temp 或 lock owner
  不可判定时，在第一个 blocker 后 fail fast，并写入
  `blocked_before_claim`；blocked book-scoped durable mismatch 的默认
  `nextOperatorAction` 为 `run_explicit_repair`。
- `bookScopedDurableState` 将
  `graph_vault/books/{bookId}/output/*.json` 纳入 production state，并规定
  normal runner_start recovery 为 `read_only_blocking_diagnostic`，explicit
  repair recovery 为 `bounded_repair_or_quarantine`。
- `checksumCommit.sidecarQuarantineDecisionTable` 对
  `target_valid_checksum_missing` 给出边界：keep primary，由 repair writer
  backfill checksum，再 backfill meta；status-json/read-only 投影为 fail-closed
  diagnostic，recovery decision 为 `stop_until_fixed_without_writer_evidence`。

## 设计决策

1. 本次 blocker 是已登记 book-scoped production JSON target 的 checksum
   sidecar 缺失，不是 targetMapping 缺失、scope 不明或设计未覆盖状态。
2. normal `runner_start` 已正确停在只读诊断边界；它不得自行补写
   `context.json.sha256`，也不得 quarantine primary 或 sidecar。
3. Type DD 已给出 repair writer 的合法边界：显式 explicit repair 或
   migrate-only，按 bookId 与 target family bounded 执行，并记录 summary。
4. 只有在 repair writer 重新读取后无法证明 primary target 内容有效，或
   checksum/meta evidence 冲突时，才进入 quarantine 或继续
   `stop_until_fixed`；不得把 sidecar missing 直接解释为 primary corruption。
5. 修复完成后，必须重新执行 status-json 或 normal runner_start read-only
   preflight，确认 `mutationCount: 0` 且 `degradedTargetCount: 0` 后才能 claim
   item。

## 放行判定

允许进入实施/repair：是。

放行范围仅限既有 explicit repair 或 migrate-only 流程，对目标 bookId 与
target family 执行 bounded checksum sidecar repair。不得在 normal runner_start
中补写 checksum，不得扩大扫描或修复边界，不得修改 Type DD 作为本次 repair 的
前置条件。
