# R6 迁移清理固定基准审计报告

## scenario

当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局
(hot-plug layout migration)。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

审计范围仅限设计文档是否满足固定 10 维 `passCriteria`。未读取
provider payload、secrets、`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

复用固定基线 (fixed baseline)：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-10-migration-cleanup/baseline.yaml`

Baseline SHA-256：

`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

基线场景：

当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局。

## baseline_integrity_check

- 基线文件存在并按只读输入复用。
- `schemaVersion` 为 `1.0.0`。
- `agentId` 为 `agent-10-migration-cleanup`。
- 基线维度数量为 10。
- R6 baseline 与 R5 同 agent baseline 字节一致，SHA-256 一致。
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

   主 Type DD 固定当前观测：72 个 book 目录、38 本完成书、34 个历史
   残留目录。`currentBookCriteria`、`residueCriteria` 与同源
   `priorityRule` 给出可执行分类字段和优先级。R3 补充固定 `bookId`、
   `sourceHash`、`packageGeneration` 等 identity 字段语义，避免使用标题
   或可变 metadata 推断迁移身份。未知 legacy shape 走 fail-closed 或
   repair/quarantine 路径，未分类目录不得成为 hot-plug authoritative
   package。

2. `migration_source_of_truth`：PASS

   主文档把 `distribution_manifest.json`、checksum sidecars、
   `qmd/qmd_build_manifest.json`、`output/qmd_output_manifest.json`、
   canonical input、producer evidence 与 source closure 纳入迁移判定。
   R5 `migrationSourceTruthFailClosedTable` 逐项列出缺失
   `distribution_manifest.json`、manifest sidecar、canonical input、
   source closure、artifact checksum 等证据时禁止生成 authoritative
   `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和 manifest checksum
   sidecars。对 qmd、GraphRAG output、runs 缺失的降级 manifest 也给出
   `visible_not_*`、`not_query_ready`、诊断码和 manifest 限制。

3. `package_layout_transform`：PASS

   `targetDirectoryLayout` 明确 `source/`、`input/`、`qmd/`、
   `graphrag/output/`、`graphrag/runs/`、`state/` 与 `metadata/` 的目标
   角色。`distributionManifestMigration` 规定 source closure、GraphRAG
   output、runs、job、checkpoints、artifacts 与 input 的迁移目标。R3
   `compatibilityBridgeLifecycle` 要求 bridge package-relative、不可逃逸、
   checksum-bound、一次成功 `BOOK_MANIFEST` audit 后过期，并在 repack
   默认移除。

4. `checksum_manifest_regeneration`：PASS

   原子发布协议要求先写 package files，再生成 file checksums、
   package-relative `BOOK_MANIFEST.json`、manifest checksum、checksum
   metadata 和 `PUBLISH_READY.json`。迁移规则要求所有 move、copy、rename
   或 redaction 后重新生成 file entries 与 checksums。旧 checksum 仅可作
   before/after audit evidence，不得复用为目标布局校验。

5. `residue_quarantine_policy`：PASS

   `residuePolicy` 默认 `quarantine_without_delete`，残留目录不被 normal
   mount scan 挂载，只有 repair command 可显式处理。`quarantineAndRepairStateMachine`
   定义 detected、quarantined、repair、cleared、archived 等状态；repair
   成功必须通过完整 validator 并提交新的 projection generation。保留策略
   禁止删除 active quarantine records、last-good generation 和被 mounted
   books 引用的 migration evidence。

6. `idempotent_migration`：PASS

   主文档声明迁移必须 idempotent、auditable、reversible，并给出发现、
   分类、staging、copy、manifest、checksum、validate、publish、mount、
   rollback 等状态。R5 `migrationRerunIdempotencyContract` 补齐
   `already_migrated`、`partial_migration`、`failed_interrupted`、
   `legacy_only` 的识别键和 rerun 行为；重复运行从 evidence 与 copy-map
   checkpoint 恢复，不重复移动文件，不覆盖用户 metadata，不改变已验证
   package identity。

7. `conflict_and_duplicate_handling`：PASS

   R3 identity 语义覆盖 `sameBookIdDifferentSourceHash`、
   `sameSourceHashDifferentBookId`、同标题不同 source hash 与 generation
   replacement。R5 `migrationConflictDecisionTable` 补齐完成书与残留目录
   同 source-hash prefix、target live root 已存在、staging target 已存在、
   manifest identity mismatch、generation conflict 等迁移冲突的 stable
   diagnostic code、fail-closed outcome、manual decision 入口和允许动作。
   规则禁止 residue candidate 隐式替换已完成有效书。

