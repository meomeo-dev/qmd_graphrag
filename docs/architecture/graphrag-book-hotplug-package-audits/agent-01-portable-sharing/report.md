# agent-01-portable-sharing 审计报告

## scenario

用户把一本已完成书复制给另一位用户，接收方只复制
`graph_vault/books/{bookId}` 目录后查询。接收方不复制发送方
`graph_vault/catalog`、`graph_vault/sources`、全局 qmd index、batch run
records、provider payload、provider logs 或 secrets。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `portable_closure`: 单目录可移植闭包。
2. `manifest_authority`: Manifest 挂载权威。
3. `receiver_empty_vault_query`: 接收方空 Vault 查询。
4. `identity_conflict`: 身份与冲突处理。
5. `checksum_integrity`: 完整性与篡改校验。
6. `path_portability`: 路径可移植性。
7. `query_readiness_gate`: 查询就绪门禁。
8. `privacy_exclusion`: 隐私与 Provider 排除。
9. `receiver_state_isolation`: 接收方运行状态隔离。
10. `implementable_tests`: 可实施测试契约。

## findings

### F1: 单目录闭包目标明确，但闭包粒度仍不足

Type DD 明确规定 `graph_vault/books/{bookId}` 是权威根目录，
`BOOK_MANIFEST.json` 是挂载权威，且书包必须包含验证、查询、导出、重挂载所需
文件。该方向满足可移植分享的核心目标。

不足在于 `files` section 只规定每个条目的 `path`、`role`、`bytes`、
`sha256`、`required`，没有规定目录级枚举规则、可选 artifact 的查询影响、空目录
处理、symlink 处理、case-sensitive 路径冲突和平台路径分隔符规则。接收方只复制
目录时，这些规则会直接影响“闭包是否真实完整”的可测试性。

### F2: 接收方空 Vault 查询路径未完全闭合

文档声明 catalog 和全局索引是可重建投影，mount scanner 会投影 catalog entries
和 qmd retrieval indexes。该声明支持接收方不复制发送方全局状态。

缺口是查询入口没有被具体化：未说明接收方 GraphRAG 查询命令如何从单本书
manifest 解析到 `graphrag/output/`、LanceDB、parquet 和 qmd index projection；
也未规定缺少全局 qmd index 时，查询是同步重建、异步重建、降级查询，还是
`visible_not_query_ready`。因此 Type DD 对“只复制目录后查询”的充分性仍不完整。

### F3: 路径可移植性原则存在，但 `packageRoot` 字段可能引入发送方路径

Type DD 要求文件条目不能指向 `graph_vault/books/{bookId}` 外，且 legacy
`graph_vault/input` 只能作为 compatibility metadata。这能降低跨用户路径泄漏和
路径失效风险。

但 `mount.requiredFields` 包含 `packageRoot`，未说明它必须是接收方解析出的
vault-relative path，还是 manifest 内写入的路径。若导出时写入发送方绝对路径，
接收方只复制目录后可能产生不可移植 manifest，甚至泄漏用户名或本地目录结构。

### F4: 查询就绪门禁方向正确，但 artifact 最低集合未定义

文档要求 `queryReady`、`requiredArtifacts`、`producerRunIds`，并声明 GraphRAG
output 和 producer evidence 必须通过验证后才能 query-ready。该设计能防止半包
被错误查询。

缺口是 GraphRAG 查询所需最低 artifact 集合没有列明，例如 LanceDB 目录、entity
parquet、relationship parquet、community reports、text units、embedding
metadata、GraphRAG config 或 output manifest 的 schema 字段。缺少最低集合后，
实现者只能把判断推给工具内部错误，难以形成稳定 artifact gate。

### F5: qmd index 可选策略合理，但挂载后查询时序不明确

Type DD 允许包内携带 `qmd/index/qmd_book_index.sqlite`，也允许缺失时声明
`reindex_on_mount` 并列出 normalized input files。这对分享包大小和可恢复性是合理
取舍。

不足是未定义 `qmdIndexPolicy` 的枚举值、重建失败状态、重建输出位置、重建完成前
GraphRAG-only 查询是否允许，以及重建产生的索引是否进入包 checksum 闭包。接收方
只复制目录后查询时，这些状态需要明确。

### F6: 隐私排除覆盖 provider payload，但排除模式仍需扩展

文档明确排除 provider 请求、响应、`.env`、logs、corrupt artifacts 和 recovery
payload，且 scanner failure 不得修改 provider payload roots。该部分符合分享场景
的隐私边界。

缺口是排除模式未覆盖常见 secret 文件和本地配置，例如 `*.key`、
`*.pem`、`*.token`、`.npmrc`、`.netrc`、`secrets/**`、`credentials/**`、
provider cache 目录和含绝对路径的诊断文件。若导出命令只按当前 patterns 过滤，
仍可能泄漏接收方不需要的私有材料。

### F7: 只复制目录的安装模型清晰，但 import staging 边界矛盾

Type DD 同时说复制书目录到 `books/{bookId}` 即安装，又规划
`book-package-import.mjs` 负责 validate and stage copied packages。两者没有冲突
处理顺序：用户是直接复制到最终目录，还是先复制到 staging 后原子移动；scanner
看到半复制目录时应如何判断；`import/` 目录是包内可分发状态还是接收方本地状态。

对“只复制目录后查询”场景，缺少原子安装协议会造成复制中断、边复制边扫描、
manifest 已存在但 artifact 未复制完等可实施风险。

### F8: 身份冲突规则足够作为初始门禁

同 `bookId` 不同 `sourceHash` fail closed、同 `sourceHash` 不同 `bookId`
报告 duplicate candidate，是正确的基础策略。它避免接收方已有书被静默覆盖。

