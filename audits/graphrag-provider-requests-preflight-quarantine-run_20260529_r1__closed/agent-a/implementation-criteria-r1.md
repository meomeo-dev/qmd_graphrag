# Agent A Implementation Criteria R1

## 固定基准

1. 当前审计必须只使用
   `graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open`，
   不得创建新的 `__open` 目录。
2. `runner_start` 对 `graph_vault/catalog/provider-requests/*.json` 必须只执行
   read-only capped diagnostic，不得调用 writable reconcile。
3. 普通 runner 不得对 provider request primary target 创建 `.corrupt-*`
   quarantine 文件。
4. 普通 runner 不得在 provider-requests 目录创建 lock、temp、checksum 或
   checksum meta 文件作为 runner-start 诊断副作用。
5. provider request checksum mismatch 不得作为唯一原因阻止 EPUB rediscovery
   或 batch manifest 创建。
6. manifest 必须在任何 runner-start writable recovery 前创建或加载，并包含
   startup recovery 观测摘要。
7. provider request diagnostic 必须包含 scannedTargetCount、
   degradedTargetCount、sampleTargetLocators、diagnosticClass 与
   normalRunnerAction。
8. `--status-json` 必须以同 scope read-only 方式报告 provider request durable
   risk，且不得修改 stateRoot。
9. 既有 critical durable targets，如 book-scoped YAML checksum mismatch，仍必须
   保持 fail-closed 与 quarantine 行为。
10. 验证必须至少包含 YAML parse、Node syntax check、TypeScript typecheck 与
    provider request focused tests。