8. `rollback_and_audit_trail`：PASS

   主文档 `migrationEvidence` 与 R3 `migrationEvidenceSchema` 要求记录
   before/after path、before/after hash、old/new manifest path 与 sha256、
   migration tool version、start/end time、decision status、failure reason
   和 rollback plan。`rollbackContract` 覆盖 publish 前、projection 前和
   projection 后恢复；失败或回滚不删除 legacy evidence。

9. `catalog_projection_cleanup`：PASS

   catalog、document identity map、graph capabilities 与 qmd projection 都是
   mount scan 派生状态。主文档规定缺失 book root 在下一次 committed scan
   中移除，stale projection cleanup 在同一 atomic commit 中删除 absent
   entries。R5 补充规定 stale catalog cache 不能覆盖 manifest-first 判断，
   qmd stale projection 按 packageGeneration 与 idempotency key 失效或重建。

10. `executable_migration_tests`：PASS

    主文档已有 38/34 分类、legacy migration interruption and rerun、
    checksum validator、duplicate residue、catalog cleanup、scanner no-read
    和 provider payload 拒读测试合同。R5 `fixedBaselineTestContracts`
    补齐 migration cleanup required cases：source closure 缺失禁止
    manifest generation、producer runs 缺失 not query ready、already
    migrated verify-only、partial migration copy-map resume、failed
    interrupted explicit decision、source-hash prefix conflict、target live
    root exists、user metadata conflict、catalog cleanup after quarantine。

## pass_fail

总体结果：PASS。

固定基线要求 10 个维度全部满足。本次 R6 审计结果为 10 PASS、0 PARTIAL、
0 FAIL。

逐项结果：

- PASS：`current_vs_residue_classification`
- PASS：`migration_source_of_truth`
- PASS：`package_layout_transform`
- PASS：`checksum_manifest_regeneration`
- PASS：`residue_quarantine_policy`
- PASS：`idempotent_migration`
- PASS：`conflict_and_duplicate_handling`
- PASS：`rollback_and_audit_trail`
- PASS：`catalog_projection_cleanup`
- PASS：`executable_migration_tests`

## criteria_delta_from_previous_run

Criteria delta：0。

R6 继续复用固定 baseline。与 R5 同 agent baseline 相比，SHA-256 仍为
`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`，
维度顺序、维度名称和 `passCriteria` 均未变化。

设计满足度 delta：4 个维度状态改善。

- `migration_source_of_truth`：R5 PARTIAL -> R6 PASS。
- `idempotent_migration`：R5 PARTIAL -> R6 PASS。
- `conflict_and_duplicate_handling`：R5 PARTIAL -> R6 PASS。
- `executable_migration_tests`：R5 PARTIAL -> R6 PASS。

R5 补充文档作为规范性补充，补齐 source-of-truth fail-closed 表、
migration rerun idempotency contract、migration conflict decision table 和
fixed baseline test contracts。因此 R5 报告中的 4 个剩余 PARTIAL 在 R6
审计中关闭。

## required_design_changes

无阻塞性设计变更要求。

当前三份规范文档满足固定 10 维 `passCriteria`。后续实现前仍应把 R5
补充中的迁移 source-of-truth 表、rerun contract、conflict decision table
和 required cases 原样转化为测试夹具、诊断码枚举与迁移脚本契约。

## residual_risks

- R5 表允许部分缺失 qmd、GraphRAG output 或 producer runs 的候选生成
  不可查询 manifest；实现必须先执行 38/34 分类和 residue 隔离，避免历史
  残留绕过 quarantine。
- 迁移脚本若未以 copy-map、manifest hash 和 packageGeneration 作为恢复键，
  仍可能在实现层重复 copy/move 或覆盖用户 metadata。
- manual decision record 必须成为发布前硬门禁；否则 target live root 已存在
  或同源前缀冲突可能错误替换完成书。
- provider payload no-read 需要在自动化测试中用文件系统访问监控或 mock
  reader 验证；仅做内容断言不足以证明迁移没有读取敏感根。
