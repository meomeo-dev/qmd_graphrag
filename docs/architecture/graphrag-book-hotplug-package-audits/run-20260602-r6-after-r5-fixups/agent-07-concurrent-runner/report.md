# R6 固定基准设计审计：agent-07-concurrent-runner

## scenario

场景（scenario）：batch runner 正在构建
`graph_vault/books/{bookId}` 或相邻产物时，另一个流程同时执行 mount
scan/import。设计必须避免半成品被投影、目录竞争、catalog 覆盖、校验竞态
和运行状态互相污染。

规范性输入（normative inputs）：

1. `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
2. `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
3. `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

R3 与 R5 fixup 文档作为规范性补充（normative supplements）一起评估。审计
范围仅限设计文档是否满足固定 10 个 passCriteria；未读取 provider payload、
secrets、`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

固定 baseline 路径：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-07-concurrent-runner/baseline.yaml`

基准身份：

- `schemaVersion`: `1.0.0`
- `auditAgent`: `agent-07-concurrent-runner`
- SHA-256:
  `8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`

本次复用该固定 baseline，未新增、删除、重排或重命名审计维度。

固定维度顺序：

1. `CR-01` 构建中书包不可见
2. `CR-02` 原子提交协议
3. `CR-03` 导入暂存隔离
4. `CR-04` 扫描快照一致性
5. `CR-05` Catalog 原子投影
6. `CR-06` 锁与租约边界
7. `CR-07` Query-ready 门禁抗竞态
8. `CR-08` 可变状态互不污染
9. `CR-09` 冲突与删除竞态可恢复
10. `CR-10` 并发测试可实施性

## baseline_integrity_check

`baseline.yaml` 包含且仅包含固定 10 个维度，编号为 `CR-01` 至 `CR-10`，
顺序未变化。审计报告写入目标为：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-07-concurrent-runner/report.md`

未修改 `baseline.yaml`，未创建新 baseline。

## findings

1. `CR-01` 构建中书包不可见：PASS。
   Type DD 要求 batch runner 只写入
   `graph_vault/.staging/builds/{runId}/{bookId}`，并规定部分复制或正在
   构建的目录不得投影到 catalog 或 qmd indexes。mount scanner 还必须忽略
   缺少有效 `BOOK_MANIFEST.json`、manifest sidecars 和 `PUBLISH_READY.json`
   的候选。因此半构建书包不会作为可扫描权威暴露。

2. `CR-02` 原子提交协议：PASS。
   publish protocol 定义 staging roots、先写 package files、后生成
   `BOOK_MANIFEST.json`、再写 manifest checksum sidecars 与
   `PUBLISH_READY.json`、执行 fsync、最后原子 rename 到 live root。缺失
   publish marker、required file、checksum mismatch、corrupt sidecar、路径
   逃逸或 symlink escape 均 fail closed 或进入 quarantine，不会留下可挂载
   失败构建状态。

3. `CR-03` 导入暂存隔离：PASS。
   R5 补充文档新增 `importerPrePublishValidationContract`，明确 staged
   import 必须先在
   `graph_vault/.staging/imports/{importId}/{bookId}` 完成完整复制、
   manifest schema validation、manifest checksum sidecar validation、
   package-relative path validation、symlink/hardlink escape validation、
   required file presence、file checksum、package/qmd/GraphRAG schema
   compatibility、identity conflict、manifest sensitivity 和 producer evidence
   redaction 校验。只有 `all_required_pre_publish_checks_pass` 后才允许获取
   publish lock、校验 fencing token，并把 staging root 原子 rename 到
   `graph_vault/books/{bookId}`。失败时 live root 保持不变，诊断写入本地
   runtime state，staging 保留重试或移动到 quarantine。direct directory
   copy 被明确区分为未验证 live-root candidate，只有 mount scan 验证通过后
   才能投影。

4. `CR-04` 扫描快照一致性：PASS。
   mount scan 使用 generation-based transaction，包含 candidate-set、
   validation-results、projection-plan 和 commit-record。changed-set digest
   覆盖 `bookId`、`packageGeneration`、`manifestSha256`、manifest bytes、
   publish marker hash 和 root directory mtime。`scanSnapshotChangePolicy`
   要求候选、manifest、publish marker 或 root 在扫描/提交前变化时重试、
   rebuild projection plan、移出稳定缺失候选或 defer 到下一 scan
   generation，避免混合新旧状态。

5. `CR-05` Catalog 原子投影：PASS。
   `catalog/books.yaml`、`sources.yaml`、
   `document-identity-map.yaml`、`graph-capabilities.yaml` 和
   `qmd-projection.yaml` 先写入
   `graph_vault/catalog/.staging/mount-scan-{scanGeneration}`，完成 checksum 与
   fsync 后再原子替换；current-generation pointer 最后更新。读者只读取 last
   committed generation，因此并发 scan 不会暴露部分 projection 或互相覆盖的
   reader view。

6. `CR-06` 锁与租约边界：PASS。
   设计规定 publish、scan、catalog commit、qmd projection、query read、
   repair 与 qmd rebuild 的锁、租约、acquisition order、compatibility matrix
   和 fencing token。runner/importer/scanner 对同一 `bookId` 和全局 catalog
   写入有互斥或 generation 规则；读者读取 last-good projection。锁冲突、
   过期租约和 stale takeover 均 fail closed、重试或保留 last-good view。

