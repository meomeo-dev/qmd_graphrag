# agent-04-damaged-package 审计报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。典型状态包括只有部分目录、缺少
`BOOK_MANIFEST.json`、缺少 checksum sidecar、manifest 文件闭包列出的 required
artifact 未复制完、manifest 或 artifact 内容损坏、旧
`distribution_manifest.json` 目录被误放入 `books/`，以及 scanner 在复制过程中
扫描到非稳定目录。

本审计不读取 provider payload、provider secrets、provider logs 或任何外部
payload 内容。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `incomplete_copy_detection`: 复制中断缺文件识别。
2. `checksum_fail_closed`: Checksum 损坏 Fail Closed。
3. `half_package_isolation`: 半包目录隔离。
4. `atomic_import_protocol`: 原子导入协议。
5. `quarantine_state_model`: 隔离状态模型。
6. `no_partial_projection`: 禁止部分投影。
7. `recovery_repair_contract`: 恢复与修复契约。
8. `diagnostics_without_secrets`: 无敏感信息诊断。
9. `implementable_validator_contract`: 可实施验证器契约。
10. `damaged_package_tests`: 损坏包自动化测试。

## findings

### F1: 缺文件与 checksum mismatch 有 fail-closed 方向，但判定粒度不足

Type DD 在 `mountLifecycle.conflictHandling` 中规定 `missingRequiredFile` 和
`checksumMismatch` 均为 `quarantine_mount_candidate`，并要求 copied book directory
必须等 `BOOK_MANIFEST.json` 与 checksum sidecars 通过后才被 mount scanner 接受。
这满足损坏包场景的核心安全方向（fail closed）。

缺口是缺文件判定只落在 `required` 文件级条目，没有定义缺少必需目录、空目录、
manifest 中未列出的额外文件、目录与文件类型不匹配、symlink 指向不存在目标、
大小写冲突路径或 sidecar 自身缺失时的错误分类。实现者仍需自行推断哪些情况属于
`missingRequiredFile`，哪些属于结构错误（structural error）。

### F2: 半包目录会被忽略还是隔离不清楚

文档规定 mount scanner 的 authoritative input 是
`graph_vault/books/*/BOOK_MANIFEST.json`，这意味着没有 manifest 的半包不会成为
权威输入。该规则能避免空目录或部分目录直接污染 catalog。

但文档又要求缺 required file 和 checksum mismatch 进入
`quarantine_mount_candidate`，并规划 `book-package-import.mjs` 负责 validate and
stage copied packages。未说明没有 `BOOK_MANIFEST.json` 的目录是否应记录诊断、
是否显示为 damaged candidate、是否在后续补齐 manifest 后自动恢复。对用户复制
中断场景，单纯“没有 manifest 就不是输入”不足以解释半包目录如何被发现、报告和
重试。

### F3: 直接复制安装与 import staging 存在协议缺口

`installByCopy` 写明用户把完整书包复制到 `books/{bookId}` 后，scanner 验证
manifest 和 checksums 并投影 catalog。`implementationPlan` 同时包含
`book-package-import.mjs`，其职责是 validate and stage copied packages before
projection。

两者之间没有原子性协议（atomicity protocol）：用户是直接复制到最终目录，还是
先复制到 staging；如果直接复制，scanner 如何识别 copy-in-progress；如果使用
staging，最终目录何时 rename；是否需要 `.complete`、`.importing`、临时后缀或
lock 文件。没有该规则时，scanner 可能在复制过程中反复产生 quarantine 诊断，也
可能在 manifest 先复制完成但 artifact 仍缺失时产生不稳定状态。

### F4: 禁止污染 derived catalog 的原则明确，但 stale projection 处理不足

Type DD 明确 catalog 和全局索引是可重建投影，checksum 验证必须在 mount scan
mutates derived catalog projections 之前完成，scanner failures 作为 mount
diagnostics 报告。这可以防止损坏包第一次出现时被投影为可查询书。

不足在于已有投影的失效规则不完整。若一本先前已成功挂载的书后来被用户覆盖成
损坏半包，下一次扫描应删除 catalog entry、标记 unavailable，还是保留旧 entry
并附带 damaged 状态，文档没有明确。损坏包场景要求不能用旧 query-ready 状态掩盖
当前包损坏，否则用户会查询到 stale artifact 或误以为复制成功。

### F5: quarantine 状态只有动作名，没有状态机

