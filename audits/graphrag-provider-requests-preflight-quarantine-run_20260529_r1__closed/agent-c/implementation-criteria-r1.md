# Agent C Implementation Criteria R1

## 固定基准

1. 审计只能覆盖本次 provider-requests runner-start preflight quarantine 修复。
2. 实现不得移除或放宽非 provider request critical durable preflight 保护。
3. provider request target mapping 必须仍保留 lane、owner 与 directory fsync 映射。
4. provider request normal runner action 必须明确为 no_primary_quarantine。
5. read-only diagnostic 不得通过 event append、manifest rebuild 之外的 provider
   request side effect 来表达风险。
6. startup recovery metadata 必须包含 runId、stage、scopeCount、targetCount、
   mutationCount、decision 与 explicitRepairHint。
7. diagnostic samples 必须受 maxRunnerStartReportedSamples 上限约束。
8. provider request diagnostic 必须保留 target locator，避免只输出聚合数字。
9. 测试必须包含 runner-start 与 status-json 两个入口。
10. 所有验证命令失败都必须阻止实施审计通过。
