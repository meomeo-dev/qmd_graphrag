# R4 迁移清理复审报告 (migration cleanup audit report)

## scenario

当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局
(hot-plug layout migration)。

审查对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

未读取 provider payload、secrets、凭据、原始请求或原始响应。

## reused_fixed_baseline

复用固定基线 (fixed baseline)：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-10-migration-cleanup/baseline.yaml`

Baseline SHA-256：

`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

## baseline_integrity_check

- 基线文件已存在并被复用。
- 基线维度数量为 10。
- 未新增、删除、重排、重命名维度。
- 未改变任何 `passCriteria`。
- 未覆盖或重写 `baseline.yaml`。
- 本报告只评价主 Type DD 与 R3 规范性补充文档
  (normative supplement) 对固定 10 维的满足情况。

固定维度顺序：

1. `current_vs_residue_classification`
2. `migration_source_of_truth`
3. `package_layout_transform`
4. `checksum_manifest_regeneration`
5. `residue_quarantine_policy`
6. `idempotent_migration`
7. `conflict_and_duplicate_handling`
8. `rollback_and_audit_trail`
9. `catalog_projection_cleanup`
10. `executable_migration_tests`

## findings

1. `current_vs_residue_classification`：PASS

   主文档记录当前观测为 72 个 book 目录、38 本完成书、34 个历史残留
   目录，并给出 `currentBookCriteria`、`residueCriteria` 与同源优先级。
   R3 补充文档固定 identity 字段语义，避免通过标题或可变展示字段推断
   迁移身份。未分类或 unsupported legacy shape 走 `fail_closed` 或
   residue quarantine，不会被误迁移为 hot-plug authoritative package。

2. `migration_source_of_truth`：PARTIAL

   文档将 `distribution_manifest.json`、校验 sidecars、qmd manifest、
   GraphRAG output manifest、input、producer evidence 和 source closure
   纳入迁移判定，并在 R3 补充中增加 `missing_source_closure`、
   `missing_producer_lineage` 等诊断与 fixtures。缺口是：缺失文件到
   “禁止自动生成 `BOOK_MANIFEST.json`” 的 fail-closed 表未完全显式化。
   `legacy_distribution_manifest_v1` 的 upgrade preconditions 未直接列出
   source closure 与 runs/provenance closure；`producer_lineage_missing`
   允许 `visible_not_query_ready`，但未清晰说明它是否禁止自动生成
   authoritative package manifest。

3. `package_layout_transform`：PASS

   `targetDirectoryLayout` 明确 `source/`、`input/`、`qmd/`、
   `graphrag/output/`、`graphrag/runs/`、`state/` 的目标角色；
   `distributionManifestMigration` 规定从 legacy layout 到 package layout
   的移动或兼容 locator；R3 `compatibilityBridgeLifecycle` 限定 bridge
   必须 package-relative、一次审计后过期并在 repack 默认移除。

4. `checksum_manifest_regeneration`：PASS

   原子发布协议要求先生成文件 checksums，再生成 package-relative
   `BOOK_MANIFEST.json`、manifest checksum 与 checksum metadata。
   迁移规则要求在所有 move/copy/redaction 后重新生成 file entries 与
   checksums。旧 hash 可保留为 before/after audit evidence，但不能作为
   目标布局校验依据。

5. `residue_quarantine_policy`：PASS

   `residuePolicy` 默认 quarantine without delete，残留目录不被 normal
   mount scan 挂载；`quarantineAndRepairStateMachine` 定义 detected、
   quarantined、repair、cleared、archived 等状态。repair 成功必须通过
   完整 validator 并提交新的 projection generation。保留策略也禁止删除
   active quarantine records、last-good generation 与被 mounted books 引用的
   migration evidence。

6. `idempotent_migration`：PARTIAL

   文档声明迁移必须 idempotent，并给出 discovered、classified、staging、
   files_copied、manifest_generated、checksums_regenerated、validated、
   published、mounted、rolled_back 等状态；实现计划也要求 legacy migration
   across interruption and rerun。缺口是迁移脚本的 rerun contract 不够可执行：
   未显式定义 `already_migrated`、`partial_migration`、`failed_interrupted`
   与 `legacy_only` 的识别键；未规定重复运行如何复用 copy-map、避免重复
   move/copy、保护用户新增 metadata，或拒绝改变已验证 package identity。

7. `conflict_and_duplicate_handling`：PARTIAL

   R3 `identityFieldSemantics` 明确
   `sameBookIdDifferentSourceHash` fail-closed manual decision、
   `sameSourceHashDifferentBookId` duplicate candidate manual decision；
   主文档有 conflict index、manual conflict decision workflow、duplicate
   residue path row 和 pending decision not mounted 规则。缺口是 baseline
   指定的完成书与残留目录同前缀、目标目录已存在等迁移冲突尚未形成完整
   fail-closed 诊断表；当前文本主要覆盖同 bookId、同 sourceHash、title
   collision 和 package generation replacement。

