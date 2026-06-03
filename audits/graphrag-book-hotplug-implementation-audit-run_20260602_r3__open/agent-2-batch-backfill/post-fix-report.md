# Agent 2 修复后实施审计

## 范围

- Agent：`agent-2-batch-backfill`
- 场景（scenario）：当前 38 本完成书与 34 个历史残留目录迁移到
  热插拔布局。
- 固定基准（fixed baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-2-batch-backfill/baseline.yaml`
- 基准 SHA256：
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`
- 证据运行（evidence run）：
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602171023255`

本次审计复用固定 10 项基准，未新增、删除、重命名或改变任何基准。

## 结论

总体结果：`partial`。

前序 partial 项已有明显改善。源权威（source truth）、逐文件
copy-map 证据、manifest-diff 证据、残留分类，以及运行时敏感包测试
都已加强。仍保留 4 个 partial，原因是实现尚未完整证明强制重跑
身份稳定性、完整冲突矩阵、live-root 回滚 through staging，以及完整
迁移测试矩阵。

## 验证

- `npm exec -- tsc -p tsconfig.build.json --noEmit`：通过。
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`：
  7/7 通过。
- 真实 `graph_vault/books`：72 个目录。
- 含 `BOOK_MANIFEST.json` 的包：38。
- `validateBookHotplugPackage`：38/38 通过。
- `state/hotplug-quality-gate.json`：38/38 通过，且
  `copyDistributionAllowed=true`。
- `BOOK_MANIFEST.graphrag.queryReady`：30 个 true，8 个 false。
- Catalog 投影：`books.yaml` 38，`sources.yaml` 38，
  `document-identity-map.yaml` 38，`graph-capabilities.yaml` 30。
- 最新证据中 plan、classification、copy-map、manifest-diff、
  checkpoint、validation、commit-record、residue-report、book-conflicts
  的 sidecar 均存在，且 SHA256 与记录值匹配。

## 证据摘要

最新迁移证据 `hotplug-backfill-20260602171023255` 记录：

- `totalDirectories`：72
- `candidates`：38
- `residues`：34
- `alreadyMigrated`：38
- `residueQuarantined`：34
- `partialMigration`：0
- `failedInterrupted`：0
- `copy-map.yaml`：38 个包条目，70,493 个逐文件条目。
- `copy-map.yaml`：0 个 pending 文件条目。
- `manifest-diff.yaml`：38 个条目，全部
  `checksumRegenerated=true` 且 `decisionStatus=committed`。
- `residue-report.yaml`：34 个 residue，均不可 mount、不可 export。
- `book-conflicts.yaml`：34 个 default-applied source-hash-prefix 冲突记录。
- Quarantine 证据存在，覆盖 vault-root 中的 forbidden residues，
  包括 `.DS_Store` 与 `.durable-recovery.jsonl` 文件。

## 基准结果

### current_vs_residue_classification: pass

迁移证据已分类全部 72 个 book 目录。重新执行只读分类后结果稳定：
38 个 `already_migrated`，34 个 `residue_quarantined`，无未分类目录。
residue 诊断稳定，包含缺失 distribution manifest、qmd build manifest、
GraphRAG output manifest 或 artifact checksum evidence 等原因。

### migration_source_of_truth: pass

源权威门（source-truth gate）已经在 `validation.yaml` 中记录
distribution manifest sidecars、canonical input、source closure、
qmd build manifest、GraphRAG output manifest、producer lineage 与 artifact
checksums。缺失关键证据会阻止 `mayGenerateBookManifest`；producer lineage
缺口会记录为 `migration_producer_lineage_missing`，并强制包
`queryReady=false`。当前 8 个受影响包可挂载但不可查询，符合最终合同中
missing producer lineage 的可见但 not query-ready 规则。

### package_layout_transform: pass

