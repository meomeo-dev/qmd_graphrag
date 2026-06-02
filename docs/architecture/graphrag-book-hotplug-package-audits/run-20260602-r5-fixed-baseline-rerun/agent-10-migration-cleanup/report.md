# R5 迁移清理固定基准审计报告

## scenario

当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局
(hot-plug layout migration)。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

审计范围仅限设计文档是否满足固定 10 维 `passCriteria`。未读取 provider
payload、secrets、`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

复用固定基线 (fixed baseline)：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-10-migration-cleanup/baseline.yaml`

Baseline SHA-256：

`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

基线场景：

当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局。

## baseline_integrity_check

- 基线文件存在并按只读输入复用。
- `schemaVersion` 为 `1.0.0`。
- `agentId` 为 `agent-10-migration-cleanup`。
- 基线维度数量为 10。
- 未新增、删除、重排、重命名审计维度。
- 未改变任何 `passCriteria`。
- 未修改 `baseline.yaml`。

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

   主 Type DD 记录当前观测为 72 个 book 目录、38 本完成书、34 个历史
   残留目录，并给出 `currentBookCriteria`、`residueCriteria` 与同源
   `priorityRule`。R3 补充固定 `bookId`、`sourceHash`、`packageGeneration`
   等 identity 字段语义，避免用标题或可变 metadata 推断迁移身份。未知
   legacy shape 走 `fail_closed` 或隔离状态，未分类目录不会被误迁移为
   hot-plug authoritative package。

2. `migration_source_of_truth`：PARTIAL

   文档把 `distribution_manifest.json`、checksum sidecars、
   `qmd/qmd_build_manifest.json`、`output/qmd_output_manifest.json`、canonical
   input、producer evidence 与 source closure 纳入迁移判定。R3 补充增加
   `missing_source_closure`、`missing_producer_lineage` 等诊断和 fixtures。
   仍有缺口：缺失文件到“禁止自动生成 authoritative `BOOK_MANIFEST.json`”
   的 fail-closed 表未完全显式化；`legacy_distribution_manifest_v1` 的
   preconditions 未直接列出 source closure 与 runs/provenance closure；
   `producer_lineage_missing` 可进入 `visible_not_query_ready`，但未明确它
   是否禁止自动生成 authoritative package manifest。

3. `package_layout_transform`：PASS

   `targetDirectoryLayout` 明确 `source/`、`input/`、`qmd/`、
   `graphrag/output/`、`graphrag/runs/`、`state/` 的目标角色。
   `distributionManifestMigration` 规定 source closure、GraphRAG output、
   runs、job、checkpoints、artifacts 与 input 的迁移目标。R3
   `compatibilityBridgeLifecycle` 要求 bridge package-relative、不可逃逸、
   一次成功 `BOOK_MANIFEST` audit 后过期，并在 repack 默认移除。

4. `checksum_manifest_regeneration`：PASS

   原子发布协议要求先写 package files，再生成 file checksums、
   package-relative `BOOK_MANIFEST.json`、manifest checksum、checksum
   metadata 和 `PUBLISH_READY.json`。迁移规则要求所有 move、copy、rename
   或 redaction 后重新生成 file entries 与 checksums。旧 checksum 可作为
   before/after audit evidence 保存，但不能复用为目标布局校验。

5. `residue_quarantine_policy`：PASS

   `residuePolicy` 默认 `quarantine_without_delete`，残留目录不被 normal
   mount scan 挂载，只有 repair command 可显式处理。`quarantineAndRepairStateMachine`
   定义 detected、quarantined、repair、cleared、archived 等状态；repair
   成功必须通过完整 validator 并提交新的 projection generation。保留策略
   禁止删除 active quarantine records、last-good generation 和被 mounted
   books 引用的 migration evidence。

6. `idempotent_migration`：PARTIAL

   文档声明迁移必须 idempotent、auditable、reversible，并给出
   discovered、classified、staging、files_copied、manifest_generated、
   checksums_regenerated、validated、published、mounted、rolled_back 等状态。
   实现计划也要求 legacy migration 可 interruption rerun。仍有缺口：
   未显式定义 `already_migrated`、`partial_migration`、
   `failed_interrupted`、`legacy_only` 的识别键与恢复行为；未规定重复运行
   如何复用 `copy-map`、避免重复 move/copy、保护用户新增 metadata，或拒绝
   改变已验证 package identity。

7. `conflict_and_duplicate_handling`：PARTIAL

   R3 `identityFieldSemantics` 明确 `sameBookIdDifferentSourceHash` 需要
   fail-closed manual decision，`sameSourceHashDifferentBookId` 是 duplicate
   candidate manual decision。主文档有 conflict index、manual conflict
   decision workflow、duplicate residue path row 和 pending decision not
   mounted 规则。仍有缺口：baseline 指定的“完成书与残留目录同前缀”和
   “目标目录已存在”等迁移冲突尚未形成完整 fail-closed 诊断表；当前文本
   主要覆盖 same bookId、same sourceHash、title collision 与 package
   generation replacement。

8. `rollback_and_audit_trail`：PASS

   R3 `migrationEvidenceSchema` 补齐 migration tool version、start/end time、
   decision status、failure reason、rollback plan、before/after package root、
   before/after artifact hashes、old/new manifest path 与 sha256。主文档
   `rollbackContract` 覆盖 publish 前、projection 前和 projection 后回滚；
   `distribution_manifest.json` 作为 legacy evidence 保留到下一次成功
   `BOOK_MANIFEST.json` audit。

9. `catalog_projection_cleanup`：PASS

   catalog、document identity map、graph capabilities 与 qmd projection 都是
   mount scan 派生状态。`mountScanTransactionModel` 使用 generation-based
   transaction 重建 projection；缺失 book root 在下一次 committed scan 中
   unmount；stale projection cleanup 在同一 atomic commit 中移除 absent
   entries。qmd projection 写入外部 projection root，不污染 package root。

10. `executable_migration_tests`：PARTIAL

    主文档与 R3 补充给出 38/34 分类、legacy migration interruption and
    rerun、checksum validator、duplicate residue、catalog cleanup、scanner
    no-read、provider payload 拒读、fixture contracts 与 rollback evidence
    测试合同。由于第 2、6、7 维仍为 PARTIAL，测试合同仍缺少若干可执行
    断言：source/runs closure 缺失时禁止 manifest 生成、重复运行不覆盖
    用户 metadata、目标目录已存在、完成书与残留目录同前缀冲突。

## pass_fail

总体结果：FAIL。

固定基线要求 10 个维度全部满足。本次 R5 结果为 6 PASS、4 PARTIAL、
0 FAIL；存在 PARTIAL 的维度不能视为通过生产设计复审
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

## criteria_delta_from_previous_run

Criteria delta：0。

R5 复用固定 baseline。与上一轮 agent-10 迁移清理审计相比，baseline
SHA-256 仍为
`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`，
维度顺序、维度名称和 `passCriteria` 均未变化。

设计满足度 delta：0 个维度状态改善。

R3 规范性补充已经补强 migration evidence、schema upgrade fixtures、
provider sensitive classes、scanner no-read contracts、qmd re-export 和
compatibility bridge lifecycle；这些补充继续支撑第 8、9 维 PASS。但当前
审计对象中未发现新的 source-of-truth fail-closed 表、migration rerun
contract 或迁移冲突诊断表，因此第 2、6、7、10 维仍为 PARTIAL。

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
