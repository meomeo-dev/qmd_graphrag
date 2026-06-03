# GraphRAG 单本书热插拔实现审计 R10 报告

## 审计范围

- agent: `agent-3-runtime-provider`
- scenario: manifest-first runtime provider / producer lineage / compatibility
- baseline: `fixed-baseline.yaml`
- baselineSha256:
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`
- baselinePolicy: 逐字复用 R9 固定 10 维基准，未新增、删除、重排或改名。
- auditMode: local degraded audit after subagent upstream failure

## 总体结论

- overallStatus: `pass`
- baselineCount: `10`
- passed: `10`
- partial: `0`
- failed: `0`

runtime-provider 场景维持 R9 结论：producer run 绑定、artifact metadata 必填
字段、runtime compatibility、scope isolation 和 privacy exclusion 均已有
fail-closed 实现与测试覆盖。真实包扫描也未发现 `.lock`、provider payload、
logs/debug、`.env` 或 recovery payload 残留。

## 逐项判定

| # | baselineId | status | 主要证据 |
|---|---|---|---|
| 1 | `direct_query_entrypoint` | pass | manifest-first projection and runtime gate tests |
| 2 | `artifact_minimum_closure` | pass | required artifact files, metadata rows and package validator |
| 3 | `artifact_gate_state_machine` | pass | copied/candidate/validated/mounted/query-ready gate behavior |
| 4 | `producer_lineage_completeness` | pass | producer run file, status, bookId/runId, stage and provider checks |
| 5 | `lineage_artifact_binding` | pass | artifactIds, stage fingerprint and provider fingerprint fail closed |
| 6 | `schema_runtime_compatibility` | pass | schema/layout/qmd/graphrag/min runtime/provider/dimension checks |
| 7 | `query_scope_isolation` | pass | selected book scoped output and cross-book rejection tests |
| 8 | `privacy_payload_exclusion` | pass | provider payload roots rejected; provider roots absent allowed |
| 9 | `recovery_diagnostics` | pass | stable diagnostics for missing/forged metadata and compatibility mismatch |
| 10 | `executable_contract_tests` | pass | runtime gate, hardening, unified query and CLI tests passed |

## 实测证据

- `test/graphrag-book-hotplug-runtime-gate.test.ts`: `6/6` passed
- `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`: `3/3` passed
- `test/unified-query.test.ts`: `37/37` passed
- `test/cli-graphrag-route.test.ts`: `9/9` passed
- real package scan:
  - queryReady: `30`
  - visibleNotQueryReady: `8`
  - package validation failures: `0`
  - forbidden package residues: `0`

## 剩余风险

runtime-provider 固定基准下无阻断项。目录级 publish/rollback 风险属于
fresh-vault 和 batch-backfill 场景，不改变本场景判定。

## 写入文件

- `implementation-r10-report.md`
- `implementation-r10-summary.json`
