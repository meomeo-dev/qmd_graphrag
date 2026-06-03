# Design Audit Agent A Report

## Verdict: PASS

现有 Type DD 已充分规定 book-scoped output JSON checksum missing
（书级输出 JSON 校验和缺失）的处理边界。该真实运行在
`runner_start` 阶段停止，并把下一步动作设置为
`run_explicit_repair`，与设计基线一致。

允许进入既有 explicit repair 或 migrate-only 流程。不得在普通
`runner_start` 或普通 resume 路径中自动回填、隔离或修剪该
book-scoped target。

## 审计范围

- 固定审计范围：
  `audits/graphrag-book-output-context-checksum-missing-run_20260529_r1__open`
- 固定设计基线：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 触发运行：
  `epub-batch-20260529-203000-full-real`
- 触发目标：
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json`
- 缺失 sidecar：
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json.sha256`

## 证据

1. 审计状态记录确认触发事实：
   `reports/status.json` 记录 failed stage 为 `runner_start`，primary
   target 为 book-scoped `output/context.json`，sidecar target 为
   `context.json.sha256`。同一文件记录
   `localFailureClass: durable_checksum_missing`、
   `recoveryDecision: stop_until_fixed`、
   `durableMode: read_only_blocking_diagnostic`、
   `normalRunnerAction: no_book_scoped_mutation` 与
   `nextOperatorAction: run_explicit_repair`。

2. 真实运行状态确认实现没有越界写入：
   `graph_vault/catalog/batch-runs/epub-batch-20260529-203000-full-real/status.json`
   中 `startupRecovery.mutationCount` 为 `0`，`repairAllowed` 为
   `false`，`decision` 为 `blocked_before_claim`，并且
   `activeProviderSlots`、`activeSubprocesses`、`activeBookLeases` 均为
   `0`。

3. 真实事件流记录同一阻断事件：
   `events.jsonl` 第 1 条事件为 `durable_preflight_blocked`，携带
   `localFailureClass: durable_checksum_missing`、
   `checksumRecoveryDecision: target_new_checksum_missing`、
   `completedPublishRule: forbidden`、
   `durableMode: read_only_blocking_diagnostic` 与
   `repairAllowed: false`。

4. Type DD 已将 `context.json` 明确列入生产 target mapping：
   `graph_vault/books/{bookId}/output/context.json` 的 `durableKind` 为
   `json`，lane 为 `checkpointWriterLane`，owner 为
   `graphOutputProducer`。这使该文件的 checksum sidecar、lane、owner、
   timeout 与 release 规则均可从基线推导。

5. Type DD 的 derived sidecar 规则规定，所有采用 checksum policy 的
   YAML/JSON durable replace target 隐式拥有 `{target}.sha256` 与
   `{target}.sha256.meta.json`，且 sidecar 继承 primary target 的 lane、
   owner、durable mode 与 preflight scope。`context.json` 是 JSON
   durable target，因此缺少 `context.json.sha256` 是受设计管辖的
   checksum missing，而不是未定义状态。

6. Type DD 的 runner_start preflight 规则规定，book-scoped target 在
   normal `runner_start` 中必须使用 read-only blocking diagnostic；发现
   checksum missing 时必须 fail fast 到 `blocked_before_claim`，book-scoped
   normal runner mutation budget 固定为 `0`。

7. Type DD 的 book-scoped production_state recovery 规则规定，normal
   `runner_start` 不得修改既有 book-scoped primary target、checksum
   sidecar、meta sidecar、temp、owner、lock 或 corrupt target；显式 repair
   或 migrate-only 必须按 `bookId` 与 target family bounded 执行，且修复后
   需要重新执行 read-only preflight，确认 `mutationCount` 为 `0` 且
   `degradedTargetCount` 为 `0` 后才能 claim item。

## 设计决策

现有 Type DD 不需要先补充。该场景已经被以下设计边界覆盖：

- `context.json` 是已登记的 book-scoped production JSON target。
- `context.json.sha256` 是由 primary target 派生的 checksum sidecar。
- checksum sidecar 缺失属于 `durable_checksum_missing` /
  `target_new_checksum_missing` 类型的本地状态完整性问题
  （local state integrity）。
- normal `runner_start` 只能做只读阻断诊断，不能 backfill、quarantine、
  rename、cleanup 或创建 sidecar。
- 可写修复只能发生在 explicit repair 或 migrate-only 边界内，并需要数量上限、
  summary、事件或 recovery summary 证据。

本次运行的状态、事件与设计基线一致。没有证据表明实现需要因本问题先行修剪
（implementation trimming）。若后续发现实现存在普通 `runner_start` 对
book-scoped target 写入 checksum、meta、temp、lock 或 corrupt quarantine 的路径，
应修剪该实现路径；但当前证据显示该越界行为未发生。

## 是否允许进入实施/repair

允许进入既有 explicit repair 或 migrate-only 流程。

进入 repair 前后必须遵守以下条件：

- repair scope 必须限定到明确的 `bookId` 与 target family。
- repair 必须持有 per-target lock，并按既有 durable write protocol 写入
  checksum sidecar 与 checksum meta sidecar。
- repair 必须输出 operator-visible summary，保留 first sample、last sample、
  mutation count、quarantine count 与 next operator action。
- repair 不得把缺失 sidecar 的 primary target 直接标记为完成状态。
- repair 后必须重新运行 status-json 或 normal `runner_start` read-only
  preflight；只有 `mutationCount: 0` 且没有阻断性 degraded target 时，才允许
  继续 claim item 或启动新 run。

不需要先补 Type DD。不建议执行普通 runner resume 来隐式修复该缺失 sidecar。