`quarantine_mount_candidate` 作为 conflict handling 结果是有价值的，但 Type DD
没有定义 quarantine 的持久化位置、数据格式、状态枚举、错误码、重试触发、恢复
条件、过期清理或 UI/CLI 可见性。`targetDirectoryLayout` 的 `import/` 被描述为
mount 状态、兼容性检查结果与导入诊断，但没有说明它是包内分发内容，还是接收方
本地运行状态。

若 quarantine 诊断写入包根 `import/`，它可能改变 readonly 包目录并破坏包校验
闭包；若写在全局 state，又需要明确路径和投影关系。当前设计不足以直接实现稳定
的 damaged package workflow。

### F6: checksum 契约没有规定校验顺序和 sidecar 信任边界

`bookManifestSchema.checksums` 要求 `algorithm`、`generatedAt` 和
`manifestSha256`，`files` 条目要求 `bytes` 与 `sha256`。该结构足以表达基本完整性
闭包。

缺口是 sidecar 校验顺序和信任边界未定义：应先验证
`BOOK_MANIFEST.json.sha256`，再解析 manifest 中 `checksums.manifestSha256`，还是
两者必须相互一致；`.sha256.meta.json` 的 checksum 是否也被校验；manifest JSON
规范化是否固定；bytes 是逻辑字节数还是文件系统 reported size；checksum 算法
是否只允许 sha256。没有这些细节，损坏 checksum 的可实施测试会出现多种解释。

### F7: 修复与恢复路径没有闭合

文档说明缺 required file 和 checksum mismatch 会被 quarantine，但没有说明用户
补齐文件、重新复制目录或重新导出后，scanner 如何从隔离状态恢复。缺少恢复契约
会导致两类实现分歧：一种每次扫描都重新验证并自动恢复；另一种需要用户清除
quarantine 标记或运行 import 命令。

损坏包场景需要明确恢复条件：错误诊断可覆盖、旧 quarantine 记录何时失效、恢复
后是否重新生成 catalog projection、是否需要重新校验所有 artifacts，以及是否在
恢复过程中读取任何 batch state。设计当前只定义失败结果，没有定义失败后的生命
周期。

### F8: 隐私边界方向正确，损坏诊断的脱敏规则仍缺失

Type DD 明确排除 provider requests、provider responses、`.env`、logs、
corrupt artifacts 和 recovery payload，并说明 scanner failure 不得 mutate
provider payload roots。该规则符合本审计要求，不需要读取 provider payload 或
secrets。

但 damaged package diagnostics 可能需要记录错误路径、source provenance、
manifest 字段和 checksum 差异。文档未规定诊断中不得包含发送方绝对路径、用户名、
provider cache 路径、原始 payload 摘要或源内容片段。若实现者直接记录 manifest
中的 provenance 或异常堆栈，损坏包报告本身可能成为隐私泄漏面。

### F9: Validator 模块边界存在，但输入输出契约不够具体

`book-package-manifest.mjs` 和 `book-mount-scanner.mjs` 的职责已经列出，说明 Type
DD 有模块化实现意识。测试契约也包含复制有效目录、删除目录、隐私排除、冲突和
reindex_on_mount。

不足是 validator 的输入输出没有结构化定义。实现者仍不知道 validate 函数应返回
布尔值、诊断列表、状态对象还是 projection plan；错误码有哪些；是否允许多个错误
合并；路径遍历顺序是否稳定；是否短路于 manifest checksum mismatch；以及 scanner
失败时是否允许写入 diagnostics。对损坏包审计而言，这些是可实施性的关键。

### F10: 自动化测试未覆盖损坏包矩阵

现有 `testContracts` 覆盖主路径和部分冲突，但只显式包含 valid copy、delete、
privacy exclusion、same bookId conflict、reindex_on_mount 和 legacy manifest
生成。没有覆盖缺 manifest、缺 sidecar、缺 required artifact、manifest checksum
mismatch、文件 checksum mismatch、bytes mismatch、半复制目录、旧 manifest-only
目录和恢复后重新挂载。

因此 Type DD 当前不能证明“复制中断导致缺文件、checksum 损坏、半包目录混入
books”场景可被稳定处理。该场景需要专项测试矩阵（test matrix）。

## pass_fail

