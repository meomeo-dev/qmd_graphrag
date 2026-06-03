# GraphRAG 单本书热插拔实现审计 R11 报告

## 审计范围

- agent: `agent-1-fresh-vault`
- scenario: fresh vault / 创建期质量门 / 首次挂载 / copy-install
- baseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r11__open/agent-1-fresh-vault/fixed-baseline.yaml`
- baselineSha256:
  `94a81f0a1b22a3837b481d515d3a6f2c5a8365e2c6e007176ac6a7bdbcfe8f3c`
- baselinePolicy:
  严格复用 R6 Agent 1 固定 10 基准（fixed ten baselines），未新增、
  删除、改名或重排。
- auditedFiles:
  - `docs/architecture/graphrag-book-hotplug-package.README.md`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
  - `scripts/graphrag/book-hotplug-creation-identity.mjs`
  - `scripts/graphrag/batch-epub-workflow.mjs`
  - `scripts/graphrag/backfill-hotplug-packages.mjs`
  - `scripts/graphrag/book-hotplug-package.mjs`
  - `scripts/graphrag/book-hotplug-quality-gate.mjs`
  - `src/graphrag/book-hotplug-catalog.ts`
  - `src/graphrag/book-hotplug-runtime-gate.ts`
  - `src/graphrag/capability-catalog.ts`
  - `test/graphrag-book-hotplug-creation-gate.test.ts`
  - `test/graphrag-book-hotplug-backfill.test.ts`
  - `test/graphrag-book-hotplug-catalog.test.ts`
  - `test/graphrag-book-hotplug-qmd-projection.test.ts`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts`
  - `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`

## 总体结论

- overallStatus: `partial`
- baselineCount: `10`
- passed: `7`
- partial: `3`
- failed: `0`

实现已经闭合了本轮用户重点中的三条主链：

1. 创建完成前会自动生成或刷新
   `graphrag/output/qmd_graph_text_unit_identity.json` 及其 sidecars，
   且缺失时会 fail closed。
2. 新书发布在 `BOOK_MANIFEST.json` live write 前已经过
   `pre_publish_source_truth` 与 candidate validation；在
   `PUBLISH_READY.json` 写入前已经写出质量门（quality gate）和运行时门
   （runtime gate）证据。
3. `backfill --only-missing` 的“已完成书恢复跳过”路径会先验证现有包，
   再只刷新 gate 证据，不重跑 qmd/GraphRAG，也不改写现有
   `BOOK_MANIFEST.json` / `PUBLISH_READY.json`。

但 fresh-vault 视角仍有两类未闭合风险：

1. catalog / qmd projection 的挂载入口没有复用
   `validateBookHotplugPackage`。只要 `BOOK_MANIFEST.json` 与
   `PUBLISH_READY.json` 存在且 manifest schema 可解析，书就会进入
   `books.yaml`、`sources.yaml`、`document-identity-map.yaml` 和
   `qmd-projection.yaml`。这与合同要求的“校验通过后才 mount / project”
   不一致。
2. manifest-first runtime query gate 只检查 manifest sidecar 是否存在，
   不校验 sidecar 内容，也不校验 `PUBLISH_READY.json.manifestSha256`
   与 manifest 当前内容是否一致。结果是 direct query readiness 与
   package validator 的 fail-closed 边界仍然分裂。

## 用户重点结论

### 1. `qmd_graph_text_unit_identity.json` 是否自动生成/刷新

结论：`pass`

- GraphRAG producer 在 query-ready 路径会先从 Parquet 读取并校验
  `graphDocumentId` / `graphTextUnitIds`，然后把结果写回 repo 与
  output sidecar：
  `src/job-state/graphrag-book.ts:942-977`。
- 创建发布前，runner 会再次执行
  `ensureBookCreationGraphTextUnitIdentity(...)`：
  `scripts/graphrag/batch-epub-workflow.mjs:10188-10203`。
- 该函数会在以下候选中恢复一致 identity，然后强制把规范化结果写入
  `graphrag/output/qmd_graph_text_unit_identity.json` 与 sidecars：
  `scripts/graphrag/book-hotplug-creation-identity.mjs:214-242`。
- 若 expected identity 无法构造，或所有候选都无法满足
  `graphDocumentId` / `graphTextUnitIds` 非空约束，则直接抛错：
  `scripts/graphrag/book-hotplug-creation-identity.mjs:220-233`。

### 2. 是否在 `BOOK_MANIFEST` / `PUBLISH_READY` 之前经过质量门

