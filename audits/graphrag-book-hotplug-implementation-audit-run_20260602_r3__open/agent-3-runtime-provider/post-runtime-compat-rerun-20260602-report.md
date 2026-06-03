# Agent 3 Runtime Provider / Query Gate 复审报告

## 范围

- 审计对象：runtime provider / query gate。
- 固定基准（baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-3-runtime-provider/baseline.yaml`
- baseline SHA-256：
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`
- 约束：
  不修改生产代码（production code）、不修改 baseline、不修改真实
  `graph_vault`；仅运行只读检查与临时目录验证。

## 结论

本轮结论为 `partial`（部分通过 / partial pass）。

当前实现与真实 backfill 结果已经满足以下重点：

- runtime fail-closed（运行时闭锁 / fail-closed）已生效。
- provider payload 排除（payload exclusion）已生效。
- producer run 缺失时不会投影 query capability。
- catalog graph query capability 投影与单书复制包查询可见性已成立。
- 真实 `graph_vault` 中 30 个 query-ready 包可稳定投影，8 个不满足条件的包
  保持 `visible_not_query_ready`，未发生 stale capability 泄漏。

仍不能给 full pass（完全通过 / full pass）的原因有三项：

1. runtime-compatibility 的 schema/digest gate 仍是文件绑定级（file-binding
   level），不是语义重算级（semantic recomputation level）。
2. artifact gate 状态机（state machine）虽已持久化主要状态，但未完整覆盖合同中
   的 `validating`、`rolled_back` 与 quarantine record。
3. per-artifact lineage（逐产物血缘 / per-artifact lineage）仍未把
   `createdAt`、输入哈希（input hash）等字段提升为运行时强制门。

## 关键证据

### 1. 真实 backfill 结果

通过只读脚本逐包验证真实 `graph_vault`，得到以下结果：

- `graph_vault/books` 目录：72
- 含 `BOOK_MANIFEST.json` 的热插拔包：38
- `PUBLISH_READY.json`：38
- `graphrag/output/artifact-metadata.json`：38
- `graphrag/output/runtime-compatibility.json`：38
- `state/hotplug-quality-gate.json`：38，且全部 `status=passed`
- `state/hotplug-runtime-gate.json`：38
- package validator 通过：38/38
- runtime query gate 通过：30/38
- `BOOK_MANIFEST.graphrag.queryReady=true`：30
- catalog `books.yaml`：38
- catalog `document-identity-map.yaml`：38
- catalog `graph-capabilities.yaml`：30
- stale capability book id：0
- forbidden package path：0
- `visible_not_query_ready`：8
- `quarantined`：0

8 个非 query-ready 包均以稳定诊断（stable diagnostics）落为
`visible_not_query_ready`，具体为：

- `book-0c8dffd9585c-41a7e47b`
- `book-2c4d6ff042bb-aea9021b`
- `book-2d1d667301e9-e5c877e8`
- `book-356ff4920cdf-0bbd8bdb`
- `book-5d08f60ba01e-1820c082`
- `book-b75032ab9516-ec793703`
- `book-bc1d37ebbc88-b620fdd8`
- `book-e00b0ec0b4d3-6428a7fd`

这些包统一返回：

- `manifest_not_query_ready`
- `missing_producer_run:community_report-*`
- `missing_producer_run:embed-*`
- `missing_producer_run:query_ready-*`

这证明真实 backfill 已把 producer evidence 缺失明确投影为
not query-ready，而不是错误地给出 graph query capability。

### 2. 复制包后的查询可见性

在临时 fresh vault（临时目录 / temporary vault）中，仅复制
`book-00474fb29e5e-59d02d41` 一个书包后，执行 catalog rebuild：

- `bookCount=1`
- `identityCount=1`
- `capabilityCount=1`
- `capabilityId=book-00474fb29e5e-59d02d41:graph_query`

这证明挂载后的直接查询入口（direct query entrypoint）可以仅依赖包内
`BOOK_MANIFEST.json`、`graphrag/output/*` 和 `graphrag/runs/*`
重建查询可见性，不依赖外部全局状态。

