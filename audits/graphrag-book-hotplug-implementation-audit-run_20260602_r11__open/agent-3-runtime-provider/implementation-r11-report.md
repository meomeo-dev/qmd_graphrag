# GraphRAG 单本书热插拔实现审计 R11 报告

## 审计范围

- agent: `agent-3-runtime-provider`
- scenario: runtime / provider / direct query
- baseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r11__open/agent-3-runtime-provider/fixed-baseline.yaml`
- baselineSha256:
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`
- baselinePolicy: 严格复用固定 10 项基准，不新增、删除、改名或重排。
- auditMode: local implementation audit

## 总体结论

- overallStatus: `fail`
- baselineCount: `10`
- passed: `5`
- partial: `3`
- failed: `2`

本轮实现在 runtime compatibility、provider payload 排除、manifest-first
catalog 缺失直查、只读查询不写包内锁文件等主路径上保持可用；但仍存在两个
阻断性偏差（blocking deviations）：

1. `validateHotplugRuntimeQueryGate` 未校验 `BOOK_MANIFEST.json` 的
   `.sha256` 与 `.sha256.meta.json` 内容，只检查是否存在。篡改 manifest
   后不刷新 sidecar，runtime gate 仍返回 `ok=true`，且可继续投影
   `graph_query` capability。