7. `CR-07` Query-ready 门禁抗竞态：PASS。
   readiness gates 明确区分 mounted、qmd-ready、GraphRAG-ready 与
   query-ready。GraphRAG gate 要求 required artifacts、checksum binding、
   artifact metadata、producer output hash binding、schema compatibility、
   packageGeneration 和 manifest digest 一致。R5 的
   `manifestFirstDirectQueryResolver` 与 `graphRagArtifactGateStateMachine`
   进一步规定 stale catalog 不能强制 query-ready，repair 需要新
   packageGeneration 或外部 projection generation，gate failure 不触发
   provider calls。

8. `CR-08` 可变状态互不污染：PASS。
   build staging、import staging、quarantine、runtime state、mount-scan
   transaction state、qmd projection state 和 catalog staging 被分配到不同路径
   或 generation namespace。已发布 package 默认 readonly。import diagnostics、
   scanner diagnostics、runtime caches、receiver-local qmd projection 和 repair
   state 均位于分发包闭包外；scanner/importer 不写入 runner 正在使用的
   checkpoint、artifact 或 run evidence。

9. `CR-09` 冲突与删除竞态可恢复：PASS。
   设计覆盖 same `bookId` 新 generation 替换、same `bookId` different
   `sourceHash`、same `sourceHash` different `bookId`、删除时扫描、替换时
   扫描、checksum mismatch quarantine、failed replacement、stale lease
   takeover 和残留 staging cleanup。active staging with live lease 不清理；
   expired lease takeover 需要 fencing-token 检查；cleanup 不删除 live package
   root 或 last-good projection。

10. `CR-10` 并发测试可实施性：PASS。
    主 Type DD 的 `concurrentTestMatrix` 覆盖 scanner 观察 publisher staging、
    publisher rename during candidate enumeration、manifest changes before
    projection commit、root deleted before commit、stale publish lock takeover
    成功/失败、stale catalog staging cleanup 与 concurrent query during
    projection swap。R5 的 `fixedBaselineTestContracts.concurrentRunner` 继续
    固化 staged importer compatibility validation before publish、direct copy
    invalid candidate fail closed、runner build staging invisible to mount scan
    和 publish lock fencing prevents stale rename。

## pass_fail

总体结果：PASS。

固定维度结果：

1. `CR-01` 构建中书包不可见：PASS
2. `CR-02` 原子提交协议：PASS
3. `CR-03` 导入暂存隔离：PASS
4. `CR-04` 扫描快照一致性：PASS
5. `CR-05` Catalog 原子投影：PASS
6. `CR-06` 锁与租约边界：PASS
7. `CR-07` Query-ready 门禁抗竞态：PASS
8. `CR-08` 可变状态互不污染：PASS
9. `CR-09` 冲突与删除竞态可恢复：PASS
10. `CR-10` 并发测试可实施性：PASS

通过：10。
失败：0。

## criteria_delta_from_previous_run

固定 baseline criteria set 无变化：仍为 `CR-01` 至 `CR-10`，名称、顺序和
passCriteria 均未改动。

相对 R5 固定基准同 agent 结果：

1. `CR-01` 构建中书包不可见：PASS -> PASS
2. `CR-02` 原子提交协议：PASS -> PASS
3. `CR-03` 导入暂存隔离：FAIL -> PASS
4. `CR-04` 扫描快照一致性：PASS -> PASS
5. `CR-05` Catalog 原子投影：PASS -> PASS
6. `CR-06` 锁与租约边界：PASS -> PASS
7. `CR-07` Query-ready 门禁抗竞态：PASS -> PASS
8. `CR-08` 可变状态互不污染：PASS -> PASS
9. `CR-09` 冲突与删除竞态可恢复：PASS -> PASS
10. `CR-10` 并发测试可实施性：PASS -> PASS

实质变化（substantive delta）：R5 补充文档通过
`importerPrePublishValidationContract` 关闭了上一轮 `CR-03` 缺口。staged
import 现在必须在 staging/quarantine 边界内完成复制、checksum validation 和
compatibility validation，通过后才可原子发布到 `books/{bookId}`；mount scan
被定义为第二道 validation boundary，而不是 importer-controlled publish 的第一
道兼容性检查。

## required_design_changes

无必需设计变更。固定 10 个 passCriteria 均已被主 Type DD、R3 补充文档和 R5
补充文档覆盖。

实现时仍需保持以下合同不被弱化：

1. staged import 的 importer-side validator 必须在 live-root rename 前执行。
2. direct directory copy 不得被误认为 staged import；无效 candidate 不得投影。
3. mount scan、catalog commit、qmd projection 和 publish locks 必须使用一致的
   fencing token 与 generation checks。
4. query-ready 只能由当前 package generation 的 manifest、checksum、required
   files、GraphRAG output、producer evidence 和 qmd projection 同时验证通过后
   设置。

## residual_risks

剩余风险为实现层风险（implementation risks），不构成当前 Type DD 固定基准
失败：

1. atomic rename 与 fsync 语义必须限定在同一 filesystem boundary；跨机器共享
   vault 同步协议已明确排除在 scope 外。
2. direct directory copy 作为用户友好模式仍可能产生 fail-closed candidate
   diagnostics；实现需避免这些诊断污染 package closure 或 last-good catalog。
3. lease expiry、heartbeat、fencing token 和 stale takeover 必须在 runner、
   importer、scanner、repair 与 qmd rebuild entrypoints 中保持一致。
4. query-ready、qmd-ready 和 catalog projection 的 generation 绑定需要测试覆盖
   才能防止实现层回归。