### 3. runtime fail-closed 与 provider payload 禁止

在临时复制包中删除 `graphrag/runs/` 后：

- `validateHotplugRuntimeQueryGate().ok = false`
- 诊断为 `missing_producer_run:*`
- `loadGraphQueryCapabilities()` 返回 0

在临时复制包中新增 `provider-requests/payload.json` 后：

- `validateBookHotplugPackage().ok = false`
- `validateHotplugRuntimeQueryGate().ok = false`
- `loadGraphQueryCapabilities()` 返回 0

这两项直接证明：

- runtime 对 producer run 缺失是 fail-closed。
- provider payload 不允许进入 package closure，也不会进入 query gate。

### 4. runtime-compatibility schema/digest gate 的剩余缺口

在临时复制包中，我做了一个只针对语义层（semantic layer）的负例：

1. 篡改 `graphrag/output/runtime-compatibility.json` 内的
   `parquetSchemaDigest` 与 `lancedbSchemaDigest` 为伪造字符串。
2. 同步更新该文件的 sidecar。
3. 同步更新 `BOOK_MANIFEST.json` 中对应文件的 `sha256/bytes`。
4. 同步更新 `artifact-metadata.json` 中对应 row 的 `fileSha256/bytes`，
   并重算其 `closureDigest`。

在这种“文件绑定完全一致，但 digest 语义被伪造”的情况下：

- `validateHotplugRuntimeQueryGate().ok = true`
- `loadGraphQueryCapabilities()` 仍返回 1

这说明当前 gate 确实验证了：

- 文件存在性（existence）
- sidecar/durable integrity
- manifest file entry 绑定
- artifact metadata file binding

但它没有重算并比对：

- `schemaDigests.outputManifestSchemaDigest`
- `schemaDigests.parquetSchemaDigest`
- `schemaDigests.lancedbSchemaDigest`
- `schemaDigests.artifactMetadataSchemaDigest`

因此，当前实现仍不是合同要求的 runtime-compatibility schema/digest
语义 gate。

## 10 维基准判断

### 1. `direct_query_entrypoint`: pass

`src/graphrag/book-hotplug-catalog.ts` 与
`src/graphrag/capability-catalog.ts` 能从包内 manifest 与本书
`graphrag/output` 恢复 capability。fresh-vault 单书复制验证通过。

### 2. `artifact_minimum_closure`: pass

`scripts/graphrag/book-hotplug-package.mjs` 明确定义 GraphRAG 最低闭包：

- output manifest
- identity map
- artifact metadata
- runtime compatibility
- context/stats
- 6 个核心 parquet
- LanceDB

manifest `files` 与 `requiredArtifacts` 同时绑定 bytes、sha256、required。

### 3. `artifact_gate_state_machine`: partial

