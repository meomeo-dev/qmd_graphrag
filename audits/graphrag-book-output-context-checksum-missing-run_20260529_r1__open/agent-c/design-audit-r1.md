# Design Audit Agent C: book-scoped output checksum missing

Verdict: PASS

## Scope

审计对象为真实运行 `epub-batch-20260529-203000-full-real` 在
`runner_start` 阶段命中的 book-scoped durable failure：

- Primary target:
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json`
- Missing sidecar:
  `graph_vault/books/book-9f587b71073a-ad95ce2f/output/context.json.sha256`
- Failure class: `durable_checksum_missing`
- Recovery decision: `stop_until_fixed`
- Next operator action: `run_explicit_repair`

审计问题：现有 Type DD 是否已充分规定这类 book-scoped output JSON
checksum missing 的处理边界；下一步是否可进入既有 explicit repair 或
migrate-only 流程，还是必须先补 Type DD 或修剪实现。

## Evidence

1. 触发记录已把本故障定位为 book output `context.json` 缺少 checksum
   sidecar。审计状态文件记录 primary target、sidecar target、failure class、
   `stop_until_fixed`、`checkpointWriterLane`、`graphOutputProducer`、
   `read_only_blocking_diagnostic`、`no_book_scoped_mutation` 与
   `run_explicit_repair`。
   Source:
   `/Users/jin/projects/qmd_graphrag/audits/graphrag-book-output-context-checksum-missing-run_20260529_r1__open/reports/status.json`
   lines 7-12 and 34-46.

2. 真实 state root 中 primary JSON 文件存在，checksum sidecar 不存在。
   `context.json` 为 2 bytes，观测 checksum 为
   `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`。
   该状态符合 `target_valid_checksum_missing`，不是 missing primary、invalid
   JSON 或 checksum mismatch。

3. Type DD 明确要求 targetMapping 派生 preflight scope，并规定 YAML/JSON
   durable replace target 必须采用 checksum policy；checksum sidecar 继承
   primary target 的 lane、owner、durableMode 与 preflight scope。
   Source:
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml`
   lines 244-262.

4. Type DD 明确把 `graph_vault/books/{bookId}/output/context.json` 登记为
   durable JSON primary target，lane 为 `checkpointWriterLane`，owner 为
   `graphOutputProducer`。
   Source:
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml`
   lines 546-563.

5. Type DD 明确覆盖 `graph_vault/books/{bookId}/output` 目录的递归目录
   fsync 与 output sidecar scope。该 scope 可覆盖 `context.json.sha256`。
   Source:
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml`
   lines 362-368.

6. Type DD 明确 normal `runner_start` 对 book-scoped target 的 mutation
   budget 固定为 0，book-scoped durable repair 只能通过 explicit repair 或
   migrate-only boundary 执行，并要求 summary 记录 repair scope、扫描上限、
   mutation count 与 next operator action。
   Source:
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml`
   lines 1329-1339.

7. Type DD 明确 book-scoped durable state 是 production state。normal
   `runner_start` 发现 checksum missing 时只能记录 first blocker 并停止在
   `blocked_before_claim`，且不得修改 primary target、checksum sidecar、meta
   sidecar、temp、owner、lock 或 corrupt target。explicit repair 或
   migrate-only 必须按 bookId 和 target family bounded 执行。
   Source:
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml`
   lines 1435-1458.

8. 实现侧 runner startup preflight 对 missing checksum 的只读诊断与 Type DD
   一致：当 checksum sidecar 缺失时返回 `durable_checksum_missing`、
   `checksum_missing`、`target_new_checksum_missing`，并保留 checksum
   sidecar locator。
   Source:
   `/Users/jin/projects/qmd_graphrag/scripts/graphrag/runner-startup-preflight.mjs`
   lines 205-233.

9. 实现侧诊断基类与 Type DD 一致：`runner_start` 诊断为
   `stop_until_fixed`、`repairAllowed: false`、
   `normalRunnerAction: no_book_scoped_mutation`、
   `durableMode: read_only_blocking_diagnostic` 与
   `maxRunnerStartMutationCount: 0`。
   Source:
   `/Users/jin/projects/qmd_graphrag/scripts/graphrag/runner-startup-preflight.mjs`
   lines 296-318.

10. 实现侧 target mapping 与 Type DD 一致：`output/context.json` 映射为
    `checkpointWriterLane`、`json`、`graphOutputProducer`，并使用递归
    `graph_vault/books/{bookId}/output` preflight scope。
    Source:
    `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs`
    lines 457-464.

11. 真实 run manifest、status、recovery-summary 与 events 均显示
    `runner_start` 在 claim 前失败，`mutationCount` 为 0，active provider
    slots、subprocesses 与 book leases 均为 0；事件为
    `durable_preflight_blocked`，不包含普通启动中的 checksum backfill 或
    quarantine 行为。

## Design Decision

现有 Type DD 已充分规定该故障的处理边界（handling boundary）：

- `context.json` 是 book-scoped production durable JSON target。
- 该 target 必须拥有 checksum sidecar。
- checksum sidecar 缺失在 normal `runner_start` 中是 fail-closed blocker。
- normal `runner_start` 只能做 read-only blocking diagnostic，mutation budget
  为 0。
- 普通启动不得回填 `context.json.sha256`，不得 quarantine primary 或 sidecar，
  不得清理 temp/lock，也不得把该 book-scoped durable gap 旁路为 pending work。
- 可写修复边界是 explicit repair 或 migrate-only，且必须 bounded、按 bookId
  与 target family 记录 summary。

因此，本轮不需要先补 Type DD。当前观察到的实现行为与 Type DD 的关键边界一致，
没有发现需要在 repair 前修剪实现的反向证据。

## Implementation Or Repair Gate

允许进入既有 explicit repair 或 migrate-only 流程。

进入条件：

- repair scope 必须限定到该 bookId 和对应 book output durable target family。
- repair 必须使用既有 durable writer path，持有 per-target lock，并按 checksum
  sidecar 与 checksum meta 规则提交。
- repair 必须记录 operator-visible summary，包括 scanned target count、
  mutation count、first/last sample、limit hit 与 next operator action。
- repair 后必须重新运行 status-json 或 normal `runner_start` read-only
  preflight，确认 mutationCount 为 0 且 degradedTargetCount 为 0，之后才允许
  claim item 或继续真实 EPUB 处理。

不允许：

- 直接重启 normal runner 并期待其自动回填 checksum。
- 手工写入 `context.json.sha256` 绕过 durable writer、lock、fsync 与 summary。
- 为本故障先修改 Type DD 或扩大 normal `runner_start` mutation budget。
- 把 `context.json` 缺少 checksum 降级为 provider/transient failure 或普通
  pending item。

结论：PASS。设计基线已覆盖该 book-scoped output JSON checksum missing 场景；
下一步应执行既有 bounded explicit repair 或 migrate-only，不应先补 Type DD，
也不应在普通 runner_start 中增加修复写入。
