# Agent 1 Fresh Vault Post Runtime Compatibility Rerun

## 结论

本次复审结论为 `partial`（部分满足 / partial compliance）。

在 `2026-06-02` 当前工作区中，真实 backfill 生成的单书 hotplug package
（热插包 / hotplug package）已经能够满足 fresh-vault 单书复制挂载与
book-scoped GraphRAG 查询闭环（query loop closure）的核心要求：

- `BOOK_MANIFEST.json` / `PUBLISH_READY.json` / sidecars 完整存在。
- `artifact-metadata.json` 与 `runtime-compatibility.json` 已进入 required
  artifact 闭包，并被 validator 与 runtime query gate 同时强制校验。
- 真实包复制到临时 fresh vault 后，可以重建 projection，得到 1 个
  `graph_query` capability，并把查询 scope 限定在该书包的
  `graphrag/output`。
- 缺 `PUBLISH_READY`、缺 `graphrag/runs`、混入 provider payload、缺失或
  标记为 incompatible 的 `runtime-compatibility.json` 均会 fail closed。

但当前实现仍未达到该 Agent 固定 10 维度基准的完整通过（full pass）：

- `executable_contract_tests` 维度当前为 `fail`。`test/graphrag-book-hotplug-catalog.test.ts`
  的两个正向 hotplug capability 投影用例失败，说明“当前实现”与“契约测试夹具”
  至少有一侧已发生不一致。
- `artifact_gate_state_machine`、`producer_lineage_completeness`、
  `schema_runtime_compatibility`、`recovery_diagnostics` 仍为 `partial`。

## 审计边界

- 固定基线（baseline）沿用：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-1-fresh-vault/baseline.yaml`
- baseline SHA-256：
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`
- 未修改生产代码（production code）。
- 未修改 baseline / criteria。
- 未修改真实 `graph_vault`。
- 仅在临时目录（temporary vault）执行复制、删除、污染、兼容性破坏和 fake
  bridge 查询验证。

## 实测摘要

### 真实 backfill 产物（real backfill outputs）

真实 `graph_vault` 现状：

- `graph_vault/books` 目录总数：72
- 完整 hotplug package 数：38
- `validateBookHotplugPackage()`：38 / 38 通过
- `BOOK_MANIFEST.json`：38 / 38
- `PUBLISH_READY.json`：38 / 38
- manifest 与 publish sidecars：38 / 38
- `graphrag/output/artifact-metadata.json`：38 / 38
- `graphrag/output/runtime-compatibility.json`：38 / 38
- `state/hotplug-quality-gate.json`：38 / 38
- `state/hotplug-runtime-gate.json`：38 / 38
- `copyDistributionAllowed: true`：38 / 38
- manifest `graphrag.queryReady: true`：30
- manifest `graphrag.queryReady: false`：8
- runtime gate `currentState: query_ready`：30
- runtime gate `currentState: visible_not_query_ready`：8

抽样 query-ready 包：
`graph_vault/books/book-00474fb29e5e-59d02d41`

关键事实：

- `graphrag.requiredArtifacts` 共 13 项，已包含
  `artifact-metadata.json` 与 `runtime-compatibility.json`。
- `artifact-metadata.json` 的 `artifactCount` / `rows.length` 为 12。
  该文件自我条目（self row）被实现显式排除，其他 required artifacts 均有 row。
- `runtime-compatibility.json` 包含 package schema、layout schema、
  qmd index schema、GraphRAG artifact schema、artifact schema、
  runtime tool version、minimum version 以及 schema digests。
- `state/hotplug-runtime-gate.json` 已落盘
  `copied -> candidate -> validated -> mounted -> query_ready` 状态转移。

抽样 non-query-ready 包：
`graph_vault/books/book-0c8dffd9585c-41a7e47b`

关键事实：

- `state/hotplug-runtime-gate.json.currentState` 为
  `visible_not_query_ready`。
- `state/hotplug-quality-gate.json.status` 为 `passed`，
  `queryReady` 为 `false`，
  `graphRagReadyState` 为 `producer_lineage_missing`。

### 临时 fresh-vault 单书复制闭环（single-book copy mount closure）

样本包：
`book-00474fb29e5e-59d02d41`

正向验证结果：

- 复制真实包到临时 `graph_vault/books/` 后，
  `validateBookHotplugPackage()` 通过。
- `loadGraphQueryCapabilities({ bookIds: [sampleBookId] })`
  返回 1 个 `graph_query` capability。
- capability `artifactIds` 数量为 9，匹配 query-ready lineage 投影所需的
  producer artifacts。