合同文件
`docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
已定义：

- `copied`
- `candidate`
- `validating`
- `validated`
- `mounted`
- `query_ready`
- `visible_not_query_ready`
- `quarantined`
- `rolled_back`

实现端 `state/hotplug-runtime-gate.json` 已持久化：

- `copied`
- `candidate`
- `validated`
- `mounted`
- `query_ready | visible_not_query_ready`

不足：

- 未持久化 `validating`
- 未持久化 `rolled_back`
- 未看到 quarantine record（隔离记录 / quarantine record）
- 真实 backfill 中 `quarantined=0`

所以状态机主路径可用，但与合同的完整度仍有差距。

### 4. `producer_lineage_completeness`: partial

`artifact-metadata.json` 已为 required artifacts 提供：

- `producerRunId`
- `producerStep`
- `producerToolVersion`
- `producerSchemaVersion`
- `upstreamArtifactHashes`

且缺 `graphrag/runs/*.yaml` 时 runtime gate 会 fail-closed。

不足：

- `createdAt` 在 runtime gate schema 中仍为 optional。
- 输入哈希（input hash）没有被 runtime gate 作为强制字段验证。
- `upstreamArtifactHashes` 只验证非空，不验证语义正确性。

因此血缘链条已能阻止缺 run 的假阳性，但还未达到 baseline 要求的
每产物完整强制门。

### 5. `lineage_artifact_binding`: pass

manifest `producerRunIds`、`graphrag/runs/*.yaml`、`artifact-metadata.json`
与 `files` 闭包之间存在可验证绑定。删除 `graphrag/runs/` 后 capability
立即消失，真实 catalog 也不存在 stale capability。

### 6. `schema_runtime_compatibility`: partial

`runtime-compatibility.json` 已成为 required artifact，且 query-ready 包必须带有：

- `compatibilityStatus=compatible`
- 4 个 `schemaDigests.*`

但是当前 gate 只验证“字段存在且文件哈希绑定正确”，没有重算 digest 语义。
临时负例已证明伪造 digest 在同步绑定后仍可通过 runtime gate。

这项是本轮最明确的未完成项。

### 7. `query_scope_isolation`: pass

CLI 路由测试、`loadGraphQueryCapabilities()` 的 scope filter，以及 fresh-vault
单书复制结果共同表明：

- 查询只读取被选中 book 的 capability
- stale catalog 不会扩散到其他书
- 单书复制后只暴露该书 graph capability

### 8. `privacy_payload_exclusion`: pass

`src/graphrag/book-hotplug-runtime-gate.ts` 与
`scripts/graphrag/book-hotplug-package.mjs` 同时拒绝：

- `provider-requests/**`
- `provider-responses/**`
- `logs/**`
- `debug/**`
- `trace/**`
- `.env`
- `.durable-recovery.jsonl`

临时负例确认 payload 进入包目录后会双重 fail-closed。

### 9. `recovery_diagnostics`: partial

优点：

- 8 个真实非 ready 包都给出稳定诊断。
- runtime gate 文件已把这些包显式落为 `visible_not_query_ready`。
- catalog query capability 已正确回滚为 0。

不足：

- 合同要求的 quarantine record、rollback record 与 repair entry
  仍未完整物化（materialized）。
- 当前实现更像“稳定诊断 + capability 不投影”，而非完整恢复审计链。

### 10. `executable_contract_tests`: pass

本轮复核通过的测试包括：

- `test/graphrag-book-hotplug-catalog.test.ts`
- `test/unified-query.test.ts`
- `test/integrations/python-bridge-early-stop.test.ts`
- `test/cli-graphrag-route.test.ts`

覆盖点已包含：

- stale projection rebuild
- producer runs 缺失 fail-closed
- provider payload 禁止
- fresh vault settings/query recovery
- selected book scoped output
- capability 投影与 query route

## 阻断 full pass 的问题

### 1. runtime-compatibility digest 未做语义重算

这是本轮最强阻断项。当前 query gate 会接受“绑定自洽但 digest 被伪造”的
`runtime-compatibility.json`。合同要求的 schema/digest gate 仍未真正落地。

### 2. 状态机持久化不完整

`hotplug-runtime-gate.json` 没有完整覆盖合同要求的
`validating / rolled_back / quarantine record`。

### 3. lineage 字段强制性不足

逐产物 lineage 仍未把 `createdAt`、输入哈希与上游哈希语义校验提升为
query-ready 强制门。

## 审计涉及的实现/合同位置

- `src/graphrag/book-hotplug-runtime-gate.ts`
- `src/graphrag/book-hotplug-catalog.ts`
- `src/graphrag/capability-catalog.ts`
- `scripts/graphrag/book-hotplug-package.mjs`
- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
- `docs/architecture/graphrag-producer-lineage-recovery.type-dd.yaml`

## 审计命令

本轮实际执行的关键命令如下：

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
```

```bash
npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

```bash
npx vitest run test/unified-query.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

```bash
npx vitest run test/integrations/python-bridge-early-stop.test.ts \
  --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

```bash
npx vitest run test/cli-graphrag-route.test.ts \
  --testTimeout 240000 --pool forks --poolOptions.forks.singleFork=true
```

```bash
node --import tsx --input-type=module <readonly real-vault validation script>
```

```bash
node --import tsx --input-type=module <temporary fresh-vault copy / missing-runs /
provider-payload negative script>
```

```bash
node --import tsx --input-type=module <temporary semantic digest tamper script>
```
