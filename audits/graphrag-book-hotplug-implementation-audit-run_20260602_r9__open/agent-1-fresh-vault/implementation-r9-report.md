# R9 实施审计报告：Agent 1 Fresh-Vault 场景

## 审计结论

- 审计状态：partial
- 固定基准：逐字复用
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-1-fresh-vault/fixed-baseline.yaml`
- 通过数：7
- 部分通过数：3
- 未通过数：0

当前实现已经满足 fresh vault 场景中大部分包内闭包
(package-local closure)、只读挂载
(readonly mount)、catalog projection 重建、copy-delete hotplug
基础质量门与 producer lineage 绑定要求。R8 中重点要求复核的
`producer_lineage_completeness` 与 readonly package `.lock`
问题，当前实现已具备明确的 fail-closed 校验与自动化测试证据。

仍未完全收敛的部分有三项：

1. `direct_query_entrypoint` 仍不是纯 manifest-first resolver，因为
   `projectQueryReadyLineage()` 在 runtime gate 通过后仍依赖
   `catalog/books.yaml`、`artifacts.yaml`、`checkpoints.yaml`
   来构造最终 query capability。
2. `artifact_gate_state_machine` 已有 candidate validation、publish marker、
   live validation 与 marker removal，但发布仍是在 live root 中写入
   manifest/publish marker，不是合同要求的 staging-root 到 live-root
   目录级原子 rename。
3. `recovery_diagnostics` 已有稳定诊断与 publish marker 回滚，但缺少
   “保留上一代 live root 并在中断发布后恢复”的完整目录代际回滚证据。

## 基准逐项结果

| baselineId | 结果 | 证据路径 | 残余风险 |
| --- | --- | --- | --- |
| direct_query_entrypoint | partial | `src/graphrag/book-hotplug-runtime-gate.ts:350`, `src/graphrag/capability-catalog.ts:474`, `src/graphrag/capability-catalog.ts:480`, `src/graphrag/capability-catalog.ts:492`, `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:944` | direct query readiness 仍依赖 catalog/books.yaml 与 book state 投影；若投影损坏且无法重建，manifest-first 只读校验虽可通过，但 capability 生成仍可能失败。 |
| artifact_minimum_closure | pass | `scripts/graphrag/book-hotplug-package.mjs:40`, `scripts/graphrag/book-hotplug-package.mjs:635`, `src/graphrag/book-hotplug-runtime-gate.ts:206`, `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1614` | 文件闭包已明确，但依然假设构建端会持续正确生成这些 artifact。 |
| artifact_gate_state_machine | partial | `scripts/graphrag/book-hotplug-publish-gate.mjs:27`, `scripts/graphrag/batch-epub-workflow.mjs:10188`, `scripts/graphrag/batch-epub-workflow.mjs:10220`, `scripts/graphrag/batch-epub-workflow.mjs:10258`, `scripts/graphrag/backfill-hotplug-packages.mjs:180`, `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:198` | 候选校验与 live validation 存在，但缺少 staging directory 完成后一次性 rename；中间写入窗口仍依赖 publish marker 隐藏，而不是目录代际隔离。 |
| producer_lineage_completeness | pass | `src/graphrag/book-hotplug-runtime-gate.ts:300`, `src/graphrag/book-hotplug-producer-run-bindings.ts:104`, `src/contracts/book-job.ts:167`, `test/graphrag-book-hotplug-runtime-gate.test.ts:302`, `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:204`, `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:983` | 合同要求中的 producer run、step、input hash、status、createdAt、upstream hashes 已有约束；但上游 artifact hash 是否“语义完整”仍依赖 metadata 生产端一致性。 |
| lineage_artifact_binding | pass | `src/graphrag/book-hotplug-producer-run-bindings.ts:158`, `test/graphrag-book-hotplug-runtime-gate.test.ts:356`, `test/graphrag-book-hotplug-runtime-gate.test.ts:439`, `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:983` | durable output refresh 例外路径已建模，但后续若引入新共享 artifact 类型，需要同步扩展 refresh binding 规则。 |
| schema_runtime_compatibility | pass | `src/graphrag/book-hotplug-runtime-gate.ts:350`, `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:66`, `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:143`, `test/graphrag-book-hotplug-runtime-gate.test.ts:221`, `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:316`, `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1648` | R8 的 partial 已收敛到合同要求范围：当前会 fail closed 校验 package schema、layout、qmd schema、GraphRAG artifact schema、min runtime、provider fingerprint、embedding dimension，以及 output/parquet/LanceDB/artifact metadata digests。未见 embedding model 独立字段，但当前合同实现以 runtime compatibility 输入与 digest 约束为主，证据充足。 |
| query_scope_isolation | pass | `src/graphrag/capability-catalog.ts:401`, `src/graphrag/capability-catalog.ts:715`, `src/graphrag/capability-catalog.ts:775`, `test/graphrag-capability-scope.test.ts:83`, `test/graphrag-capability-scope.test.ts:113` | query capability 仍以 catalog projection 为缓存入口，但 scope 过滤与按书验证已阻断无关书籍污染进入结果。 |
| privacy_payload_exclusion | pass | `src/graphrag/book-hotplug-runtime-gate.ts:104`, `scripts/graphrag/book-hotplug-package.mjs:721`, `test/graphrag-book-hotplug-catalog.test.ts:573`, `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:293` | 禁止项覆盖 provider payload、logs、debug、`.lock` 等；但未来若新增新的敏感目录命名约定，需要同步维护 denylist。 |
| recovery_diagnostics | partial | `scripts/graphrag/batch-epub-workflow.mjs:10259`, `scripts/graphrag/batch-epub-workflow.mjs:10261`, `scripts/graphrag/backfill-hotplug-packages.mjs:356`, `scripts/graphrag/backfill-hotplug-packages.mjs:360`, `test/graphrag-book-hotplug-backfill.test.ts:169` | 当前恢复策略主要是移除 publish marker、保留已有 manifest、不重写已验证包；但缺少对“已替换 live root 前的上一个 generation”进行显式保留和恢复的合同级实现证据。 |
| executable_contract_tests | pass | `test/graphrag-book-hotplug-runtime-gate.test.ts:221`, `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:204`, `test/graphrag-book-hotplug-catalog.test.ts:136`, `test/graphrag-book-hotplug-catalog.test.ts:623`, `test/graphrag-book-hotplug-catalog.test.ts:732`, `test/graphrag-book-hotplug-backfill.test.ts:128`, `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1686` | 当前固定矩阵已覆盖缺 artifact metadata、forged lineage、schema/runtime mismatch、provider payload 排除、跨书 scope、冲突 backfill、readonly package `.lock` 不写入。尚未覆盖 staged import rollback，但对本 Agent 基准所关注的 fresh-vault/query gate 主合同已足够具体且可执行。 |

## R8 Partial 收敛复核

### 1. `schema_runtime_compatibility`

R8 判为 `partial` 的核心理由是 runtime compatibility 未完全作为独立
fail-closed 条件落地。当前实现已收敛到 `pass`：

- `validateRuntimeCompatibility()` 明确校验
  `packageSchemaVersion`、`layoutVersion`、`qmdIndexSchema`、
  `graphRagArtifactSchema`、`artifactSchema`、
  `minQmdGraphRagVersion`、`providerFingerprint`、
  `embeddingVectorDimension`
  [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:350)。
- schema digests 对
  output manifest、parquet、LanceDB、artifact metadata
  全部做 fail-closed 比对
  [src/graphrag/book-hotplug-runtime-compatibility-digests.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-compatibility-digests.ts:66)。
- 负例测试覆盖 forged semantic digest、layout mismatch、embedding
  dimension mismatch
  [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:221)
  与
  [test/graphrag-book-hotplug-runtime-gate-hardening.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate-hardening.test.ts:316)。

### 2. `producer_lineage_completeness`

R8 已给出 `pass`，本轮重点复核其是否真正满足最终合同：

- artifact metadata 行要求
  `producerRunId`、`producerStep`、`producerToolVersion`、
  `producerSchemaVersion`、`upstreamArtifactHashes`、`createdAt`
  [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:74)。
- producer run record 要求
  `runId`、`bookId`、`stage`、`status`、`inputFingerprint`、`artifactIds`
  [src/contracts/book-job.ts](/Users/jin/projects/qmd_graphrag/src/contracts/book-job.ts:167)。
- runtime gate 对缺失 run、book mismatch、status 非 `succeeded`、
  artifactIds forged、stageFingerprint/providerFingerprint forged
  全部 fail closed
  [src/graphrag/book-hotplug-producer-run-bindings.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-producer-run-bindings.ts:104)。

结论：当前实现已满足本基准要求。

### 3. readonly package `.lock` 是否已关闭

R8 要求重点复核 readonly package 下 `.lock` 残留或运行时写入问题。
当前可判定为已关闭：

- runtime gate 使用只读文件读取，不创建 durable 锁文件
  [src/graphrag/book-hotplug-package-readonly.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-package-readonly.ts:1)。
- forbidden path denylist 明确拒绝 `.lock`
  [src/graphrag/book-hotplug-runtime-gate.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/book-hotplug-runtime-gate.ts:104)。
- 自动化测试明确验证
  “validates query-ready package without writing runtime locks into package”
  [test/graphrag-book-hotplug-runtime-gate.test.ts](/Users/jin/projects/qmd_graphrag/test/graphrag-book-hotplug-runtime-gate.test.ts:221)。

结论：该项已收敛，不再保留 partial。

## 已执行验证

```bash
npm exec -- tsc -p tsconfig.build.json --noEmit
npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts test/graphrag-book-hotplug-runtime-gate-hardening.test.ts test/graphrag-book-hotplug-catalog.test.ts test/graphrag-book-hotplug-backfill.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true
```

结果：

- `tsc --noEmit`：通过。
- `test/graphrag-book-hotplug-runtime-gate.test.ts`：5/5 通过。
- `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`：3/3 通过。
- `test/graphrag-book-hotplug-catalog.test.ts`：8/8 通过。
- `test/graphrag-book-hotplug-backfill.test.ts`：3/3 通过。

## 总结

本轮 fresh vault 审计结论为 `partial`，但 R8 指定的三项重点中，
`schema_runtime_compatibility` 与 readonly package `.lock`
问题已收敛，`producer_lineage_completeness` 继续保持 `pass`。
剩余差距主要集中在“真正的 manifest-first direct query resolver”
以及“目录级原子发布与 generation rollback”两类发布路径合同，而不是
runtime gate、catalog projection 或 query-ready 语义本身。