- `resolveBookGraphRagDataDir()` 解析到该书自己的
  `books/{bookId}/graphrag/output`。
- 通过 fake Python bridge 调用 `createQmdGraphRagRuntime().graphQuery()`，
  返回 1 条 evidence，`evidence.bookId` 等于复制书的 `bookId`，
  `dataDir` 也指向复制书包的 `graphrag/output`。

这证明：

- 挂载扫描后可以仅凭包内 manifest、artifacts、producer evidence 和
  projection 重建单书 GraphRAG 查询上下文。
- 查询 scope 没有混入 sibling roots 或其他书包。

### 负向 gate（fail closed）

同一真实样本包在临时 fresh vault 中验证如下：

1. 删除 `PUBLISH_READY.json`
   - validator diagnostics：`missing_publish_marker`
   - `loadGraphQueryCapabilities()`：0

2. 删除 `graphrag/runs/`
   - validator diagnostics 包含多条
     `missing_required_file:graphrag/runs/...`
   - `loadGraphQueryCapabilities()`：0

3. 新增 `provider-requests/payload.json`
   - validator diagnostics：
     `forbidden_sensitive_material:provider-requests/payload.json`
   - `loadGraphQueryCapabilities()`：0

4. 删除 `graphrag/output/runtime-compatibility.json`
   - validator diagnostics：`runtime_compatibility_missing`
   - `loadGraphQueryCapabilities()`：0

5. 以 durable 写法把
   `graphrag/output/runtime-compatibility.json.compatibilityStatus`
   改为 `incompatible`
   - validator diagnostics：`runtime_compatibility_not_compatible`
   - `loadGraphQueryCapabilities()`：0

## 自动化测试（automated tests）

通过：

- `npm exec -- tsc -p tsconfig.build.json --noEmit`
- `npx vitest run test/unified-query.test.ts --testTimeout 120000`
  - 36 / 36 通过

失败：

- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000`
  - 6 / 8 通过，2 个失败
  - 失败用例：
    - `rebuilds graph capability catalog from BOOK_MANIFEST package`
    - `rebuilds stale catalog projection from current package manifests`
- 定向复跑
  `npx vitest run test/graphrag-book-hotplug-catalog.test.ts -t "rebuilds graph capability catalog from BOOK_MANIFEST package" --reporter verbose --testTimeout 120000`
  - `validateHotplugRuntimeQueryGate({ graphVault, bookId })` 输出为
    `{ ok: true, diagnostics: [], producerRunIds: [...] }`
  - 但 `loadGraphQueryCapabilities()` 仍返回 `[]`
- `npx vitest run test/cli-graphrag-route.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - 8 / 9 通过，1 个失败
  - 失败用例：
    `qmd query --graphrag non-json formats project unified evidence`
  - 表现为 30 秒超时，并伴随 `ENOTEMPTY` 清理错误

推断（inference）：
`validateHotplugRuntimeQueryGate()` 已放行，但正向 hotplug capability
测试仍返回空 capability，说明丢失发生在 runtime gate 之后，更可能位于
`projectQueryReadyLineage()`、checkpoint/artifact validation 或 capability
projection 路径，而不是 manifest / publish marker / forbidden payload 的前置 gate。

## 10 维度判定