结论：`pass（有边界说明）`

- 设计合同要求：
  - `pre_publish_source_truth` 失败时不得生成 live-root manifest：
    `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:755-760`
  - candidate validation 必须先通过，再允许 live publish：
    `...final-contracts...:761-769`
  - post-live validation 失败必须移除 `PUBLISH_READY.json`：
    `...final-contracts...:770-790`
- 实现链路：
  - 先跑 `prePublishHotplugQualityGate(...)`：
    `scripts/graphrag/batch-epub-workflow.mjs:10235-10249`
  - 再对 candidate root 跑
    `validateHotplugPackagePublishCandidate(...)`：
    `scripts/graphrag/batch-epub-workflow.mjs:10250-10289`
  - 只有 candidate 通过后才写 live
    `BOOK_MANIFEST.json`：
    `scripts/graphrag/batch-epub-workflow.mjs:10291-10294`
  - gate 证据先写，`PUBLISH_READY.json` 后写：
    `scripts/graphrag/batch-epub-workflow.mjs:10318-10330`
  - 写完 publish marker 后还会再跑一次 live validation，失败则移除：
    `scripts/graphrag/batch-epub-workflow.mjs:10331-10358`

边界说明：

- `BOOK_MANIFEST.json` 本身是在 source-truth gate 和 candidate gate 通过后
  写入 live root，而不是在所有 post-live gate 完成后才首次出现。
- `PUBLISH_READY.json` 则明确晚于 gate 证据落盘，符合“publish marker
  才是可见性屏障（visibility barrier）”的合同意图。

### 3. 已完成书恢复跳过时是否刷新 package gate 而不重跑

结论：`partial`

- `backfill --only-missing` 路径符合要求：
  - 仅当现有 package 通过 `validateBookHotplugPackage` 才允许 skip：
    `scripts/graphrag/backfill-hotplug-packages.mjs:320-377`
  - 只刷新 `state/hotplug-quality-gate.json` 与
    `state/hotplug-runtime-gate.json`：
    `scripts/graphrag/backfill-hotplug-packages.mjs:191-214`
  - 测试证明 skip 后 manifest/publishReady 内容保持不变：
    `test/graphrag-book-hotplug-backfill.test.ts:223-299`
- 但 batch resume 中遇到 `checkpoint.status === "completed"` 时，当前实现会
  重新执行 `writeBookDistributionManifest(...)` 与
  `writeBookHotplugPackage(...)`：
  `scripts/graphrag/batch-epub-workflow.mjs:14107-14116`
- 这条路径不会重跑 qmd / GraphRAG producer，但会重新生成
  `BOOK_MANIFEST.json` / `PUBLISH_READY.json`。由于未复用现有
  `packageGeneration`，存在 completed-skip 触发 package generation
  churn 的风险。

## 逐项判定