8. `rollback_and_audit_trail`：PASS

   R3 `migrationEvidenceSchema` 补齐 migration tool version、start/end time、
   decision status、failure reason、rollback plan、before/after package root、
   before/after artifact hashes、old/new manifest path 与 sha256。主文档
   `rollbackContract` 覆盖 publish 前、projection 前和 projection 后回滚；
   `distribution_manifest.json` 作为 legacy evidence 保留到下一次成功
   `BOOK_MANIFEST.json` audit。

9. `catalog_projection_cleanup`：PASS

   catalog、document identity map、graph capabilities 与 qmd projection 都是
   mount scan 派生状态。`mountScanTransactionModel` 通过 generation-based
   transaction 重建 projection；缺失 book root 在下一次 committed scan 中
   unmount；stale projection cleanup 会在同一 atomic commit 中移除 absent
   entries。qmd projection 通过外部 projection root 重建，不污染 package。

10. `executable_migration_tests`：PARTIAL

    主文档与 R3 补充给出大量测试合同：38/34 分类、legacy migration
    interruption and rerun、checksum validator、duplicate residue、catalog
    cleanup、scanner no-read、provider payload 拒读、fixture contracts 与
    rollback evidence。由于第 2、6、7 维仍有设计缺口，测试仍缺少针对
    source/runs closure 缺失时禁止自动 manifest 生成、重复运行不覆盖用户
    metadata、目标目录已存在和同前缀冲突的可执行断言。

## pass_fail

总体结果：FAIL。

固定基线要求 10 个维度全部满足；本次 R4 结果为 6 PASS、4 PARTIAL、
0 FAIL。存在 PARTIAL 的维度不能视为通过生产设计复审
(production design review)。

逐项结果：

- PASS：`current_vs_residue_classification`
- PARTIAL：`migration_source_of_truth`
- PASS：`package_layout_transform`
- PASS：`checksum_manifest_regeneration`
- PASS：`residue_quarantine_policy`
- PARTIAL：`idempotent_migration`
- PARTIAL：`conflict_and_duplicate_handling`
- PASS：`rollback_and_audit_trail`
- PASS：`catalog_projection_cleanup`
- PARTIAL：`executable_migration_tests`

## criteria_delta_from_r3

Criteria delta：0。

R4 未改变固定 baseline、维度顺序、维度名称或 `passCriteria`。R3 规范性
补充显著改善 migration evidence、schema upgrade fixtures、provider
sensitive classes、scanner no-read contracts、qmd re-export 和 bridge
lifecycle；这些补充使 rollback/audit、catalog cleanup、provider payload
不读取等维度达到 PASS。剩余差异是设计满足度差异，不是 criteria 变更。

## required_design_changes

1. 增加 migration source-of-truth fail-closed 表。

   表必须逐项列出 `distribution_manifest.json`、manifest sidecars、
   `qmd/qmd_build_manifest.json`、`output/qmd_output_manifest.json`、
   canonical input、`runs/*.yaml` producer lineage、source closure 缺失时的
   outcome，并明确哪些情况禁止自动生成 authoritative
   `BOOK_MANIFEST.json`。

2. 增加 migration rerun contract。

   需要定义识别键和恢复行为：`already_migrated`、
   `partial_migration`、`failed_interrupted`、`legacy_only`、staged copy-map
   reuse、checkpoint resume、重复运行不重复 move/copy、不破坏 checksum、
   不覆盖用户新增 metadata、不改变已验证 package identity。

3. 补齐迁移冲突诊断表。

   需要覆盖完成书与残留目录同前缀、target live root 已存在、staging
   target 已存在、同 bookId 但 generation/manifest 不一致、目录内容与
   manifest identity 不一致等情况，并给出 stable diagnostic code、
   fail-closed outcome 与 manual decision entry。

4. 补齐自动化测试合同。

   需要新增 fixtures 或 required cases，覆盖 source/runs closure 缺失时禁止
   manifest 生成、38 本批量迁移中断重跑、34 个 residue quarantine、用户
   metadata 保护、目标目录已存在、同前缀冲突、catalog cleanup 和 provider
   payload no-read 的组合断言。

## residual_risks

- 缺失 source closure 或 producer runs 时可能生成不可重建或 lineage 不完整的
  package manifest，削弱 hot-plug authoritative package 的可信度。
- 重复运行迁移脚本可能重复移动文件、覆盖人工 metadata，或改变已经验证过的
  package identity。
- 目标目录已存在或 source-hash 前缀冲突若未 fail-closed，可能错误替换完成书
  或将历史残留提升为 mounted candidate。
- 测试合同若只验证宽泛迁移结果，可能漏掉 38/34 批量迁移中的中断恢复、
  duplicate residue、stale projection 和 provider payload no-read 组合问题。
