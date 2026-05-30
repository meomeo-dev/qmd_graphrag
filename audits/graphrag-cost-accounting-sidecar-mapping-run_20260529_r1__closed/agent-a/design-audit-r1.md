# Agent A Design Audit R1: Cost Accounting Sidecar Mapping

## Verdict

Verdict: FAIL

当前 Type DD 不足以关闭
`graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json`
的 durable target mapping 缺口。它已经登记 primary target
`graph_vault/catalog/cost-accounting.jsonl`，但没有把 JSONL primary
的 temp file、temp owner sidecar 与 checksum sidecar 继承映射写成明确、
可测试的设计不变量（design invariant）。

因此本次失败不是 primary target 缺失；它是 derived auxiliary target
归一化（normalization）契约不足，并在共享 durable store 实现中暴露。

## Observed Failure

审计入口 `audits/graphrag-cost-accounting-sidecar-mapping-run_20260529_r1__open/reports/status.json`
记录真实 run `epub-batch-20260529-135547-full-real` 在
`resume-book-1` 失败：

- `failureKind`: `local_state_integrity`
- `localFailureClass`: `durable_target_mapping_missing`
- `recoveryDecision`: `stop_until_fixed`
- target:
  `graph_vault/catalog/cost-accounting.jsonl.tmp-66947-1780063310198-a9bd44c0-7fa5-4f22-af14-9f343c9f0843.owner.json`

失败 target 是 cost ledger primary 的 temp owner sidecar，不是新的业务
primary target。

## Type DD Coverage

Type DD 已覆盖的部分：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 的
  `targetMapping` 已登记
  `graph_vault/catalog/cost-accounting.jsonl`，lane 为
  `eventWriterLane`，owner 为 `providerCostAccounting`。
- `temporaryFileIdentity` 与 `temporaryFileLifecycle` 已要求 durable replace
  使用唯一 temp、exclusive create、owner evidence、fsync 与 recovery 校验。
- `adapterRule` 已要求子进程或同步 adapter 实现同一 temp identity、
  owner evidence、checksum、fsync、lock 与 failure classification 契约。

Type DD 未充分覆盖的部分：

- `derivedSidecarRule` 只写明 durable YAML/JSON primary 隐式拥有 checksum
  sidecar，没有明确覆盖 `durableKind: jsonl` 的 cost accounting ledger。
- Type DD 没有明确声明 `{target}.tmp-*` 与
  `{target}.tmp-*.owner.json` 是 primary target 的 derived auxiliary target，
  必须继承 primary 的 lane、owner、durableKind、laneTimeoutMs、releaseOn 与
  preflight scope。
- `targetMappingContract` 禁止未登记 durable YAML/JSON/SQLite target 写入。
  temp owner sidecar 以 `.json` 结尾；若缺少 derived auxiliary 规则，实现会把
  `.owner.json` 当成独立 JSON production target 查表，得到当前失败。
- preflight 规则明确提到 book-scoped output 下的 `.tmp-*`、`.owner.json`、
  `.sha256` 与 `.sha256.meta.json`，但没有把同等规则提升为所有 targetMapping
  family 的通用派生规则，尤其是 catalog 级 cost accounting target。
- cost accounting JSONL 的 checksum policy 不明确：若 JSONL durable replace
  应生成 checksum sidecar，则 Type DD 需要纳入 JSONL；若 JSONL append 不应生成
  checksum sidecar，则 Type DD 必须明确排除并说明 temp/owner 仍如何归一。

结论：Type DD 对 primary mapping 足够，但对 cost-accounting JSONL 的
temp/owner/checksum sidecar mapping 不足够。

## Implementation Findings

`scripts/graphrag/batch-epub-workflow.mjs` 中 runner 自有 mapping table 已登记
`graph_vault/catalog/cost-accounting.jsonl`。runner 内部 JSONL writer 在写
owner sidecar 时显式复用 primary operation：

- `writeJsonlAtomic()` 调用 `writeJsonSidecar(ownerPath, operation, operation)`。

因此 runner 自有路径不会把 owner sidecar 重新当作 primary target 查表。

`src/provider/cost-accounting.ts` 通过共享 durable store 写 cost ledger：

- `appendProviderCostAccounting()` 写
  `graph_vault/catalog/cost-accounting.jsonl`。
- 它调用 `writeOpaqueFileDurableSync()`，不是 runner 内部
  `writeJsonlAtomic()`。

`src/job-state/durable-state-store.ts` 的共享 durable store 存在实现缺口：

- `writeOpaqueFileDurableUncheckedSync()` 创建 primary operation 后，调用
  `writeJsonSidecarSync(ownerPath, operation)`。
- `writeJsonSidecarSync()` 的默认参数会在未显式传入 operation 时对 sidecar
  path 执行 `newOperationEvidence(path, "json-sidecar")`。
- `primaryTargetPathForMapping()` 只归一 `.corrupt-*`、`.sha256` 与
  `.sha256.meta.json`，没有归一 `.tmp-*` 或 `.tmp-*.owner.json`。
- 在真实 production path 中，`cost-accounting.jsonl.tmp-*.owner.json` 因包含
  `/graph_vault/` 被视为 production durable target，随后因无独立 mapping
  触发 `durable_target_mapping_missing`。