| # | baselineId | status | 判定摘要 |
|---|---|---|---|
| 1 | `direct_query_entrypoint` | pass | manifest-first 直接查询入口已成立；删除全局 catalog 后仍可从书包推导 GraphRAG capability。主要证据：`src/graphrag/book-hotplug-runtime-gate.ts:467-525`、`src/graphrag/capability-catalog.ts:513-540`、`test/graphrag-book-hotplug-runtime-gate.test.ts:247-275`。 |
| 2 | `artifact_minimum_closure` | pass | `buildBookHotplugPackage` 明确列出 required GraphRAG artifacts、file role、bytes、sha256、required，并在缺失任一必需 artifact 时 fail closed。主要证据：`scripts/graphrag/book-hotplug-package.mjs:21-40, 348-441, 716-940`。 |
| 3 | `artifact_gate_state_machine` | partial | 创建 / backfill / runtime gate 均有 `copied -> candidate -> validated -> mounted -> query_ready / visible_not_query_ready / quarantined` 证据文件，但 fresh-vault catalog/qmd projection 未复用完整 package validator，导致无效 copied package 仍可能被投影为 mounted book/qmd item。主要证据：`scripts/graphrag/book-hotplug-quality-gate.mjs:57-155` 对比 `src/graphrag/book-hotplug-catalog.ts:158-181, 354-519`。 |
| 4 | `producer_lineage_completeness` | pass | artifact metadata 与 producer run 绑定包含 run、step、tool version、schema version、stage fingerprint、provider fingerprint、upstream hashes、createdAt；缺失时运行时门与包验证都 fail closed。主要证据：`scripts/graphrag/book-hotplug-artifact-metadata.mjs:108-176, 203-260`、`src/graphrag/book-hotplug-runtime-gate.ts:243-348`、`test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:221-362`。 |
| 5 | `lineage_artifact_binding` | pass | `validateHotplugProducerRunBindings` 会验证 manifest `producerRunIds`、run 文件、artifactIds、stage/provider fingerprints 的一致性。主要证据：`scripts/graphrag/book-hotplug-producer-run-bindings.mjs:102-194`、`src/graphrag/book-hotplug-runtime-gate.ts:341-347`、`test/graphrag-book-hotplug-runtime-gate.test.ts:435-590`。 |
| 6 | `schema_runtime_compatibility` | pass | package schema、layout、qmd schema、GraphRAG artifact schema、provider fingerprint、embedding dimension 与语义 digest 均有独立 runtime-compatibility 合同和校验。主要证据：`scripts/graphrag/book-hotplug-runtime-compatibility.mjs:53-220`、`src/graphrag/book-hotplug-runtime-gate.ts:350-464`、`test/graphrag-book-hotplug-runtime-gate.test.ts:277-354`。 |
| 7 | `query_scope_isolation` | pass | query capability 只有在 book-scoped runtime gate 通过后才会从单书包中推导，且缺少 producer runs / metadata 时不会提升为 query-ready。主要证据：`src/graphrag/capability-catalog.ts:513-540`、`src/graphrag/book-hotplug-runtime-gate.ts:467-525`、`test/graphrag-book-hotplug-catalog.test.ts:749-852`。 |
| 8 | `privacy_payload_exclusion` | pass | package validator 与 runtime gate 都会把 `provider-requests/`, `provider-responses/`, `.env`, logs 等判为 forbidden，且实现不需要读取 provider payload 即可完成 gate。主要证据：`scripts/graphrag/book-hotplug-residue-quarantine.mjs:14-42`、`scripts/graphrag/book-hotplug-package.mjs:42-61, 718-724`、`src/graphrag/book-hotplug-runtime-gate.ts:481-483`。 |
| 9 | `recovery_diagnostics` | partial | 创建 / backfill 失败时有稳定 gate diagnostics，`PUBLISH_READY` 也会回滚；但 fresh-vault catalog rebuild 对 copied invalid package 缺少 failed/quarantine 分支，无法满足“invalid copy 不 mount、不 project”的完整恢复闭环。主要证据：`scripts/graphrag/backfill-hotplug-packages.mjs:396-421` 对比 `src/graphrag/book-hotplug-catalog.ts:158-181, 354-519`。 |
| 10 | `executable_contract_tests` | partial | 已有 creation/backfill/runtime/catalog/qmd projection/hardening 测试覆盖面较强，但仍缺失两个关键契约测试：`loadProjectedBooks` 对无效 copied package fail-closed，以及 runtime query gate 对 manifest sidecar mismatch 的 fail-closed。 |

## 关键发现

### Finding 1

- severity: `high`
- baselineId: `artifact_gate_state_machine`
- summary:
  fresh-vault catalog / qmd projection 的挂载入口没有复用
  `validateBookHotplugPackage`。`loadBookManifest()` 只要求
  `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json` 存在且 manifest schema 可解析，
  然后 `rebuildCatalogFromBookHotplugPackages()` 就把该书投影到
  `books.yaml`、`sources.yaml`、`document-identity-map.yaml` 与
  `qmd-projection.yaml`。这与合同要求的“校验通过前 copied package 不得
  mounted / projected”不一致。
- recommendation:
  在 `src/graphrag/book-hotplug-catalog.ts` 的 `loadProjectedBooks()` /
  `loadBookManifest()` 入口复用 `validateBookHotplugPackage` 或等价完整 gate，
  并为 invalid candidate 产出 failed/quarantine diagnostics，而不是静默投影。

证据：

- 合同要求 copied package 必须在 checksum / publish marker 校验通过后才可见：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:232-235, 261-269, 274-277, 327-335`
- 合同要求 existing / copied package 先过 validation，再决定 projection：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:776-807, 1126-1163`
- 实现仅做存在性与 schema parse：
  `src/graphrag/book-hotplug-catalog.ts:158-181`
- 随后直接写入 catalog/qmd projection：
  `src/graphrag/book-hotplug-catalog.ts:354-519`

### Finding 2

