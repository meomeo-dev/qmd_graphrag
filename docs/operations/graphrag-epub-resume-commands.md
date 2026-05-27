# GraphRAG EPUB 续跑命令附录

## 状态投影

```bash
env \
  -u OPENAI_API_KEY \
  -u OPENAI_BASE_URL \
  -u JINA_API_KEY \
  -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --source-dir inbox/软件工程与系统设计经典著作指南 \
    --state-root graph_vault \
    --qmd-index-path .qmd/index.sqlite \
    --config .qmd/index.yml \
    --project-dotenv .env \
    --log-root /tmp/qmd-epub-batch-20260527-real-resume-1 \
    --status-json
```

## Provider Auth 修复识别

```bash
env \
  -u OPENAI_API_KEY \
  -u OPENAI_BASE_URL \
  -u JINA_API_KEY \
  -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --source-dir inbox/软件工程与系统设计经典著作指南 \
    --state-root graph_vault \
    --qmd-index-path .qmd/index.sqlite \
    --config .qmd/index.yml \
    --project-dotenv .env \
    --log-root /tmp/qmd-epub-batch-20260527-real-resume-1 \
    --status-json
```

## GraphRAG Query Provider 恢复识别

```bash
env \
  -u OPENAI_API_KEY \
  -u OPENAI_BASE_URL \
  -u JINA_API_KEY \
  -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --source-dir inbox/软件工程与系统设计经典著作指南 \
    --state-root graph_vault \
    --qmd-index-path .qmd/index.sqlite \
    --config .qmd/index.yml \
    --project-dotenv .env \
    --log-root /tmp/qmd-epub-batch-20260527-real-resume-1 \
    --status-json | \
  jq '.items[]
    | select(.failedStage == "qmd-query-graphrag-json")
    | {
        sourceName,
        status,
        failureKind,
        retryable,
        retryExhausted,
        recoveryDecision,
        failedStage,
        waitingForProviderRecovery,
        nextRetryAt,
        retryDelaySeconds,
        providerRecoveryReason,
        commandCheckStatus,
        graphBuildStatus,
        graphQueryStatus
      }'
```

期望值是 `status=pending`、`failureKind=transient`、`retryable=true`、
`recoveryDecision=retry_same_run_id`、`waitingForProviderRecovery=true`。若
`nextRetryAt` 已经过期且没有活跃 runner，可执行“写入续跑”。

## 写入续跑

```bash
env \
  -u OPENAI_API_KEY \
  -u OPENAI_BASE_URL \
  -u JINA_API_KEY \
  -u JINA_API_BASE \
  npm run batch:epub -- \
  --run-id epub-batch-20260527-real-resume-1 \
  --source-dir inbox/软件工程与系统设计经典著作指南 \
  --state-root graph_vault \
  --qmd-index-path .qmd/index.sqlite \
  --config .qmd/index.yml \
  --project-dotenv .env \
  --python-bin .venv-graphrag/bin/python \
  --log-root /tmp/qmd-epub-batch-20260527-real-resume-1 \
  --max-command-attempts 3 \
  --max-transient-command-attempts 12 \
  --max-resume-passes 24 \
  --retry-base-delay-seconds 30 \
  --retry-max-delay-seconds 300 \
  --retry-budget-seconds 7200 \
  --max-provider-recovery-waits 3 \
  --command-timeout-seconds 21600 \
  --heartbeat-interval-seconds 30
```

## 快速汇总

```bash
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const runId = "epub-batch-20260527-real-resume-1";
const root = path.join("graph_vault", "catalog", "batch-runs", runId);
const itemDir = path.join(root, "items");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const items = fs.readdirSync(itemDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(itemDir, name), "utf8")));
const countBy = (key) => items.reduce((acc, item) => {
  const value = key(item) ?? "missing";
  acc[value] = (acc[value] ?? 0) + 1;
  return acc;
}, {});
const requiredCommandChecks = [
  "qmd-version", "qmd-status", "qmd-doctor-json", "qmd-pull", "qmd-update",
  "qmd-embed", "qmd-ls-books", "qmd-search-json", "qmd-search-csv",
  "qmd-search-md", "qmd-search-xml", "qmd-search-files", "qmd-vsearch-json",
  "qmd-query-json", "qmd-query-auto-json", "qmd-query-graphrag-json",
  "qmd-get-book", "qmd-multi-get-json", "qmd-collection-list",
  "qmd-collection-show-books", "qmd-context-list", "qmd-skills-list-json",
  "qmd-skills-get-json", "qmd-skills-path-json", "qmd-skill-show",
  "qmd-dspy-status-json", "qmd-cleanup",
];
const commandCheckStatus = (item) => {
  const checks = item.commandChecks || [];
  const names = checks.map((check) => check.name);
  const unique = new Set(names);
  const failed = checks.find((check) => check.status !== "passed");
  if (
    checks.length === requiredCommandChecks.length &&
    unique.size === requiredCommandChecks.length &&
    requiredCommandChecks.every((name) => unique.has(name)) &&
    failed == null
  ) {
    return "succeeded";
  }
  return failed == null ? "pending" : "failed";
};
console.log(JSON.stringify({
  manifest: {
    status: manifest.status,
    totalItems: manifest.totalItems,
    pendingItems: manifest.pendingItems,
    runningItems: manifest.runningItems,
    completedItems: manifest.completedItems,
    failedItems: manifest.failedItems,
    updatedAt: manifest.updatedAt,
  },
  itemStatus: countBy((item) => item.status),
  qmdBuildStatus: countBy((item) => item.qmdBuildStatus?.status),
  commandCheckStatus: countBy(commandCheckStatus),
  commandCheckCount: countBy((item) => (item.commandChecks || []).length),
  graphBuildStatus: countBy((item) => item.graphBuildStatus?.status),
  graphQueryStatus: countBy((item) => item.graphQueryStatus?.status),
  waitingForProviderRecovery: items
    .filter((item) => item.waitingForProviderRecovery)
    .map((item) => ({
      itemId: item.itemId,
      bookId: item.bookId,
      sourceName: item.sourceName,
      nextRetryAt: item.nextRetryAt,
      failedStage: item.failedStage,
    })),
}, null, 2));
NODE
```
