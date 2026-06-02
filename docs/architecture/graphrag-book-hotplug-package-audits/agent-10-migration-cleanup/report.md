# agent-10-migration-cleanup 审计报告

## scenario

审计场景为：将当前 `graph_vault/books` 中 38 本完成书与 34 个历史残留
目录迁移到单本书热插拔布局（hot-plug package layout）。完成书当前具有
`qmd`、`input`、`output`、`runs` 与 `distribution_manifest.json` 等闭包证据；
历史残留目录可能只有 `input`、`runs` 或部分 `output`，并与完成书共享
source-hash 前缀。

迁移设计必须保护两个不变量（invariants）：第一，只有完成且校验通过的书能生成
`BOOK_MANIFEST.json` 并成为挂载权威；第二，历史残留目录不得被误清理、误导出或
误投影为 query-ready。审计未读取 provider request、provider response、secrets
或 payload logs。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `current_vs_residue_classification`: 当前书与历史残留分类。
2. `migration_source_of_truth`: 迁移源权威。
3. `package_layout_transform`: 包布局转换完整性。
4. `checksum_manifest_regeneration`: Manifest 与校验重建。
5. `residue_quarantine_policy`: 历史残留隔离策略。
6. `idempotent_migration`: 幂等迁移。
7. `conflict_and_duplicate_handling`: 冲突与重复处理。
8. `rollback_and_audit_trail`: 回滚与审计记录。
9. `catalog_projection_cleanup`: Catalog 投影清理。
10. `executable_migration_tests`: 可执行迁移测试。

## findings

### F1: 当前快照识别了 38/34 结构，但分类 contract 不足

Type DD 记录 `observedBookDirectoryCount: 72`、完成书数量 38、历史残留数量
34，并说明历史目录可缺失 `qmd`、`output` 和 `distribution_manifest.json`。
这为迁移审计提供了正确事实基础。

不足是设计没有把“完成书”和“历史残留”的分类规则转为可执行 contract。当前描述
依赖人工理解：完成书具备哪些文件组合、同 source-hash 前缀如何选 current、
`output` 存在但 `qmd` 缺失时是否 residue、`distribution_manifest.json` 存在但
checksum 失败时如何处理，都没有明确判定顺序。迁移脚本若只按目录名或子目录存在
判断，可能把 34 个残留之一误升级为权威包。

### F2: 迁移源权威方向正确，但缺少 fail-closed 输入条件

Type DD 明确当前 `distribution_manifest.json` 是 distribution closure record，
不是 mount authority，并要求迁移到 `BOOK_MANIFEST.json`。它还要求保留旧
`distribution_manifest.json` 作为 legacy evidence，直到新的 manifest audit
成功。这是合理边界。

缺口是迁移前置条件没有完整列出。对 38 本完成书，设计应声明只有当
`distribution_manifest.json`、其 checksum sidecars、`qmd/`、`output/`、
`runs/`、`input/`、`job.yaml`、`artifacts.yaml` 和 `checkpoints.yaml` 达到
一致状态时，才允许自动生成 `BOOK_MANIFEST.json`。如果其中任一项缺失或 hash
不一致，迁移应进入 repair 或 quarantine，而不是生成不完整 hot-plug package。

### F3: 布局转换覆盖主要目录，但兼容桥生命周期不够具体

迁移规则覆盖 source closure 移入 `source/`、GraphRAG `output/` 移入
`graphrag/output`、`runs/` 移入 `graphrag/runs`、runner 状态移入 `state/`，
并保留 `input/` 作为 canonical root。目标布局与单书包封装目标一致。

不足是“一次迁移版本”的 compatibility symlink 或 locator 没有生命周期定义。
设计未说明 legacy `output/` 和 `runs/` 是复制、移动、symlink、locator file 还是
保留空目录；也未说明何时删除兼容路径、如何防止 mount scanner 同时读取新旧路径、
以及 legacy path 是否进入 files 闭包。对 72 个混合形态目录，这会直接影响幂等性
和残留清理。

### F4: 校验重建原则正确，但 manifest 生成顺序未闭合

Type DD 要求迁移完成后重新生成 package-relative file entries 和 checksums，
并要求 copied book 在 manifest 与 checksum sidecars 通过前被忽略。这能防止旧
hash 误用到新布局。

