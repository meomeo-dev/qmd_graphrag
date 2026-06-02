# R5 固定基准审计：agent-07-concurrent-runner

## scenario

场景（scenario）：batch runner 正在构建单本书包，同时另一个流程执行
mount scan 或 import。设计必须防止半构建、半导入、半校验状态成为
catalog、qmd 或 query-ready 的权威来源。

纳入审计的规范性输入：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

R3 fixup 文档作为规范性补充（normative supplement）一起评估。本次仅
审计设计文档是否满足固定 passCriteria；未读取 provider payload、secrets、
`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

固定基准路径：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-07-concurrent-runner/baseline.yaml`

基准身份：

- `schemaVersion`: `1.0.0`
- `auditAgent`: `agent-07-concurrent-runner`
- 写入报告前 SHA-256：
  `8ba1162d9ce0def54628946b0399ab1aec6ef6324efd2e01c3a88ea372b16b93`

本次复用该固定基准，未新增、删除、重排或重命名审计维度。

固定维度顺序如下：

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
顺序未变化。本次审计未修改 `baseline.yaml`，也未创建新基准文件。

本次只写入以下报告文件：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-07-concurrent-runner/report.md`

## findings

1. `CR-01` 构建中书包不可见：PASS。
   Type DD 要求 build 输出写入
   `graph_vault/.staging/builds/{runId}/{bookId}`，并规定部分复制或正在
   构建的目录不得投影到 catalog 或 qmd indexes。mount scanner 还必须忽略
   缺少有效 `BOOK_MANIFEST.json`、manifest sidecars 与 `PUBLISH_READY.json`
   的候选目录。因此 batch runner 的半构建状态不会成为可扫描权威。

2. `CR-02` 原子提交协议：PASS。
   publish protocol 定义了 staging roots、先写包文件、后生成 manifest、
   再写 manifest sidecars 与 `PUBLISH_READY.json`、执行 fsync、最后原子
   rename 到 live root。失败或不完整包会因缺少 marker、checksum mismatch
   或 quarantine policy 而 fail closed，并保留 last-good projection。

3. `CR-03` 导入暂存隔离：FAIL。
   设计提供 `graph_vault/.staging/imports/{importId}/{bookId}`，并能阻止
   scanner 投影半复制 staging 内容。但固定标准要求 import 流程在
   staging/quarantine 中完成复制、checksum validation 和 compatibility
   check 后，才可原子发布到 `books/{bookId}`。当前设计把 schema
   compatibility 与 identity validation 放在 live-root 候选枚举后的
   mount-scan validation pipeline 中；`book-package-import.mjs` 也只描述为
   “Validate and stage copied packages before projection”。文档没有明确要求
   importer 在原子 rename 到 `graph_vault/books/{bookId}` 前完成兼容性检查。

4. `CR-04` 扫描快照一致性：PASS。
   mount scan 被定义为 generation-based transaction，包含 candidate-set、
   validation-results、projection-plan 与 commit-record。changed-set digest
   覆盖 `packageGeneration`、`manifestSha256`、manifest bytes、
   publish marker hash 与 root directory mtime。scan snapshot change
   policy 要求候选、manifest、publish marker 或 root 在 commit 前变化时
   retry 或 defer，避免混合新旧状态。

5. `CR-05` Catalog 原子投影：PASS。
   Type DD 要求 catalog 与 qmd projection 文件先写入
   `graph_vault/catalog/.staging/mount-scan-{scanGeneration}`，完成 checksum、
   fsync 后再原子替换。current-generation pointer 最后更新，读者只读取
   last committed generation，不读取部分提交的 projection。

6. `CR-06` 锁与租约边界：PASS。
   设计定义 publish、scan、catalog commit、qmd projection、query read 和
   repair locks，并给出 acquisition order 与 compatibility rules。lease
   record 包含 holder、heartbeat、expiry、package generation、scan
   generation 与 fencing token。冲突时 fail closed 或 retry，读者继续使用
   last-good projection。

7. `CR-07` Query-ready 门禁抗竞态：PASS。
   readiness gates 区分 mounted、qmd-ready、GraphRAG-ready 与 query-ready。
   GraphRAG readiness 要求 required artifacts、checksum binding、producer
   lineage、compatibility inputs 与 package generation 一致。query entrypoint
   通过 committed projection 解析，并拒绝 stale 或 cross-book artifacts。
   R3 fixups 还规定 sensitive roots 不能作为 readiness proof。

8. `CR-08` 可变状态互不污染：PASS。
   mutable state 被拆分到 build staging、import staging、quarantine、
   local runtime state、mount-scan transaction state 与 qmd projection state。
   已发布 package 默认 readonly。import diagnostics、runtime caches、repair
   diagnostics 和 local qmd projections 均位于分发包闭包外；除非显式 repack
   创建新的 package generation，否则不得写回已挂载包。

9. `CR-09` 冲突与删除竞态可恢复：PASS。
   设计覆盖 same-book replacement、identity conflicts、root deletion、failed
   replacement、checksum mismatch、quarantine repair、lease takeover 和 stale
   staging cleanup。带 live lease 的 active staging 不会被清理；过期 lease
   takeover 需要 fencing-token 检查；cleanup 不删除 live package root 或
   last-good projection。

10. `CR-10` 并发测试可实施性：PASS。
    Type DD 提供可自动化测试合同，覆盖 scanner 观察 publisher staging、
    publisher rename during enumeration、manifest change before projection
    commit、root deletion before commit、stale publish lock takeover 成功与
    失败、catalog staging cleanup、concurrent query during projection swap、
    projection commit failure，以及 staging copy 仅在 atomic rename 后可见。

## pass_fail

总体结果：FAIL。

固定维度结果：

1. `CR-01` 构建中书包不可见：PASS
2. `CR-02` 原子提交协议：PASS
3. `CR-03` 导入暂存隔离：FAIL
4. `CR-04` 扫描快照一致性：PASS
5. `CR-05` Catalog 原子投影：PASS
6. `CR-06` 锁与租约边界：PASS
7. `CR-07` Query-ready 门禁抗竞态：PASS
8. `CR-08` 可变状态互不污染：PASS
9. `CR-09` 冲突与删除竞态可恢复：PASS
10. `CR-10` 并发测试可实施性：PASS

通过：9。
失败：1。

## criteria_delta_from_previous_run

本次未使用 previous-run report 作为输入。固定 baseline criteria 原样复用，
因此 criterion set 无变化。

相对固定 passCriteria 的当前状态：

1. `CR-01` 构建中书包不可见：满足固定标准。
2. `CR-02` 原子提交协议：满足固定标准。
3. `CR-03` 导入暂存隔离：不满足固定标准。
4. `CR-04` 扫描快照一致性：满足固定标准。
5. `CR-05` Catalog 原子投影：满足固定标准。
6. `CR-06` 锁与租约边界：满足固定标准。
7. `CR-07` Query-ready 门禁抗竞态：满足固定标准。
8. `CR-08` 可变状态互不污染：满足固定标准。
9. `CR-09` 冲突与删除竞态可恢复：满足固定标准。
10. `CR-10` 并发测试可实施性：满足固定标准。

## required_design_changes

针对 `CR-03` 的必需设计变更：

1. 增加 importer pre-publish validation contract。staged import command 必须
   先把完整 package 复制到
   `graph_vault/.staging/imports/{importId}/{bookId}`，在 staging 中生成或
   校验 checksums 与 sidecars，校验 package-relative paths、schema
   compatibility 和 identity-conflict rules，之后才允许获取 publish lock
   并替换 live root。

2. 明确 staged import 只有在 importer-side validator 通过后，才可原子
   rename 到 `graph_vault/books/{bookId}`。import validation 失败必须保留在
   staging 或移动到 quarantine，不得创建可挂载 live-root candidate。

3. 区分 direct directory copy 与 staged import workflow。direct copy 可以
   继续作为 fail-closed scanner candidate 支持，但不得被视为满足 staged
   import 的 pre-publish contract。

4. 保留现有 mount-scan validator 作为 post-publish projection gate，但需说明
   它是第二道 validation boundary，不是 importer-controlled publication 的
   第一处 compatibility check。

## residual_risks

剩余风险集中在 importer publication boundary。设计已经通过 staging、
generation pointers、locks 与 last-good catalog reads 保护读者不看到 partial
projection。但若缺少明确的 importer-side compatibility gate，incompatible
package 仍可能先成为 live-root candidate，再依赖 scanner failure 或 quarantine
恢复。

其他实现层残余风险如下：

- atomic rename 与 fsync 语义必须限定在同一 filesystem boundary；跨机器共享
  vault 同步协议已明确排除在 scope 外。
- direct directory copy 仍是用户可见模式，即使 projection fail closed，也可能
  对半复制 live candidates 产生诊断噪声。
- lock、lease、heartbeat 与 fencing-token 行为必须在 runner、importer、
  scanner、repair 与 qmd rebuild entrypoints 中保持一致。
