# agent-07-concurrent-runner 审计报告

## scenario

batch runner 正在构建一本图书时，另一个流程同时执行 mount scan 或
book-package-import。并发行为可能发生在同一 `bookId`，也可能发生在不同
`bookId` 但共享 `graph_vault/catalog`、全局 qmd 投影或诊断状态。

审计对象为 `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
本审计未读取 provider payload、secrets、请求响应日志或私有运行载荷。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

| id | name | 判定重点 |
| --- | --- | --- |
| CR-01 | 构建中书包不可见 | 未完成构建不得暴露可扫描 BOOK_MANIFEST |
| CR-02 | 原子提交协议 | 临时目录、manifest/checksum 最后写入、原子发布 |
| CR-03 | 导入暂存隔离 | 半复制导入目录不得被 scanner 扫描 |
| CR-04 | 扫描快照一致性 | 扫描期间候选变化必须重试或跳过 |
| CR-05 | Catalog 原子投影 | catalog 和 index projection 以原子替换提交 |
| CR-06 | 锁与租约边界 | 同一 bookId 与全局 catalog 写入有锁、租约或 generation |
| CR-07 | Query-ready 门禁抗竞态 | query-ready 必须绑定同一 package generation |
| CR-08 | 可变状态互不污染 | build/import/scanner/runtime 状态路径互不覆盖 |
| CR-09 | 冲突与删除竞态可恢复 | 覆盖并发 build/import/delete/replace 和残留清理 |
| CR-10 | 并发测试可实施性 | 有可自动化并发和失败恢复测试合同 |

## findings

### F-01 挂载权威规则方向正确，但没有定义构建中的不可见状态

Type DD 明确规定 `graph_vault/books/{bookId}/BOOK_MANIFEST.json` 是挂载
权威，scanner 的权威输入是 `graph_vault/books/*/BOOK_MANIFEST.json`，且复制
目录在 manifest 与 checksum sidecar 验证通过前会被忽略。这为并发场景提供了
基础保护。

缺口是文档没有规定 batch runner 在构建期间如何避免提前生成或暴露
`BOOK_MANIFEST.json`。如果 runner 直接在最终 `books/{bookId}` 下逐步写入
`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/` 和 manifest，scanner
可能在半成品状态读取 manifest，随后因缺文件而 quarantine，或者更严重地把
旧文件与新 manifest 混合投影。

### F-02 缺少书包原子提交协议

设计包含 install-by-copy、checksum 验证和缺文件 quarantine 规则，但没有写出
runner 或 export/import 的原子发布步骤。并发可靠性需要明确顺序：先在
不可扫描 staging 目录完成构建，写入所有 required files，生成 manifest，生成
manifest checksum sidecars，验证闭包，然后通过同文件系统 `rename` 或等价
原子发布进入 `books/{bookId}`。

当前 Type DD 未说明 manifest 是否必须最后写入、checksum sidecar 是否与
manifest 同一 generation、失败构建是否留在 staging、旧包替换是否使用
compare-and-swap（CAS）或 generation 检查。因此它不足以指导实现避免半包暴露。

### F-03 导入流程没有 staging/quarantine 边界

mount lifecycle 将安装描述为复制完整目录到 `graph_vault/books/{bookId}`，然后
由 scanner 验证。这对人工复制简单，但对并发 import 不充分。若 importer 将文件
逐个复制到最终 books 目录，scanner 会看到半复制目录；即使最终会因 checksum
失败被忽略，也可能产生噪声诊断、错误 quarantine 状态或覆盖同名有效包。

Type DD 应要求 `book-package-import.mjs` 使用导入暂存根，例如
`graph_vault/import_staging/{bookId}.{attemptId}`，通过全部校验后再原子发布。
半复制目录、失败目录和 quarantine 目录不应位于 scanner 的 authoritative input
glob 范围内。

### F-04 Scanner 缺少稳定快照或双读校验

设计要求 checksum 验证在 scanner 修改 catalog 前强制执行。这是必要条件，但
不足以保证扫描期间的一致性。scanner 可能先读取 manifest，再读取 required
files；期间 runner 或 importer 替换了目录，导致 manifest、checksum 和文件闭包
来自不同 generation。

Type DD 未规定 scanner 读取前后要比对 manifest digest、sidecar digest、目录
generation、inode/mtime 或 package lock，也未要求变化时重试或跳过候选。因此
无法证明 catalog 投影来自同一个稳定书包快照（stable package snapshot）。

### F-05 Catalog 与全局投影写入缺少原子性

文档把 catalog 和全局 qmd/retrieval index 定义为可重建投影，这是正确的权威
边界。但并发 scan/import 场景下，多个 scanner 或 importer 可能同时写入
`graph_vault/catalog/books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 和可选 qmd projection。

Type DD 没有要求这些投影通过临时文件、fsync、原子替换、generation 文件或
catalog write lock 提交。结果可能出现 `books.yaml` 已更新而
`document-identity-map.yaml` 仍旧、一个 scanner 覆盖另一个 scanner 的新投影、
或查询进程读取到部分更新 catalog。

### F-06 锁、租约和冲突边界没有定义

Type DD 的 conflict handling 覆盖同一 `bookId` 不同 `sourceHash`、同一
`sourceHash` 不同 `bookId`、缺文件、checksum mismatch 和 incompatible schema。
这些是静态冲突规则，不是并发控制规则。

设计没有定义同一 `bookId` 的 runner 与 importer 同时发布时谁胜出，也没有定义
全局 catalog 写锁、book-level lock、租约过期、stale lock 清理、CAS 条件或
重试策略。缺少这些规则时，实现者可能用隐式文件存在检查处理竞争，导致 lost
update、误删有效目录或重复 quarantine。

### F-07 Query-ready 状态没有绑定 package generation

文档规定书包只有在 GraphRAG artifacts 验证通过后才 query-ready，并要求
producer evidence under `graphrag/runs/`。但并发场景下 query-ready 还必须证明
manifest、checksum、GraphRAG output、producer evidence、qmd index projection
和 catalog entry 全部来自同一 package generation。

当前 Type DD 没有定义 `packageGeneration`、`manifestGeneration`、artifact set id
或类似版本戳。scanner 可能在旧 GraphRAG output 尚存、新 manifest 已写入时通过
局部检查；也可能 qmd projection 来自上一版 normalized input，而 catalog 已指向
新版 sourceHash。

### F-08 `state/` 与 `import/` 可能与 runner 写入互相污染

目标布局将 `state/` 定义为 runner state，将 `import/` 定义为 mount state，并把
两者都列为 required directory。mount contract 又允许 writable runtime state
位于 `import/` 或 `state/runtime`，并排除 package checksums。

并发风险是 scanner/importer 可能在包根写入诊断，同时 batch runner 仍在更新
`state/job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 或 producer evidence。
文档没有定义哪些状态是构建期独占、哪些是挂载期可写、哪些在发布后不可变，也
没有要求按 attempt/generation 命名空间隔离。该边界不足以指导实现避免互相覆盖。

### F-09 删除、替换和残留 staging 的恢复策略缺失

uninstall-by-delete 规则说明删除 book 目录后 scanner 会移除 stale catalog
entries。对静态场景足够，但并发时存在多个未覆盖状态：scanner 正在读取时目录被
删除；runner 正在发布时用户删除旧目录；importer 替换同名包时 scanner 读取旧包；
checksum mismatch quarantine 后 runner 仍在完成有效构建。

Type DD 还没有描述失败构建、失败导入、过期锁和残留 staging 目录的清理规则。
尤其需要防止清理流程误删仍有有效租约的构建目录，或把残留 staging 目录误认为
可挂载候选。

### F-10 测试合同未覆盖并发行为

现有 `testContracts` 覆盖复制有效目录、删除目录、敏感文件排除、冲突
sourceHash、缺 qmd index 重建和 legacy manifest 迁移。这些测试都偏顺序执行。

缺少可实施的并发测试：半构建时 scan、半导入时 scan、manifest 写入后 required
file 尚未完成、scan 期间 manifest 改变、两个 scanner 同时写 catalog、删除时
scan、替换时 scan、query-ready 竞态和 stale lock 清理。没有这些测试，设计很难
防止实现只在串行路径上正确。

## pass_fail

总体结论：未通过。

Type DD 已建立有利于并发安全的基础原则：manifest 是挂载权威，catalog 是可重建
投影，checksum 验证必须在投影修改前完成，缺文件和 checksum mismatch 会被
quarantine。但对本场景的核心并发机制缺失：构建不可见、原子发布、导入暂存、
稳定扫描快照、catalog 原子提交、锁/租约、generation 绑定和并发测试均未充分
定义。

| baseline id | result | 说明 |
| --- | --- | --- |
| CR-01 | 部分通过 | scanner 只看 manifest 且需校验，但 runner 构建期不可见规则缺失 |
| CR-02 | 未通过 | 没有临时目录、manifest 最后写入、checksum 最后提交或原子 rename 协议 |
| CR-03 | 未通过 | import 被描述为复制到 books，未定义 staging 后原子发布 |
| CR-04 | 未通过 | 没有扫描快照、双读校验、generation 比对或变化重试 |
| CR-05 | 未通过 | catalog 和 qmd projection 写入原子性未定义 |
| CR-06 | 未通过 | 缺少 book-level 与 catalog-level 锁、租约、CAS 或重试规则 |
| CR-07 | 部分通过 | query-ready 需 artifact 验证，但未绑定同一 package generation |
| CR-08 | 部分通过 | 有 runtime state 隔离意图，但 `state/`、`import/` 写入边界不清 |
| CR-09 | 未通过 | 删除、替换、残留 staging、锁过期和恢复清理规则缺失 |
| CR-10 | 未通过 | testContracts 未覆盖并发和失败恢复行为 |

## required_design_changes

1. 增加 `concurrencyContract`，明确 runner、importer、scanner、catalog writer
   和 query reader 的并发角色、读写边界、失败语义和重试策略。

2. 定义构建发布协议。batch runner 必须在不可扫描的 staging/build attempt
   目录完成所有 artifact，最后生成 `BOOK_MANIFEST.json` 与 checksum sidecars，
   自校验通过后再原子发布到 `graph_vault/books/{bookId}`。

3. 定义导入发布协议。`book-package-import.mjs` 必须先复制到
   `import_staging/{bookId}.{attemptId}` 或同等隔离目录，完成闭包、checksum、
   schema 和兼容性验证后再原子 rename；失败导入进入 quarantine，但不进入
   `books/*/BOOK_MANIFEST.json` 扫描范围。

4. 为书包引入 generation 字段，例如 `packageGeneration`、`manifestDigest`、
   `artifactSetId` 或 `publishedAt`。manifest、checksum、required files、
   producer evidence、qmd projection 和 catalog entry 必须引用同一 generation。

5. 规定 scanner 稳定读取算法。scanner 读取候选前后必须比对 manifest digest
   和 generation；若目录、manifest 或 checksum sidecar 在扫描期间变化，必须
   重试有限次数或跳过并输出本地诊断。

6. 规定 catalog 原子提交。所有 catalog 投影应先写入临时文件并校验完整投影，
   再以原子替换提交；多个 catalog 文件应共享一个 projection generation，查询
   侧只读取完整 generation。

7. 定义锁或租约机制。对同一 `bookId` 的发布、替换和删除使用 book-level lock
   或 CAS；对全局 catalog projection 写入使用 catalog-level lock 或 single
   writer 规则；stale lock 清理必须基于租约过期和 owner liveness，而非简单删除。

8. 明确可变状态路径。runner build state、mount diagnostics、scanner diagnostics
   和 runtime caches 应位于不同路径或 generation 命名空间；scanner/importer 不得
   写入 runner 的 checkpoint、artifact manifest 或 producer run evidence。

9. 补充删除与替换竞态规则。扫描期间目录删除应被视为候选消失；替换期间读到
   generation 改变应重试；清理残留 staging 不得影响有效租约；quarantine 不得
   覆盖仍在运行的构建。

10. 扩展 `testContracts`，加入可自动化并发测试：半构建扫描、半导入扫描、scan
    期间 manifest 改变、并发 scanner 写 catalog、删除扫描竞态、同一 bookId
    build/import 竞争、query-ready 提前置真、锁过期恢复和残留 staging 清理。

## residual_risks

1. 文件系统原子 rename 和锁语义在本地磁盘、网络盘、容器 volume 与跨平台环境中
   可能不同；实现仍需要限定支持文件系统或提供降级策略。

2. 人工复制目录无法强制遵守 importer staging 协议。scanner 仍必须把半复制目录
   视为候选变化或 checksum mismatch，并避免产生破坏性副作用。

3. 多文件 catalog 的一致性可能需要 projection generation 或 manifest 文件；
   否则查询进程仍可能读到跨 generation 的混合投影。

4. 锁文件可能因进程崩溃残留。租约过短会误判长时间构建失效，租约过长会延迟恢复；
   需要实现层的 heartbeat 和可观测诊断。

5. 即使发布协议正确，GraphRAG 或 qmd 工具自身可能在输出目录内进行非原子写入。
   runner 应把这些工具输出隔离在 attempt 目录，完成后再复制或 rename 到发布闭包。