总体结论：部分通过（partial pass）。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `incomplete_copy_detection` | 部分通过 | 缺 required file 有 quarantine 结果，但缺目录、缺 manifest、缺 sidecar 和结构错误分类不足。 |
| `checksum_fail_closed` | 部分通过 | checksum gate 明确，但校验顺序、sidecar 信任边界和旧投影失效规则不足。 |
| `half_package_isolation` | 部分通过 | manifest 权威输入可避免直接污染，但无 manifest 半包是否诊断、如何恢复不清楚。 |
| `atomic_import_protocol` | 未通过 | 直接复制与 import staging 的原子安装协议未定义。 |
| `quarantine_state_model` | 未通过 | 只有 `quarantine_mount_candidate` 动作名，没有状态机、持久化位置和清除条件。 |
| `no_partial_projection` | 部分通过 | 验证前不 mutate catalog 的原则存在，但已有 stale projection 如何处理未定义。 |
| `recovery_repair_contract` | 未通过 | 补齐文件、重新复制或重新导出后的恢复路径没有闭合。 |
| `diagnostics_without_secrets` | 部分通过 | provider payload 排除明确，但诊断脱敏和绝对路径泄漏规则不足。 |
| `implementable_validator_contract` | 部分通过 | 模块边界存在，validator I/O、错误码和遍历规则不足。 |
| `damaged_package_tests` | 未通过 | 测试契约缺少损坏包矩阵和恢复后重新挂载断言。 |

## required_design_changes

1. 增加 damaged candidate 分类。至少区分 `missing_manifest`、
   `missing_checksum_sidecar`、`manifest_checksum_mismatch`、
   `missing_required_file`、`file_checksum_mismatch`、`file_bytes_mismatch`、
   `structural_path_error`、`copy_in_progress`、`legacy_manifest_only` 和
   `incompatible_schema`。

2. 定义原子导入协议。建议将用户复制目标分为 staging 与 final root：scanner 只
   扫描 final root；import 命令在 staging 完整校验后通过 atomic rename 放入
   `books/{bookId}`。若允许直接复制到 final root，则必须定义完成标志、临时目录
   后缀或锁文件规则。

3. 固化 checksum 校验顺序。明确先校验 manifest sidecar，再解析 manifest，再校验
   manifest 内 `checksums.manifestSha256` 与 sidecar 一致，最后按稳定顺序校验
   `files` 闭包。规定 `.sha256.meta.json` 是否纳入校验和 JSON canonicalization
   规则。

4. 定义 quarantine 状态模型。说明 quarantine 记录写入全局 mount diagnostics、
   包内 `import/` 或其他本地状态；若写入包内，必须说明它是否排除在 package
   checksum 外，以及 readonly 包如何处理诊断写入。

5. 明确 damaged package 对已有投影的影响。当前包验证失败时，derived catalog、
   qmd projection 和 GraphRAG locator 必须失效或标记 unavailable，不得保留旧
   query-ready 状态作为成功挂载结果。

6. 定义恢复流程。补齐文件、重新复制、重新导出或重新生成 manifest 后，scanner
   应按完整校验重新评估，并说明旧 quarantine 诊断何时归档、覆盖或删除。

7. 扩展路径结构规则。规定 manifest files 中路径必须是 POSIX package-relative
   path，禁止路径逃逸，明确目录与文件类型、symlink、hardlink、case conflict、
   unknown files 和空目录处理。

8. 增加诊断脱敏规则。错误报告可包含 package-relative 路径、错误码、expected 与
   observed checksum 的摘要级信息，但不得记录 provider payload、secrets、绝对
   私人路径、源内容片段或未授权 payload 摘要。

9. 给 validator 定义结构化 I/O。建议输出 `{status, errors, warnings,
   packageIdentity, projectionAllowed, recoveryHint}`，并给错误码、严重级别、
   多错误合并和扫描短路条件建立契约。

10. 增加 damaged package 测试矩阵。测试应覆盖缺 manifest、缺 sidecar、缺 required
    artifact、manifest checksum mismatch、artifact checksum mismatch、bytes
    mismatch、copy-in-progress、legacy manifest-only、stale projection invalidation
    和 repair 后重新 mount。

## residual_risks

- 即使设计 staging 与 atomic rename，不同文件系统、网络盘或跨设备移动仍可能无法
  提供真正原子性，需要实现层检测并降级为显式 copy-complete 标志。
- 用户手工复制到 final root 的行为无法完全避免，scanner 必须持续容忍半包目录，
  不能只依赖 import 命令。
- checksum 只能证明闭包与 manifest 一致，不能证明 GraphRAG artifact 语义正确；
  损坏但 checksum 匹配的错误仍需 schema validation 和 query-ready gate 兜底。
- 若诊断写入包内目录，readonly 包和 checksum 闭包之间仍有张力；更稳妥的选择是
  将接收方诊断放在本地 mount state。
- 当前 Type DD 将历史不完整 book 目录的自动删除策略排除在范围外，因此半包和历史
  残留只能被隔离和报告，不能依赖本设计自动清理。