- severity: `medium`
- baselineId: `recovery_diagnostics`
- summary:
  manifest-first runtime query gate 没有校验 manifest checksum sidecar 内容，
  也没有校验 `PUBLISH_READY.json.manifestSha256` 是否仍与当前 manifest 一致。
  代码只检查 sidecar / publish marker 是否存在；而 capability catalog
  又直接以 `validateHotplugRuntimeQueryGate().ok` 作为 query-ready 入口。
  结果是 direct query gate 与 `validateBookHotplugPackage` 的 fail-closed
  边界不一致。
- recommendation:
  在 `src/graphrag/book-hotplug-runtime-gate.ts` 中补齐：
  - `BOOK_MANIFEST.json.sha256` 内容比对
  - `BOOK_MANIFEST.json.sha256.meta.json` 存在与最小一致性校验
  - `PUBLISH_READY.json.manifestSha256` 与当前 manifest digest 比对
  同时增加专门测试覆盖 stale sidecar / stale publish marker。

证据：

- 合同要求 manifest-first resolver 的 resolution order 第一步就是
  “validate manifest checksum sidecars”：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1040-1050`
- runtime gate 目前只检查 sidecar / publish marker 存在性：
  `src/graphrag/book-hotplug-runtime-gate.ts:484-489`
- capability catalog 直接信任 runtime gate：
  `src/graphrag/capability-catalog.ts:517-518`
- 对照实现，完整 package validator 已经能抓到
  `manifest_sha256_mismatch`：
  `scripts/graphrag/book-hotplug-package.mjs:733-784`
  以及测试：
  `test/graphrag-book-hotplug-backfill.test.ts:278-299`

### Finding 3

- severity: `medium`
- baselineId: `executable_contract_tests`
- summary:
  现有自动化测试覆盖了 creation gate、backfill、runtime hardening、
  catalog、qmd projection 和 manifest-first query，但尚未覆盖本轮发现的
  两个回归面：invalid copied package 被 catalog/qmd projection 接纳，以及
  runtime query gate 对 stale manifest sidecar 的漏检。
- recommendation:
  新增两组测试：
  1. 构造存在 `BOOK_MANIFEST.json` / `PUBLISH_READY.json` 但 sidecar 错误或
     required artifact 缺失的 copied package，验证 catalog 与 qmd projection
     不得写入该书。
  2. 构造 stale `BOOK_MANIFEST.json.sha256` 或 stale
     `PUBLISH_READY.manifestSha256`，验证 `validateHotplugRuntimeQueryGate`
     与 `loadGraphQueryCapabilities` 都 fail closed。

## 实测证据

本轮独立复跑的目标测试套件：

- `test/graphrag-book-hotplug-creation-gate.test.ts`: `1/1` passed
- `test/graphrag-book-hotplug-backfill.test.ts`: `5/5` passed
- `test/graphrag-book-hotplug-runtime-gate.test.ts`: `6/6` passed
- `test/graphrag-book-hotplug-catalog.test.ts`: `9/9` passed
- `test/graphrag-book-hotplug-qmd-projection.test.ts`: `1/1` passed
- `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`: `3/3` passed

合计：`25/25` passed

引用的真实 vault 证据（用户已提供并与代码合同一致）：

- creation gate: passed
- backfill: passed
- runtime gate: passed
- catalog: passed
- qmd projection: passed
- runtime hardening: passed
- `tsc`: passed
- 真实 `backfill --only-missing`: passed
- 真实 vault valid hotplug packages: `38`
- historical residue not mounted: `34`

## 补充观察

以下观察与用户点名风险直接相关，但未单独改变固定 baseline 的计数：

1. `qmd_graph_text_unit_identity.json` 的 fresh-vault 首次创建能力本身已经闭合。
   其来源优先级是当前 hotplug output、legacy output、catalog identity map，
   测试环境可选 fallback；缺失时不会生成伪 identity。
2. `README` 中关于 `--only-missing` skip 刷新 gate 不改
   `packageGeneration` 的陈述，与 `backfill-hotplug-packages.mjs`
   的实现是一致的；但 `batch-epub-workflow.mjs` 的 completed-checkpoint
   skip 路径并未采用相同策略。
3. `BOOK_MANIFEST.files` 正确排除了
   `state/hotplug-quality-gate.json` 与
   `state/hotplug-runtime-gate.json`，因此 gate 刷新不会污染文件闭包：
   `scripts/graphrag/book-hotplug-package.mjs:373-404`，
   `test/graphrag-book-hotplug-creation-gate.test.ts:97-103`，
   `test/graphrag-book-hotplug-catalog.test.ts:682-693`。