缺少的是 manifest 生成顺序和 staging 规则。设计没有规定迁移时是否先在临时目录
生成新布局、完成 checksum 后原子替换；没有规定 `BOOK_MANIFEST.json.sha256`
是否覆盖 manifest 本身以外的文件闭包；也没有规定 `.sha256.meta.json` 必须记录
迁移工具版本、输入 legacy manifest hash 和 redaction/exclusion 结果。中断后可能
留下半迁移目录，却被下一次 scanner 当作 mount candidate。

### F5: 历史残留“不可自动删除”明确，但隔离状态不足

Scope 明确排除“对历史不完整 book 目录的自动删除策略”。这防止迁移设计在没有
修复工作流时破坏历史证据。

不足是“不删除”不等于“安全隔离”。Type DD 没有定义 34 个历史残留目录在迁移后的
状态：留在 `graph_vault/books` 下但无 `BOOK_MANIFEST.json`、移入 archive、
标记 `import/quarantine`、还是作为 repair candidate。若残留继续与完成书同处
`books/*`，mount scanner 必须有明确忽略和诊断规则，否则残留目录会成为长期噪声，
也可能在后续脚本中被误导出。

### F6: 冲突处理有基础，但同源多目录迁移决策不足

`mountLifecycle.conflictHandling` 已定义 sameBookIdDifferentSourceHash
fail closed、sameSourceHashDifferentBookId 报告 duplicate candidate、缺失文件
和 checksum mismatch quarantine。这些规则适合挂载期冲突。

迁移期还需要更细规则。当前 34 个历史残留与完成书可能共享 source-hash 前缀，
而 bookId 后缀不同。设计没有说明如何选定 canonical current book、如何绑定旧
残留到完成书的 archive/recovery record、目标 `source/` 已存在时如何处理、以及
同一个 sourceHash 有多个完成目录时是否允许自动迁移。挂载期规则不能完全替代
迁移期去重决策。

### F7: 幂等性没有被设计为一等 contract

迁移规则说明了“移动”和“保留”，但没有要求迁移脚本可重复运行。对 72 个目录的
批量迁移，幂等性是必要条件：迁移可能被中断，也可能先迁移一部分完成书，然后因
某个残留或冲突停止。

Type DD 应定义状态标记，例如 `legacy_only`、`staged`、`manifest_built`、
`validated`、`mounted`、`residue_quarantined` 和 `migration_failed`。没有这些
状态，第二次运行可能重复移动 `output/`、重复创建 symlink、覆盖人工 metadata，
或将半迁移目录误判为完成包。

### F8: Catalog 可重建原则清楚，但 stale cleanup 细节不足

Type DD 明确 catalog 与全局索引是 derived projection，不是包权威；mount scan
会生成 `books.yaml`、`sources.yaml`、`document-identity-map.yaml` 和
`graph-capabilities.yaml`。删除 book 后也会移除 stale catalog projection。

不足是迁移场景下的 cleanup 未定义。迁移会改变 GraphRAG output 路径、source
路径和 state 路径；旧 catalog 可能仍指向 `graph_vault/sources/{bookId}`、
legacy `output/` 或历史残留 bookId。设计没有要求迁移后强制全量 mount scan、
标记 stale projection、清理 global qmd projection 中的旧 document identity，
也没有说明 cleanup 失败时是否回滚 package 状态。

### F9: 审计记录与回滚路径缺失

Type DD 要求保留 producer evidence 和 legacy distribution manifest，但迁移自身
没有 audit trail contract。迁移是一次结构性变更，必须记录 before/after path、
before/after hash、工具版本、执行时间、分类决策、排除项和失败原因。

没有迁移审计记录时，后续无法解释某个完成书为何未迁移、某个残留为何被隔离、
某个 source 文件为何被 redacted，或某个 checksum 为何变化。若迁移中断，也缺少
可恢复 staging 或 rollback 指令。

### F10: 测试契约覆盖热插拔主路径，但不足以验证 38/34 迁移

现有 `testContracts` 包含复制、删除、provider payload 排除、冲突处理、
`reindex_on_mount` 和从 `distribution_manifest.json` 生成 draft manifest。这些
是热插拔能力的基本测试。

缺少迁移专项测试：38 本完成书批量生成 `BOOK_MANIFEST.json`；34 个残留目录留存
但不投影；同 source-hash 前缀完成书与残留目录正确关联；迁移中断后重复运行；
旧 `output/`/`runs/` 兼容桥只生效一个版本；checksum 重建不复用旧布局 hash；
catalog stale path 被移除；provider payload 目录即使存在也不读取、不复制。