2. 新的 creation identity fallback 在显式开启
   `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 的路径下，可生成 synthetic
   `qmd_graph_text_unit_identity.json`，并在其余 GraphRAG 产物齐全时进入
   manifest-first direct query capability。

## 重点结论

1. creation identity fallback 是否可能制造伪 `query_ready` 或污染
   direct query scope:
   结论为 `是（yes）`，但触发条件限于显式 test hook。复现中 synthetic
   `graphDocumentId` 和 `graphTextUnitIds` 被写入包内后，可导出
   `graph_query` capability。
2. runtime gate 是否仍 fail-closed 于 forged metadata / provider /
   stage / runtime compatibility:
   结论为 `部分成立（partial）`。对 `providerFingerprint`、
   `stageFingerprint`、producer run `artifactIds`、layout / embedding
   dimension / schema digest 的 forged case 均能 fail-closed；但对
   manifest sidecar stale / forged case 不能 fail-closed。
3. 只读 query 是否不写 package 内锁 / 缓存:
   结论为 `通过（pass）`。独立测试与代码路径均未在
   `graph_vault/books/{bookId}` 下写入 `.lock` 或 runtime cache。
4. provider payload 是否被排除:
   结论为 `通过（pass）`。package validator 与 runtime gate 均拒绝
   `provider-requests/**`、`provider-responses/**`、`.env`、logs /
   debug / trace 等敏感路径。
5. 复制单本书目录后 manifest-first resolver 是否仍可直接验证:
   结论为 `部分通过（partial）`。catalog 缺失时可直接验证并生成查询能力；
   但验证链未覆盖 manifest sidecar 内容一致性，故权威性
   （authoritativeness）仍不完整。

## 主要发现

### F1. Manifest sidecar stale 不会阻止 runtime query gate

- severity: `high`
- 主要关联基准:
  `artifact_gate_state_machine`,
  `recovery_diagnostics`

合同要求 manifest-first query validation 先校验 manifest checksum
sidecars，再决定 `query_ready` 或 `visible_not_query_ready`
（`docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1040-1051`,
`1087-1109`）。但实现中的 runtime gate 仅检查 sidecar 是否存在：

- `src/graphrag/book-hotplug-runtime-gate.ts:484-488`

它没有比较 `BOOK_MANIFEST.json` 与 `.sha256` 的实际摘要，也没有验证
`.sha256.meta.json` 是否对应当前 manifest。

最小复现结果：

- 先构造完整 query-ready hotplug package。
- 修改 `BOOK_MANIFEST.json.identity.canonicalTitle`。
- 保留旧的 `BOOK_MANIFEST.json.sha256` 与
  `BOOK_MANIFEST.json.sha256.meta.json` 不变。
- 调用 `validateHotplugRuntimeQueryGate` 与
  `loadGraphQueryCapabilities`。

复现输出：

```json
{
  "ok": true,
  "diagnostics": [],
  "capabilityCount": 1,
  "manifestSidecarStale": true
}
```

这说明 manifest 已被篡改但 gate 未报错，且 capability metadata 中已使用
篡改后的 `sourceName`。该行为违背了 fail-closed gate 与稳定诊断合同。

### F2. Creation identity fallback 可生成 synthetic identity 并进入直查能力

- severity: `medium`
- 主要关联基准:
  `producer_lineage_completeness`,
  `lineage_artifact_binding`

`ensureBookCreationGraphTextUnitIdentity` 在
`allowTestFallback === true` 时会生成 synthetic identity：

- `scripts/graphrag/book-hotplug-creation-identity.mjs:193-206`

batch workflow 将该开关绑定到环境变量：

- `scripts/graphrag/batch-epub-workflow.mjs:10188-10196`

当 `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 时，只要其余 GraphRAG artifacts、
producer runs、artifact metadata、runtime compatibility 都成立，synthetic
identity 会被 `buildBookHotplugPackage` 纳入 required artifact 闭包，并最终
通过 `loadGraphQueryCapabilities` 导出 `graph_query` capability。

最小复现结果：

```json
{
  "graphDocumentId": "graph-doc-doc-83e895b8f0af",
  "graphTextUnitIds": ["tu-775f41e83f32b816"],
  "capabilityCount": 1,
  "capabilityId": "book-fallback-full:graph_query"
}
```

这不是默认生产路径，但它证明 fallback 当前并非只做测试内观测
（observation）；它会改变包内 identity artifact，并可影响 direct query
scope 与 capability 投影。

### F3. 自动化测试未覆盖上述两类偏差

- severity: `medium`
- 主要关联基准:
  `executable_contract_tests`

本轮已运行的 runtime / catalog / creation tests 对 provider fingerprint、
stage fingerprint、artifact binding、runtime compatibility digest、只读无锁、
catalog 缺失直查等均有覆盖；但未见以下两类自动化用例：

1. `BOOK_MANIFEST.json` 内容与 sidecar 不一致时，runtime gate 与
   direct query capability 必须 fail-closed。
2. 在显式 test hook 开启时，synthetic identity 不得被当作 producer-backed
   query identity 投影为 `graph_query` capability。

## 10 项固定基准判定

| # | baselineId | status | 判定摘要 |
|---|---|---|---|
| 1 | `direct_query_entrypoint` | pass | manifest-first 直查已可在全局 catalog 缺失时，仅凭书包与包内 artifacts 生成 query capability。 |
| 2 | `artifact_minimum_closure` | pass | 文档明确最低 artifact 闭包；实现用 `RequiredGraphRagArtifacts`、file entries、artifact metadata 和 runtime compatibility 共同校验。 |
| 3 | `artifact_gate_state_machine` | fail | stale manifest sidecar 未被 gate 检出，tampered manifest 仍可被投影为 query-ready capability。 |
| 4 | `producer_lineage_completeness` | partial | 标准路径下 producer run / stage / provider / createdAt 绑定较完整；但 test-hook fallback 可为 required identity artifact 生成 synthetic lineage。 |
| 5 | `lineage_artifact_binding` | partial | 普通 GraphRAG output 绑定 producer run 较严格；但 fallback 生成的 identity artifact 以 `manifest-derived:*` 形式通过，不能证明其来自真实 producer。 |
| 6 | `schema_runtime_compatibility` | pass | package schema、layout、qmd schema、GraphRAG artifact schema、provider fingerprint、embedding dimension 与 semantic digests 均有 fail-closed 检查。 |
| 7 | `query_scope_isolation` | pass | `validateBookArtifactSet` 要求 book-scoped graph output，并校验 producer run / stage / provider / corpus hash，不混入 sibling roots 或其他书 artifacts。 |
| 8 | `privacy_payload_exclusion` | pass | forbidden path 扫描和 package validation 会拒绝 provider payload、`.env`、logs / debug / trace；查询 gate 不需要 provider roots。 |
| 9 | `recovery_diagnostics` | fail | manifest sidecar checksum mismatch 在 runtime gate 上既无稳定诊断，也无 `visible_not_query_ready` 或 quarantine 回滚。 |
| 10 | `executable_contract_tests` | partial | 现有测试覆盖面较广，但缺少 manifest sidecar stale fail-closed 与 synthetic identity containment 两类契约用例。 |

## 独立证据

### 代码与合同

- manifest-first readonly / validation order:
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1040-1077`
- direct query cache mismatch 与 required tests:
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1087-1109`
- GraphRAG artifact gate state machine:
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1110-1217`
- runtime gate sidecar existence only:
  `src/graphrag/book-hotplug-runtime-gate.ts:477-489`
- runtime gate artifact metadata / producer binding / compatibility checks:
  `src/graphrag/book-hotplug-runtime-gate.ts:243-465`
- producer lineage binding:
  `src/graphrag/book-hotplug-producer-run-bindings.ts:104-205`
- manifest-first capability derivation:
  `src/graphrag/capability-catalog.ts:513-628`,
  `736-830`,
  `891-897`
- creation fallback:
  `scripts/graphrag/book-hotplug-creation-identity.mjs:193-206`
- test hook wiring:
  `scripts/graphrag/batch-epub-workflow.mjs:10188-10196`

### 独立测试执行

执行命令：

```sh
npx vitest run \
  test/graphrag-book-hotplug-runtime-gate.test.ts \
  test/graphrag-book-hotplug-runtime-gate-hardening.test.ts \
  test/graphrag-book-hotplug-catalog.test.ts \
  test/graphrag-book-hotplug-creation-gate.test.ts
```

结果：

- `test/graphrag-book-hotplug-runtime-gate.test.ts`: `6/6` passed
- `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`: `3/3` passed
- `test/graphrag-book-hotplug-catalog.test.ts`: `9/9` passed
- `test/graphrag-book-hotplug-creation-gate.test.ts`: `1/1` passed

说明：现有测试能够证明主路径行为稳定，但未覆盖 F1 / F2。

### 最小复现

1. stale manifest sidecar 复现：
   runtime gate 返回 `ok=true`、`diagnostics=[]`，同时
   `loadGraphQueryCapabilities` 返回 `1` 个 capability。
2. synthetic identity fallback 复现：
   `allowTestFallback: true` 生成 synthetic
   `graphDocumentId` / `graphTextUnitIds`，并导出 `1` 个
   `graph_query` capability。

## 审计结论

R11 runtime/provider/direct-query 视角下，hotplug package 的主链路已经基本
成形，但尚未满足固定基准要求的完整 fail-closed 行为。当前最需要修复的是
manifest sidecar 内容校验缺失；其次是将 creation identity fallback 严格限制
为非可发布、非可查询路径，避免 synthetic identity 进入 direct query
capability。
