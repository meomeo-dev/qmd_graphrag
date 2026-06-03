# Agent 3 Runtime Provider Implementation R12 Report

## 基准

- 固定基准（fixed baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r12__open/agent-3-runtime-provider/fixed-baseline.yaml`
- SHA-256:
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`
- 基准文件未修改。

## 结论

R11 指定失败项已关闭（closed），R12 额外发现也已关闭。总体状态
（overall status）为通过（passed）。

当前实现满足以下 runtime-provider 判据：

- runtime query gate 校验 `BOOK_MANIFEST.json` sidecar 内容。
- 篡改 `BOOK_MANIFEST.json` 后不会导出 `graph_query` capability。
- synthetic/test-hook `qmd_graph_text_unit_identity.json` 不能进入
  query-ready capability。
- 纯 legacy vault 不再被 hotplug projection 空重建覆盖，legacy book-state
  capability 正向 overlay 路径恢复。

## 实现复核

`validateHotplugRuntimeQueryGate` 在读取 runtime manifest 前调用
`validateBookHotplugPackageBoundary`，并把 boundary diagnostics 纳入 gate
结果。之后继续校验 manifest schema、required artifacts、artifact metadata、
producer bindings 和 runtime compatibility。任何 diagnostics 都会使 gate
返回 `ok: false`。

关键证据：

- `src/graphrag/book-hotplug-runtime-gate.ts:484` 调用 package boundary
  validator。
- `src/graphrag/book-hotplug-runtime-gate.ts:520` 至 `:532` 校验 required
  artifact、artifact metadata 与 runtime compatibility。
- `src/graphrag/book-hotplug-package-validator.ts:182` 至 `:220` 读取
  `.sha256` 和 `.sha256.meta.json`，比较 sidecar checksum 与实际文件 bytes。
- `src/graphrag/book-hotplug-package-validator.ts:402` 至 `:405` 进入
  `graphrag.requiredArtifacts` 闭包校验。
- `src/graphrag/capability-catalog.ts:513` 至 `:518` 在
  `projectQueryReadyLineage` 前重新执行 runtime query gate。
- `src/graphrag/capability-catalog.ts:872` 至 `:897` 在 capability 加载入口先
  确保 hotplug catalog projection，再只返回通过过滤的 `graph_query`。

R12 额外发现修复点：

- `src/graphrag/book-hotplug-catalog.ts:191` 至 `:199` 只把同时存在
  `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json` 的目录视为 published hotplug
  candidate。
- `src/graphrag/book-hotplug-catalog.ts:551` 至 `:567` 在没有可投影 hotplug
  books 时，只有存在 published hotplug candidate 才重建 projection；纯
  legacy vault 直接返回，不再清空已有 catalog projection。

## R11 关闭项

| R11 项 | 状态 | 证据 |
| --- | --- | --- |
| runtime query gate 校验 manifest sidecar 内容 | 通过 | boundary validator 读取并比较 `.sha256` 与 `.sha256.meta.json` 内容；runtime gate 先调用该 validator。 |
| 篡改 `BOOK_MANIFEST.json` 后不能导出 `graph_query` capability | 通过 | 测试篡改 manifest 后断言 `manifest_sha256_mismatch` 且 `loadGraphQueryCapabilities` 返回空。 |
| synthetic/test-hook `qmd_graph_text_unit_identity` 不能进入 query-ready capability | 通过 | 测试写入 `identityProvenance: "test_hook_synthetic"` 和 `publishAllowed: false`，重新同步 manifest sidecar 后仍返回空 capability。 |
| 相关测试覆盖 | 通过 | 目标 runtime gate、catalog projection 和 qmd registration/overlay 测试覆盖指定路径。 |

## R12 额外发现关闭项

| 发现 | 状态 | 证据 |
| --- | --- | --- |
| legacy book-state capability 正向 overlay 返回空 capability | 已关闭 | 最小复现用例 `keeps derived book-state capability authoritative over explicit catalog` 已通过。 |
| hotplug projection 可能覆盖纯 legacy vault catalog | 已关闭 | `ensureCatalogProjectionFromBookHotplugPackages` 仅在存在 published hotplug candidate 时重建空 projection。 |

## 测试证据

通过：

```text
npx vitest run test/unified-query.test.ts \
  -t "keeps derived book-state capability authoritative over explicit catalog" \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true

1 passed, 36 skipped
```

通过：

```text
npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  -t "stale manifest sidecar|rebuilds graph capability catalog|does not project package" \
  --testTimeout 180000 --pool forks --poolOptions.forks.singleFork=true

2 passed, 8 skipped
```

通过：

```text
npm exec -- tsc -p tsconfig.build.json --noEmit
```

通过：

```text
npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts \
  -t "manifest content changes|synthetic test-hook|global catalog is absent" \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true

3 passed, 6 skipped
```

## 剩余发现

无。