## pass_fail

总体结论：部分通过（partial pass）。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `current_vs_residue_classification` | 部分通过 | 快照记录 38/34，但缺少可执行分类判定与优先级。 |
| `migration_source_of_truth` | 部分通过 | 识别 legacy manifest 不是挂载权威，但缺少自动迁移 fail-closed 前置条件。 |
| `package_layout_transform` | 部分通过 | 主要目录转换明确，compatibility locator/symlink 生命周期不足。 |
| `checksum_manifest_regeneration` | 部分通过 | 要求重建 entries/checksums，但 staging、原子性和 metadata 内容不足。 |
| `residue_quarantine_policy` | 未通过 | 明确不自动删除残留，但未定义隔离、archive、repair 或 scanner ignore 状态。 |
| `idempotent_migration` | 未通过 | 未定义迁移状态机，无法保证中断重试和重复运行安全。 |
| `conflict_and_duplicate_handling` | 部分通过 | 有挂载期冲突规则，但迁移期同源多目录决策不足。 |
| `rollback_and_audit_trail` | 未通过 | 缺少迁移审计记录、staging 保留和 rollback contract。 |
| `catalog_projection_cleanup` | 部分通过 | catalog 可重建原则明确，但迁移后的 stale cleanup 规则不足。 |
| `executable_migration_tests` | 部分通过 | 基础测试存在，缺少 38/34 批量迁移、残留隔离和幂等专项测试。 |

## required_design_changes

1. 增加迁移分类 contract。明确完成书、残留目录、repair candidate、duplicate
   candidate 和 invalid candidate 的判定字段、优先级和诊断输出。

2. 定义自动迁移 fail-closed 条件。只有 legacy manifest、checksum sidecars、
   `qmd/`、`input/`、`output/`、`runs/` 和 state 文件达到一致闭包时，才可生成
   `BOOK_MANIFEST.json`。

3. 增加迁移状态机。状态应覆盖 `legacy_only`、`classified_current`、
   `classified_residue`、`staged`、`manifest_built`、`validated`、`mounted`、
   `residue_quarantined`、`repair_required` 和 `migration_failed`。

4. 明确 compatibility bridge。规定 legacy `output/` 与 `runs/` 是移动、复制、
   symlink 还是 locator；定义只允许一个 layout version 的读取窗口，并禁止新旧
   路径同时进入 files 闭包。

5. 定义历史残留隔离策略。34 个残留目录应被标记为 archive 或 repair candidate，
   不生成挂载权威，不参与 catalog projection，不被导出，且不得自动删除。

6. 增加同源多目录决策规则。对同 source-hash 前缀、同 sourceHash 不同 bookId、
   目标目录已存在和 current/residue 并存情况，规定 canonical current 选择、
   fail-closed 条件和人工确认入口。

7. 规定 staging 与原子提交。迁移应先在 staging 中构造目标布局、生成 manifest
   和 checksum，通过验证后再提交；中断时保留可恢复状态，不让半迁移目录成为
   mount candidate。

8. 增加迁移 audit trail schema。记录 before/after path、hash、文件角色、迁移
   工具版本、时间、分类决策、排除项、checksum metadata、失败原因和 repair 建议。

9. 补充 catalog cleanup contract。迁移完成后必须执行全量 mount scan，移除 stale
   catalog、document identity map、graph capabilities 和 global qmd projection
   中的旧路径或残留 bookId。

10. 增加迁移专项测试契约。覆盖 38 完成书批量迁移、34 残留隔离、中断重试、重复
    运行、checksum 重建、冲突处理、compatibility bridge、catalog cleanup 和
    provider payload 不读取。

## residual_risks

- 历史残留目录可能包含对事故排查有价值的 run evidence；即使不自动删除，也需要
  后续 archive/repair 设计避免长期堆积。
- 同 source-hash 前缀不一定等于同一 source identity；迁移设计仍需以 manifest
  与 hash 证据确认，不能只依赖目录名。
- 兼容 bridge 若保留过久，会让实现继续依赖 legacy `output/` 和 `runs/`，削弱
  hot-plug layout 的单一权威。
- 严格 fail-closed 会提高迁移失败率，需要提供 repair report，否则 38 本完成书中
  任何轻微 sidecar 缺失都可能阻塞批量迁移。
- Catalog cleanup 与 package 提交若非事务性，可能短暂出现 package 已验证但投影
  未更新，或投影已更新但 package 回滚的状态。