现有 cost accounting 测试覆盖 ledger append 与 corrupt tail quarantine，但
测试路径通常不是 production `.../graph_vault/catalog/...` 形态，未触发生产
mapping fail-closed 分支。

## Design Recommendations

1. 补充 Type DD 的 derived auxiliary mapping rule。

   明确每个 targetMapping primary target 隐式拥有以下派生目标：
   `{target}.tmp-{tempId}`、`{target}.tmp-{tempId}.owner.json`，以及在 checksum
   policy 启用时的 `{target}.sha256`、`{target}.sha256.tmp-{tempId}`、
   `{target}.sha256.tmp-{tempId}.owner.json`、
   `{target}.sha256.meta.json` 与其 temp/owner sidecar。所有派生目标继承
   primary 的 lane、owner、laneTimeoutMs、releaseOn、durableMode 与
   preflight scope，不得要求独立 targetMapping row。

2. 将 `derivedSidecarRule` 从 YAML/JSON 扩展或拆分到 JSONL。

   对 `graph_vault/catalog/cost-accounting.jsonl` 必须明确选择一种 policy：
   durable JSONL replace with checksum sidecars，或 append-only JSONL without
   checksum sidecars。当前代码走 durable replace/opaque path，因此设计上更应
   明确 JSONL replace 的 temp/owner 继承映射；checksum 是否启用不能留空。

3. 修剪错误实现方向。

   不应通过增加
   `graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json`
   之类显式 targetMapping row 解决。temp、owner、checksum temp 与 checksum
   meta 是派生 durable auxiliary，不是业务 primary target。显式 wildcard row
   会制造递归 sidecar 语义和 owner 归属分裂。

4. 要求 runner adapter 与共享 durable store 使用同一归一化契约。

   Type DD 应要求 mapping resolver 对 primary、checksum sidecar、checksum meta、
   temp、temp owner、quarantine target 执行相同 primaryTargetLocator 归一化，
   并要求 evidence 保留 `primaryTargetLocator`、`sidecarTargetLocator` 或
   `auxiliaryTargetLocator`、`sidecarKind` 或 `auxiliaryKind`、
   `targetMappingOwner` 与 `lane`。

5. 继续实施前先补 Type DD。

   当前 Type DD 需要窄幅修正；修正后实施应限制在共享 durable store 的
   mapping normalization、owner sidecar operation 传递、cost accounting JSONL
   policy 与测试补齐，不应扩大到 unrelated runner behavior。

## Required Tests

必须补充以下测试项：

- Production path append: 在临时目录下创建真实
  `.../graph_vault/catalog/cost-accounting.jsonl` 路径，调用
  `appendProviderCostAccounting()`，不得出现
  `durable_target_mapping_missing`。
- Temp owner mapping: 通过公开 API 或 targeted fixture 覆盖
  `cost-accounting.jsonl.tmp-*.owner.json`，断言其继承
  `eventWriterLane`、`providerCostAccounting`、`laneTimeoutMs` 与 `releaseOn`。
- Checksum policy test: 按修正后的 Type DD，验证 cost accounting JSONL 的
  `.sha256`、`.sha256.meta.json` 及其 temp/owner sidecar 要么完整继承 primary
  mapping，要么被明确排除且 status/preflight 不因缺失 checksum 报错。
- Corrupt tail quarantine production path: 在 production `graph_vault` 路径下
  制造 corrupt JSONL tail，调用 cost accounting append，断言 quarantine target
  继承 primary mapping，且不会把 `.corrupt-*` 当成未登记 primary target。
- Resume child envelope: 在 `resume-book-*` 子进程路径中触发一次 provider cost
  accounting 写入，父 runner 不应收到
  `QMD_GRAPHRAG_DURABLE_FAILURE` 的
  `durable_target_mapping_missing`；若注入其他 durable failure，envelope 必须
  保留 lane、targetMappingOwner、tempId、operationId 与 completedPublishRule。
- Startup/status scan: `runner_start`、`beforeResumeBook` 与 `--status-json`
  对 catalog 级 `cost-accounting.jsonl.tmp-*.owner.json` 能分类为 derived temp
  evidence 或 unresolved temp，不得分类为 target mapping missing；status-json
  不得创建、删除或重命名 `.tmp-*`、`.owner.json`、checksum 或 meta sidecar。
- Negative mapping: 随机未登记 production target 的 `.tmp-*.owner.json` 仍应
  fail closed，避免把所有 catalog temp owner 无条件归到 cost accounting。
- Parity test: runner mapping resolver 与 shared durable store resolver 对
  cost accounting primary、temp、owner、checksum、checksum meta、quarantine
  locator 返回一致 lane、owner、durableKind 与 release policy。

## Implementation Gate

不允许基于当前 Type DD 直接进入代码实施。

允许进入实施的条件：

- Type DD 先补齐 JSONL derived auxiliary mapping 与 cost accounting checksum
  policy。
- 实施范围限定为共享 durable store 与必要 adapter parity。
- 上述必须测试至少覆盖 production `graph_vault` 路径、temp owner sidecar、
  quarantine sidecar 与 resume child envelope。

修正后预计可以进入实施；当前状态应保持 `stop_until_fixed`。