`copy-map.yaml` 将 source、input、qmd、legacy output、legacy runs 与 loose
state files 映射到 package-relative hotplug roots。38 个候选包均具备
逐文件 source/target locator、bytes、hash、operation type、commit status
与 rollback action。最新证据未发现 pending 文件条目。

### checksum_manifest_regeneration: pass

`manifest-diff.yaml` 为 38 个包记录旧 distribution manifest hash 与新
`BOOK_MANIFEST.json` hash。Manifest sidecars 与 checksum metadata 存在且
匹配。38 个 manifest 均通过包验证，创建期质量门（quality gate）也被
排除在可分发 file closure 之外。

### residue_quarantine_policy: pass

34 个 residue 目录均被分类为 `residue_quarantined`；它们未被 mounted、
未被 exported，也未被删除。最新 residue report 具备有效 sidecars。
vault-root 中的 forbidden residues 已迁移到 quarantine 并写入报告证据。

### idempotent_migration: partial

默认重跑路径能够识别 `already_migrated`、`partial_migration` 与
`failed_interrupted`，并记录 rerun behavior。不过 backfill 命令仍暴露
`--force`，且 package generation 默认基于时间戳。强制重跑可能重写 live
`BOOK_MANIFEST.json`、`PUBLISH_READY.json` 与 quality-gate sidecars，并产生
新 generation。当前没有可执行测试证明所有重跑模式下已验证 package
identity 都保持不变。

### conflict_and_duplicate_handling: partial

冲突证据已有改善。当前报告记录 34 个
`migration_source_hash_prefix_conflict` 条目，实现也能发出 duplicate
source hash、staging target、live root 与 failed-interrupted target
generation conflict。剩余缺口是完整固定矩阵的覆盖和执行证明：same bookId
with different source hash、manifest identity mismatch、显式人工决策入口
尚未由可执行测试或真实证据完整证明。

### rollback_and_audit_trail: partial

审计证据明显增强：copy-map 条目含 before/after locator、hash、operation、
commit status 与 rollback action。commit-record 保留 legacy evidence 并记录
commit decision。剩余缺口是运行时回滚能力：backfill 会验证临时 candidate，
随后仍直接在 live root 下写 manifest、publish marker 与 quality gate。
当前没有完整 staging-first publish、rollback 或 interrupted live-root write
resume 测试。

### catalog_projection_cleanup: pass

Catalog 投影由已挂载 hotplug packages 重建。当前 catalog 数量与 38 个
有效包、30 个 query-ready graph capabilities 一致。focused test 覆盖 stale
catalog cleanup，当前 vault 摘要未观察到 stale capability bookId。

### executable_migration_tests: partial

focused hotplug suite 目前覆盖 7 个关键用例：catalog rebuild、residue
quarantine、missing source fail-closed、stale projection cleanup、quality
gate outside package closure、provider payload rejection，以及 missing
producer run fail-closed for query capability。仍缺完整 38/34 迁移矩阵、
interrupted retry、force rerun identity stability、partial live write
rollback、完整 conflict decision matrix 的自动化覆盖。

## 残余风险

1. `--force` 可能重生成 live package identity，除非调用方把它当作显式
   republish operation 并套用额外治理。
2. Backfill publish 在 candidate validation 后不是完整 staging-first；
   live-root 写入期间崩溃仍依赖后续分类，而不是即时 rollback。
3. Conflict reports 覆盖当前 34 个 residue conflicts，但尚未用 fixtures
   证明所有固定冲突族。
4. Migration tests 已有价值，但仍不足以证明 interruption、rollback、
   duplicate/manual-decision 的完整行为。

## 决策

Agent 2 实施审计结果保持 `partial`。当前实现足以让 38 个 package 与
34 个 residue 在现状下保持 mount-safe，但 batch-backfill 与 migration-cleanup
合同尚未完全闭环，除非修复上述 4 个残余风险，或将其明确接受为有边界的
运维约束（operational constraints）。