| ID | 维度 | 判定 | 依据 |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 直接查询入口 | `pass` | 真实单书包复制到 fresh vault 后，validator 通过，`loadGraphQueryCapabilities()` 返回 1 个 capability，fake bridge 查询返回该书 scoped evidence。 |
| `artifact_minimum_closure` | 查询 Artifact 最低闭包 | `pass` | 38 / 38 真实包同时具备 manifest、publish marker、artifact metadata、runtime compatibility 与 required artifacts；缺任一关键项会 fail closed。 |
| `artifact_gate_state_machine` | Artifact Gate 状态机 | `partial` | 已有 `state/hotplug-runtime-gate.json`，真实包可观察到 `query_ready` 与 `visible_not_query_ready`；但接收端 fresh-vault 失败复制并不会自动重写 receiver-side gate state 为 `quarantined`，查询阻断主要依赖 validator 与 capability projection。 |
| `producer_lineage_completeness` | Producer Lineage 完整性 | `partial` | 缺失 `graphrag/runs` 会 fail closed；但真实样本 `artifact-metadata` 中存在 `producerToolVersion: "unknown"`，逐 artifact 的完整 tool version / upstream closure 仍不充分。 |
| `lineage_artifact_binding` | Lineage 与 Artifact 绑定 | `pass` | `producerRunIds`、`graphrag/runs`、state artifacts、artifact metadata 与 capability projection 已形成硬绑定；删 runs 后 capability 归零。 |
| `schema_runtime_compatibility` | Schema 与运行时兼容 | `partial` | `runtime-compatibility.json` 已成为 required artifact 与 runtime gate；删除或标记 `incompatible` 都会阻断查询。但 gate 仍只验证状态与 digest 存在性，没有把当前 runtime / embedding / LanceDB / parquet 的实值比较做完整矩阵化校验。 |
| `query_scope_isolation` | 单书查询范围隔离 | `pass` | 临时 fresh-vault 单书复制仅得到该书 1 个 capability；查询时 `dataDir` 解析到该书自己的 `graphrag/output`，fake bridge 只收到该书 scope。 |
| `privacy_payload_exclusion` | Provider Payload 排除 | `pass` | 新增 `provider-requests/payload.json` 会被 `forbidden_sensitive_material` 拒绝，且 capability 归零；查询不依赖 provider payload。 |
| `recovery_diagnostics` | 失败恢复与诊断 | `partial` | 已有稳定诊断码：`missing_publish_marker`、`missing_producer_run`、`forbidden_sensitive_material`、`runtime_compatibility_missing`、`runtime_compatibility_not_compatible`。但 receiver-side quarantine state、projection rollback 的持久化与统一可观测性仍不完整。 |
| `executable_contract_tests` | 可执行契约测试 | `fail` | `unified-query` 套件通过，但当前 `graphrag-book-hotplug-catalog` 正向用例 2 个失败，`cli-graphrag-route` 也有 1 个超时失败；最新实现尚未达到“契约测试可完整执行并保持通过”的签核要求。 |

统计：

- `pass`: 5
- `partial`: 4
- `fail`: 1

## Blocking Findings

### BF-01 正向 hotplug capability 契约测试回归（blocking）

当前代码库中，面向 fresh-vault 正向 capability 投影的关键契约测试失败：

- `test/graphrag-book-hotplug-catalog.test.ts`
  的两个正向用例失败。
- 定向复跑显示 `validateHotplugRuntimeQueryGate()` 已返回 `ok: true`，
  但 `loadGraphQueryCapabilities()` 仍为空。

这意味着：

- 真实 backfill 包路径当前可工作；
- 但“当前实现”的 hotplug capability 投影逻辑与其契约测试夹具已经不一致；
- 因而不能给出 `executable_contract_tests` 维度的通过结论，也不能给出
  Agent 1 的 full pass 签核。

## Residual Risks

1. `runtime-compatibility.json` 目前更像 gate marker（门控标记 / gate marker），
   尚不是对当前 runtime / parquet / LanceDB / embedding compatibility 的完整
   实值对比（value comparison）。
2. `artifact-metadata.json` 的 per-artifact provenance 已覆盖
   `producerRunId`、`producerStep`、`producerSchemaVersion`、
   `upstreamArtifactHashes`，但真实样本仍出现 `producerToolVersion: "unknown"`。
3. receiver-side 失败复制时，阻断是有效的，但 `state/hotplug-runtime-gate.json`
   不会在接收端自动重写为新的 `quarantined` 状态，因此持久化状态与即时 gate
   结果仍可能短暂分离。
4. CLI GraphRAG 非 JSON 输出路径仍有超时 / 清理残留风险。

## Commands

```bash
shasum -a 256 \
  audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-1-fresh-vault/baseline.yaml

npm exec -- tsc -p tsconfig.build.json --noEmit

npx vitest run test/unified-query.test.ts --testTimeout 120000

npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000

npx vitest run test/graphrag-book-hotplug-catalog.test.ts \
  -t "rebuilds graph capability catalog from BOOK_MANIFEST package" \
  --reporter verbose \
  --testTimeout 120000

npx vitest run test/cli-graphrag-route.test.ts \
  --testTimeout 120000 \
  --pool forks \
  --poolOptions.forks.singleFork=true

node --input-type=module <<'EOF'
# real vault inventory / validator scan / gate-state scan
EOF

node --import tsx --input-type=module <<'EOF'
# positive fresh-vault copy mount + fake bridge query closure
EOF

node --import tsx --input-type=module <<'EOF'
# negative fresh-vault gate checks:
# missing PUBLISH_READY / missing runs / provider payload / missing runtime-compat
EOF

node --import tsx --input-type=module <<'EOF'
# durable rewrite: runtime-compatibility => incompatible
EOF
```
