# agent-06-security-privacy 审计报告

## scenario

用户分发单本 GraphRAG 书包时，只应分发
`graph_vault/books/{bookId}` 下的可验证书包闭包。该闭包不得泄露
provider payload、密钥、日志、恢复载荷、调试转储、发送方私人路径或
接收方不需要的本地运行状态。接收方导入、挂载和查询时也不得读取或依赖
这些敏感材料。

审计对象为 `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
本审计未读取 provider payload、secrets、请求响应日志或私有运行载荷。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

| id | name | 判定重点 |
| --- | --- | --- |
| SP-01 | Provider payload 零分发 | 请求、响应、cache、prompt/completion payload 不进入书包 |
| SP-02 | 密钥与凭据零分发 | `.env`、token、API key、auth config 和私钥不可导出 |
| SP-03 | 日志与恢复载荷隔离 | logs、recovery、debug、trace 默认不可导出 |
| SP-04 | 私人路径最小化 | 挂载定位字段必须 package-relative，不泄露发送方路径 |
| SP-05 | Manifest 敏感字段控制 | manifest 字段不得承载 payload、secret、环境或私有路径 |
| SP-06 | Producer evidence 脱敏契约 | run evidence 只能是脱敏可验证摘要 |
| SP-07 | 导出前安全门禁 | allowlist、denylist、路径逃逸、symlink 和 secret 扫描 fail closed |
| SP-08 | 导入与扫描不触碰敏感根 | importer/scanner 不读取 provider、secret 或日志根 |
| SP-09 | 可变状态与诊断边界 | import/runtime 诊断与不可变分发闭包分离并脱敏 |
| SP-10 | 安全隐私测试可实施性 | 有自动化泄露、防逃逸和脱敏测试合同 |

## findings

### F-01 Provider payload 排除方向正确，但覆盖范围不够完整

Type DD 在 `scope.excluded` 中明确排除 provider 请求、provider 响应、
密钥和日志 payload，并在 `bookManifestSchema.exclusions` 中列出
`provider-requests/**`、`provider-responses/**` 和 `**/logs/**`。这满足
分发书包不能携带 provider payload 的核心方向。

不足是 provider 相关敏感材料不只存在于 request/response 目录。设计未覆盖
provider cache、prompt/completion dump、token usage 明细、embedding request
payload、retry transcript、trace event、debug dump 或工具链临时目录。若导出
实现只按当前 pattern 过滤，仍可能把 provider 交互的派生日志或缓存带入书包。

### F-02 密钥排除只覆盖 `.env`，不足以形成凭据零分发

Type DD 已把 `.env` 和 `**/.env` 放入排除模式，并在 scope 中排除密钥。这是
必要但不充分的凭据边界。

遗漏包括 `*.key`、`*.pem`、`*.p12`、`*.crt`、`*.token`、`.npmrc`、`.netrc`、
`secrets/**`、`credentials/**`、cloud credential 文件、provider auth config、
SSH/TLS 私钥和本地 secret store 导出片段。Type DD 也没有要求 export module
在导出前执行 secret pattern 扫描并 fail closed。

### F-03 日志和恢复文件已列入排除，但缺少脱敏诊断 schema

当前排除模式包含 `**/logs/**`、`**/.durable-recovery.jsonl` 和
`**/*.corrupt-*`，并说明 recovery evidence 可留在 live vault 但默认不得导出。
该规则符合安全隐私场景。

缺口是 Type DD 同时要求 `graphrag/runs/` 保存 producer evidence，并要求
import/ 保存兼容性检查结果与导入诊断。文档未定义哪些诊断字段允许分发、
哪些必须脱敏、哪些必须留在本机。如果 producer evidence 或 import diagnostics
包含异常堆栈、完整命令行、环境变量、输入片段、provider 路径或日志摘要，书包
仍可能泄露敏感上下文。

### F-04 `packageRoot` 和 provenance 字段可能泄露私人路径

文档要求 `files` 条目不得指向 `graph_vault/books/{bookId}` 外，并把外部
source path 降级为 provenance only。这是正确原则。

风险在于 `mount.requiredFields` 包含 `packageRoot`，但未声明该字段必须由接收方
运行时解析或使用 vault-relative locator。`source.sourcePath`、
`qmd.buildManifestPath`、`graphrag.outputManifestPath`、producer run locator、
legacy compatibility metadata 和 checksum metadata 也没有统一的路径敏感规则。
如果导出时写入发送方绝对路径，manifest 会泄露用户名、项目路径、临时目录或
内部运行目录。

### F-05 Manifest 字段缺少敏感信息分级

BOOK_MANIFEST.json 被定义为挂载权威，包含 identity、mount、source、input、qmd、
graphrag、files、checksums、exclusions 和 compatibility sections。作为权威文件，
它会被接收方直接读取，也可能被再次分发。

Type DD 未给 manifest 字段定义敏感信息等级。例如 `createdBy` 可能泄露本机用户、
主机名或工具路径；`producerRunIds` 可能暴露批处理命名、时间和环境线索；
metadata 或 source provenance 可能包含私人备注、下载路径或许可备注。设计需要
明确哪些字段允许公开、哪些必须哈希化、截断、脱敏或默认省略。

### F-06 Producer evidence 与 provider payload 边界存在潜在矛盾

Type DD 要求 GraphRAG query readiness 依赖 `producerRunIds` 和
`graphrag/runs/` producer evidence，同时排除 provider 请求、响应、密钥和日志
payload。两者可以兼容，但当前设计没有写出脱敏 evidence schema。

如果 producer evidence 的实现沿用原始 run 目录，可能把 provider 响应路径、请求
摘要、token 日志、模型调用错误或 payload hash 以外的敏感内容带入分发包。Type
DD 应规定 producer evidence 只包含 artifact digest、工具版本、无敏感状态摘要和
必要 lineage，不得成为读取 provider payload 的间接入口。

### F-07 导出安全模型偏 denylist，缺少 allowlist 和 fail-closed 门禁

Type DD 的 exclusions 采用 denylist 模式，列出了 `.env`、provider requests、
provider responses、corrupt、durable recovery 和 logs。denylist 对已知目录有效，
但对新增 cache、调试目录、第三方工具配置和偶发 secret 文件不稳健。

更可实施的安全边界应以 manifest role allowlist 为主：只允许明确 role 的
`source/`、`input/`、`qmd/`、`graphrag/output/` 和脱敏 `graphrag/runs/` 进入闭包；
再叠加 denylist、secret scan、路径逃逸检查和 symlink 解析检查。当前 Type DD
没有要求导出命中敏感文件时 fail closed，也没有说明是阻断导出还是静默排除。

### F-08 Symlink、hardlink 和路径逃逸未定义

`files.contract` 要求条目不得指向书包外，但未说明目录遍历时如何处理 symlink、
hardlink、`..`、绝对路径、大小写冲突、隐藏文件和平台路径分隔符。

这对隐私很关键。若书包内存在指向 `.env`、provider logs、用户 home 目录或
legacy source root 的 symlink，导出工具可能在打包时跟随链接并泄露包外内容。
Type DD 需要规定导出和导入都拒绝 symlink escape，并把所有 manifest file path
规范化为 POSIX-style package-relative path。

### F-09 `import/` 与 `state/` 的可变状态边界不清

目标布局把 `import/` 作为 mount 状态，把 `state/` 作为 runner state，并将两者
列在 required directory 中。mount contract 又说 writable runtime state 应隔离
在 `import/` 或 `state/runtime`，并默认排除 package checksums。

该设计存在分发边界不清：第一次导出的 `import/` 是否为空目录、接收方诊断是否会
写回包根、再次导出是否会携带接收方本地诊断、`state/` 中哪些是可分发 build
evidence、哪些是运行时私有状态。若不明确，二次分发可能泄露接收方路径、错误日志
或本机兼容性信息。

### F-10 安全隐私测试合同过窄

现有 testContracts 包含 provider payload、logs、corrupt artifacts 和 runtime
recovery files 被排除。这是良好起点。

仍缺少可执行的负面测试：secret 文件、provider cache、debug dump、manifest 绝对
路径、checksum metadata 私有路径、producer evidence payload 引用、symlink
escape、导入过程读取 provider 根、二次导出携带 import diagnostics。没有这些
测试，Type DD 难以保证后续实现不会在新增目录或错误诊断路径上回归。

## pass_fail

总体结论：部分通过。

Type DD 已确立正确的安全隐私方向：provider 请求/响应、密钥、日志 payload、
corrupt artifact 和 recovery payload 默认不分发；书包使用 manifest 与文件闭包
校验；mount scanner 失败不得修改 provider payload roots。

未达到完全通过的原因是：排除模式覆盖范围不足，manifest 与 producer evidence
缺少敏感字段 schema，私人路径规则不够硬，导出门禁偏 denylist，symlink/path
escape 未定义，`import/` 与 `state/` 的二次分发边界不清，测试合同不足以防止
泄露回归。

| baseline id | result | 说明 |
| --- | --- | --- |
| SP-01 | 部分通过 | 明确排除 provider requests/responses，但未覆盖 cache、debug、trace 和派生 payload |
| SP-02 | 部分通过 | `.env` 已排除，其他 credential 文件和 secret scan 未定义 |
| SP-03 | 部分通过 | logs/recovery/corrupt 已排除，脱敏诊断 schema 缺失 |
| SP-04 | 部分通过 | 文件闭包路径边界存在，`packageRoot` 和其他 locator 仍可能泄露绝对路径 |
| SP-05 | 未通过 | manifest 字段没有敏感信息分级和脱敏规则 |
| SP-06 | 未通过 | producer evidence 未定义脱敏结构，可能间接依赖 provider payload |
| SP-07 | 部分通过 | 有 denylist，缺少 allowlist、secret scan、symlink 检查和 fail-closed 规则 |
| SP-08 | 部分通过 | scanner 不得修改 provider roots，但未明确 importer/scanner 不读取敏感根 |
| SP-09 | 部分通过 | runtime state 隔离原则存在，`import/`、`state/` 再导出边界不清 |
| SP-10 | 部分通过 | 有 provider/log 排除测试，缺少 secret、路径、symlink、evidence 脱敏测试 |

## required_design_changes

1. 增加 `securityPrivacyContract`，声明分发书包的敏感信息零容忍边界：
   provider payload、secrets、logs、private paths 和 runtime diagnostics 不得进入
   distributable closure。

2. 将 `exclusions.requiredPatterns` 扩展为安全 denylist，并补充 `*.key`、
   `*.pem`、`*.p12`、`*.token`、`.npmrc`、`.netrc`、`secrets/**`、
   `credentials/**`、provider cache、debug dump、trace 和临时目录模式。

3. 增加 role allowlist。导出闭包只能包含 Type DD 明确批准的 role 和 path root；
   unknown role、unknown directory、sensitive role 或命中 denylist 的文件必须
   fail closed。

4. 统一路径契约。所有用于定位的字段必须是 POSIX-style package-relative path；
   `packageRoot` 应由接收方运行时解析或写成 vault-relative locator。绝对路径、
   `..`、symlink escape 和 hardlink escape 必须拒绝。

5. 为 manifest 增加敏感字段分级。`createdBy`、checksum metadata、
   producerRunIds、source provenance、metadata 和 compatibility diagnostics 只能
   保存无敏感公开值；本机用户名、主机名、环境变量、完整命令行和私有路径必须脱敏。

6. 定义 sanitized producer evidence schema。允许字段应限于 run id、artifact
   digest、artifact schema、工具版本、无敏感状态摘要和时间；禁止 provider
   request/response path、payload excerpt、token log、raw exception 和环境变量。

7. 明确导出失败语义。命中 secret、provider payload、日志 payload、路径逃逸或
   未脱敏诊断时，export command 必须阻断产包并输出本地诊断；不得静默导出，也不
   应把敏感路径写入分发报告。

8. 分离可变状态。推荐把接收方 mount diagnostics 和 runtime state 放到
   `graph_vault/mount_state/books/{bookId}/`；若保留在包根 `import/` 或
   `state/runtime`，必须默认排除 checksum 和再次导出，并执行脱敏。

9. 明确导入侧隐私行为。importer 和 mount scanner 不得读取 provider roots、
   secret roots 或 logs roots；provider 不可达不得影响已打包 artifact 的
   query-ready 判定。

10. 扩展 `testContracts`。增加 provider cache、secret 文件、日志目录、recovery
    payload、manifest 绝对路径、checksum metadata 私有路径、producer evidence
    payload 引用、symlink escape、二次导出携带 import diagnostics 和导入访问
    provider 根的负面测试。

## residual_risks

1. 即使 Type DD 定义排除规则，第三方工具仍可能新增未命名的 cache 或 trace 目录；
   需要 allowlist 和 secret scan 共同降低遗漏风险。

2. 脱敏 producer evidence 会减少 lineage 可解释性；保留更多证据又会提高泄露
   provider payload 或私人路径的风险，需要在 evidence schema 中固定平衡点。

3. source EPUB 与 normalized input 本身可能包含用户私人批注、购买水印或版权信息；
   这不属于 provider payload 泄露，但仍需要 source-redacted mode 或许可策略处理。

4. 哈希、run id、时间戳和标题 slug 可能形成弱关联信息；高隐私场景可能需要
   package anonymization profile。

5. 二次分发风险依赖实现严格区分 immutable package closure 和 receiver-local
   state；如果实现把 import diagnostics 写回包根且再次导出，仍可能泄露接收方
   本机信息。