仍缺少接收方已有同 `bookId` 同 `sourceHash` 但 `packageVersion`、artifact schema
或 metadata 不同的处理规则。分享场景中这会出现在同一本书的重导出、修复包或
升级包覆盖旧包时。

### F9: 兼容性契约方向正确，但版本边界过粗

`compatibility` section 要求 `minQmdGraphRagVersion`、
`graphRagArtifactSchema`、`qmdIndexSchema` 和 `createdBy`，并规定不兼容包不能投影
为 query-ready。该规则适合接收方工具版本不足的场景。

不足是 `minQmdGraphRagVersion` 过于合并，未区分 qmd CLI、GraphRAG artifact
schema、embedding model/dimension、LanceDB schema、parquet schema、manifest
schema 和 migration capability。不同维度的兼容失败需要不同诊断和修复路径。

### F10: 测试契约覆盖主路径，但缺少 portable-sharing 专项断言

现有 test contracts 包含复制有效目录、删除目录、隐私排除、冲突处理、
`reindex_on_mount` 和从旧 manifest 生成新 manifest。它们覆盖了主路径。

仍需要补充接收方空 vault 测试：只放入一个完成书包，删除 catalog 和全局索引，
禁用 provider 访问，运行 mount scan，再执行 qmd 查询和 GraphRAG 查询。没有该
测试，设计无法证明“接收方只复制目录后查询”这个场景闭合。

## pass_fail

总体结论：部分通过（partial pass）。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `portable_closure` | 部分通过 | 根目录闭包原则明确，但文件枚举、symlink、可选 artifact 影响未定义。 |
| `manifest_authority` | 通过 | manifest 权威与 catalog projection 边界清楚。 |
| `receiver_empty_vault_query` | 未通过 | 空 vault 后查询入口、索引重建时序和 GraphRAG locator 未闭合。 |
| `identity_conflict` | 部分通过 | 基础冲突有规则，版本相同身份差异未定义。 |
| `checksum_integrity` | 部分通过 | 校验要求明确，但目录级、symlink 和复制中断规则不足。 |
| `path_portability` | 部分通过 | 包内路径原则明确，`packageRoot` 语义可能泄漏发送方路径。 |
| `query_readiness_gate` | 部分通过 | gate 存在，最低 artifact 集合和 schema 细节不足。 |
| `privacy_exclusion` | 部分通过 | provider payload 已排除，secret/config pattern 仍不完整。 |
| `receiver_state_isolation` | 部分通过 | readonly 和 runtime state 隔离原则存在，`import/` 是否可分发不清楚。 |
| `implementable_tests` | 部分通过 | 测试方向存在，缺 portable-sharing 空 vault 查询专项测试。 |

## required_design_changes

1. 明确 manifest 中所有路径字段的路径类型。`packageRoot` 应为接收方运行时解析值
   或 vault-relative locator，导出 manifest 不得写入发送方绝对路径。所有文件闭包
   条目必须是 POSIX-style package-relative path。

2. 增加 portable closure 规则。定义目录遍历、空目录、symlink、hardlink、
   case-sensitive 冲突、隐藏文件、可选文件、平台路径分隔符和未知文件处理策略。

3. 定义接收方空 vault 查询流程。流程应覆盖 copy、mount scan、catalog projection、
   qmd index projection 或 rebuild、GraphRAG output locator 解析、query-ready
   判定和查询命令输入。

4. 列出 GraphRAG query-ready 的最低 artifact 集合。至少要规定 output manifest、
   parquet 类型、LanceDB 或 embedding store、reports、stats、config/context 文件、
   producer evidence 与 schema version 的验证关系。

5. 固化 `qmdIndexPolicy` 枚举和状态机。建议至少包含
   `included_book_index`、`reindex_on_mount`、`projection_only`、
   `unavailable_not_query_ready`，并定义重建输出位置和失败诊断。

6. 区分包内分发状态与接收方本地状态。`import/` 若包含接收方诊断，应默认不属于
   导出闭包；若作为包内 mount metadata，则必须纳入 checksum 和版本规则。

7. 规定原子导入或半包隔离协议。直接复制到最终目录时，scanner 必须识别
   copy-in-progress 或只接受通过 checksum 的完整包；更稳妥的是定义 staging 目录和
   原子 rename。

8. 扩展隐私排除契约。除 provider payload 和 logs 外，加入 secret、credential、
   token、本地配置、provider cache、绝对路径诊断和用户机器路径的排除或脱敏规则。

9. 扩展兼容性字段。拆分 qmd version、GraphRAG artifact schema、embedding
   dimension/model identity、LanceDB schema、parquet schema、manifest schema 和
   migration capability。

10. 增加 portable-sharing 专项测试。测试必须在接收方空 vault、provider disabled、
    no global catalog、no global qmd index 的条件下验证 mount scan 和实际查询。

## residual_risks

- 源 EPUB 默认随包分发涉及授权风险；Type DD 已把 source license policy 设为开放
  问题，分享场景上线前仍需决定 source-redacted mode。
- 即使 manifest 闭包完整，不同操作系统、文件系统大小写规则和 LanceDB/parquet
  版本仍可能造成接收方查询失败。
- qmd index 缺失时的重建成本可能较高，用户感知上可能不像“复制后立即查询”。
- 若 GraphRAG artifact schema 与运行时库版本漂移，`visible_not_query_ready`
  诊断需要足够具体，否则接收方无法判断是包损坏还是工具版本不足。
- 隐私排除依赖导出实现严格执行；Type DD 应配套自动化审计，防止新增日志或 cache
  目录绕过排除模式。
