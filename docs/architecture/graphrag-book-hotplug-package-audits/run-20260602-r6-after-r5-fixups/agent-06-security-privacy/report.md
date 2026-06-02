## scenario

用户分发单本 GraphRAG 书包时，导出的
`graph_vault/books/{bookId}` 目录不得泄露 provider payload、密钥、日志、
恢复载荷、调试转储、发送方私人路径或接收方不需要的本地运行状态。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

主文档声明 R3 与 R5 fixups 为规范性补充文档。R5 supplement 明确优先细化
manifest field sensitivity、staged importer pre-publish validation 和 fixed
baseline test contracts，不改变固定审计维度。

本轮仅评估设计文档是否满足固定 10 维 `passCriteria`。本轮未读取 provider
payload、secrets、`.env`、凭据、请求响应日志、日志 payload、恢复 payload 或
私有运行数据。

## reused_fixed_baseline

本轮复用固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-06-security-privacy/baseline.yaml`

固定 10 维保持原顺序，未新增、删除、重命名或重排任何审计维度，未修改任何
`passCriteria`。

| id | name | R6 result |
| --- | --- | --- |
| SP-01 | Provider payload 零分发 | 通过 |
| SP-02 | 密钥与凭据零分发 | 通过 |
| SP-03 | 日志与恢复载荷隔离 | 通过 |
| SP-04 | 私人路径最小化 | 通过 |
| SP-05 | Manifest 敏感字段控制 | 通过 |
| SP-06 | Producer evidence 脱敏契约 | 通过 |
| SP-07 | 导出前安全门禁 | 通过 |
| SP-08 | 导入与扫描不触碰敏感根 | 通过 |
| SP-09 | 可变状态与诊断边界 | 通过 |
| SP-10 | 安全隐私测试可实施性 | 通过 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R6 baseline 是否存在 | 通过 |
| baseline auditAgent | `agent-06-security-privacy` |
| baseline 是否为固定 10 维 | 通过 |
| 维度 id 顺序 | 通过，仍为 SP-01 到 SP-10 |
| 维度名称 | 通过，未新增、删除、重命名 |
| passCriteria | 通过，未修改 |
| baseline SHA-256 | `28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580` |
| 与上一轮 R5 baseline 内容比较 | 通过，内容一致 |
| baseline.yaml 覆盖状态 | 通过，本轮未覆盖 baseline.yaml |
| 本轮写入文件 | 仅本 `report.md` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、日志载荷或私有根 |

## findings

### SP-01 Provider payload 零分发

结论：通过。

主文档在 scope 中排除 provider 请求、provider 响应、密钥和日志 payload 的
分发，并在 `bookManifestSchema.exclusions`、`securityExportPolicy` 和
`sensitiveMaterialTaxonomy` 中禁止 provider requests、provider responses、
completion、prompt、token usage、request bodies、response bodies、raw prompts
和 raw completions 进入导出闭包、manifest 字段、producer evidence 或诊断。

R3 fixups 进一步把 provider cache、LLM cache、provider auth config、
conversation、request-body、response-body、token-usage 和任何可还原 provider
交互材料列为敏感类别，并声明缺少精确路径匹配不使材料可导出。该组合满足
provider payload、provider cache、prompt/completion payload、token usage 明细和
可还原 provider 交互内容零分发要求。

### SP-02 密钥与凭据零分发

结论：通过。

主文档要求导出为 allowlist-first，denylist 仅作为纵深防御；导出前必须执行
secret scan，命中即 fail closed。禁止模式覆盖 `.env`、secret、credential、
token、key、`.npmrc`、`.netrc`、`.pypirc`、SSH key 和 TLS private key 等
形态。

R3 fixups 补充 provider auth config、API key、bearer、credential store、
keychain、`credentials.json`、`secrets.json`、AWS credentials 和通用 config
credentials。R5 staged import 又把 manifest sensitivity schema validation 和
producer evidence redaction validation 放入发布前检查。设计满足密钥、凭据、
provider auth config、credential store 和相似凭据不得进入书包，并在导出前
fail-closed 扫描的要求。

### SP-03 日志与恢复载荷隔离

结论：通过。

主文档明确排除 `**/logs/**`、`**/.durable-recovery.jsonl`、
`**/*.corrupt-*`、`**/debug/**` 和 `**/trace/**`。运行日志、debug、trace、
durable recovery 和 corrupt artifact 被归入 runtime payload 禁止类别。

包内 `state/` 只允许脱敏 final state snapshot；导入诊断、mount 状态、本地查询
缓存和扫描事务状态位于接收方本地根，不属于可分发书包。secret scan 诊断只允许
路径、pattern id 和 byte range class，禁止包含命中文本。该维度满足固定判据。

### SP-04 私人路径最小化

结论：通过。

主文档要求 `BOOK_MANIFEST.json` 从 package-relative paths 生成，`files` 条目
必须为 package-relative path，并拒绝绝对路径、父目录逃逸、symlink escape 和
package 外 hardlink。外部 source path 只能作为 provenance；legacy
`graph_vault/input` path 只能作为 compatibility metadata，不能用于接收方定位。

R3 fixups 进一步规定 `BOOK_MANIFEST.mount.packageRoot` 永远是值为 `.` 的
package-relative locator；live vault 绝对路径只能是 scan-local state，不能出现在
`BOOK_MANIFEST.json` 中。R5 manifest sensitivity schema 禁止 userName、
userHomePath、absoluteLocalPath、originalAbsoluteSourcePath、createdBy.cwd、
hostname、username、absoluteOriginalPath、originalInboxPath 和 tempDirectoryPath
等字段。该维度满足固定判据。

### SP-05 Manifest 敏感字段控制

结论：通过。

主文档已有 `bookManifestSchema`，覆盖 identity、mount、source、input、qmd、
graphrag、files、checksums、exclusions 和 compatibility。`securityExportPolicy`
对 manifest 字段给出 public、restricted、forbidden 分类，并禁止 provider
payload、API key、bearer token、environment value、absoluteLocalPath 和
userHomePath。

R5 `manifestSensitivitySchema` 关闭上一轮缺口：所有 manifest 字段按 public、
restricted、redacted、forbidden 分类；unknown fields fail closed；restricted
字段要求 schema validation、package-relative path validation、bounded length
checks 和 secret scan。该 schema 覆盖 identity、metadata、source、input、qmd、
graphrag、compatibility 和 diagnostics，并明确禁止 raw payload、secret、完整命令
行、环境变量、私有路径、未脱敏异常、provider headers、provider request/response
payload、raw prompt、raw completion 和 token usage details。

R5 还补充 `producerRunIdPolicy`，要求 `producerRunIds` 只作为受限标识符使用，
不得编码本地路径、用户名、provider account identifier 或 secret。该维度满足固定
判据。

### SP-06 Producer evidence 脱敏契约

结论：通过。

`securityExportPolicy.producerEvidenceRedaction.allowedFields` 将可导出 producer
evidence 限定为 producerRunId、stage、parentProducerRunIds、input/output
artifact hashes、model/embedding fingerprint、toolVersion 和 completedAt。
forbiddenFields 禁止 prompts、rawResponses、providerHeaders、requestBodies、
responseBodies、environment 和 absolutePaths。

R5 staged import 把 producer evidence redaction validation 列为 pre-publish
必需检查；R5 fixed baseline tests 要求 producer evidence allowed fields retained
和 producer evidence forbidden fields fail closed。GraphRAG query-ready gate
依赖包内 artifact closure、hash binding、schema、兼容性输入和 redacted producer
lineage summary，不要求读取 provider response 文件、请求日志、环境变量或外部运行
目录。该维度满足固定判据。

### SP-07 导出前安全门禁

结论：通过。

主文档规定 export 为 allowlist-first。任何 path、symlink、manifest field、
producer evidence 或 diagnostic entry 无法归类为 safe 时必须 fail closed。安全
门禁覆盖 allowed package roots、denied patterns、绝对路径拒绝、父目录逃逸拒绝、
symlink escape 拒绝、package 外 hardlink 拒绝和导出前 secret scan。

`moduleBoundary` 将 `book-package-security.mjs` 的职责定义为执行 allowlists、
denylist defense、path safety、symlink policy、secret scan 和 producer evidence
redaction。R5 importer pre-publish validation 又要求 staged import 在 live-root
rename 前执行 manifest sensitivity schema validation 和 producer evidence
redaction validation。该维度满足固定判据。

### SP-08 导入与扫描不触碰敏感根

结论：通过。

主文档定义 scanner read policy：import 为
`manifest_and_sidecars_first_no_sensitive_roots`，mountScan 为
`no_provider_roots_no_runtime_payload_roots`，migration 为
`no_raw_provider_payload_reads`，query 为 `no_provider_calls_on_gate_failure`。

R3 fixups 为 importer、mount scanner、compatibility checker 和 query gate 分别
列出 mayRead 与 mustNotRead，明确不得读取 provider payload roots、credential
stores、runtime logs、raw recovery payloads、runtime diagnostic payloads、raw
prompts、raw completions、provider auth config、credentials 和 raw logs。R5 fixed
baseline tests 进一步要求 importer、mount scanner 和 compatibility checker no-read
provider roots，以及 query gate no provider call on gate failure。缺失敏感根从不
作为 query-ready 的必要条件。该维度满足固定判据。

### SP-09 可变状态与诊断边界

结论：通过。

共享包默认 readonly。导入诊断、mount 状态、本地查询缓存、扫描事务状态和 qmd
projection 分别位于 `graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`，不属于可分发书包。

若产生 debug support bundle，Type DD 要求它是 redacted support bundle。R3
fixups 规定 readonly mounted package 的 local projection 默认不再导出；只有显式
repack 才能创建新的 packageGeneration 并重新生成 manifest 与 sidecar。R5 staged
import 禁止将 import diagnostics 写入 distributable package closure。该维度满足
固定判据。

### SP-10 安全隐私测试可实施性

结论：通过。

主文档测试合同覆盖 provider payload、logs、corrupt artifacts、runtime recovery
files 排除，secret scan、path escape、symlink escape 和 unclassified producer
evidence fail-closed。`sensitiveMaterialTaxonomy.tests` 覆盖 provider cache path、
`.npmrc`、`.netrc`、SSH key、TLS private key、absolute path redaction、
importer refuses sensitive root 和 scanner refuses provider root。

R5 补充把上一轮摘要式缺口转为可执行测试合同。`manifestValidationTests` 覆盖
unknown section rejection、metadata forbidden/restricted 字段、createdBy
fullCommandLine forbidden、commandDigest redacted、producerRunIds path-like rejection、
diagnostics exceptionStackTrace forbidden、restricted packageRelativePath absolute path
rejection、provider payload forbidden fields fail closed 和 redacted fields digest or
summary only。`fixedBaselineTestContracts.securityPrivacy` 覆盖 manifest forbidden
field rejection、manifest restricted field redaction and bounded length、producer
evidence allowed/forbidden 字段、importer no-read provider roots、mount scanner
no-read provider roots、compatibility checker no-read provider roots 和 query gate
no provider call on gate failure。该维度满足固定判据。

## pass_fail

总体结论：通过。

| 结果 | 数量 | 维度 |
| --- | ---: | --- |
| 通过 | 10 | SP-01、SP-02、SP-03、SP-04、SP-05、SP-06、SP-07、SP-08、SP-09、SP-10 |
| 部分通过 | 0 | 无 |
| 未通过 | 0 | 无 |

R5 fixups 已关闭 R5 中 agent-06 剩余的 SP-05 与 SP-10 缺口。当前主 Type DD、
R3 supplement 与 R5 supplement 组合满足固定 10 维安全隐私基准。

## criteria_delta_from_previous_run

上一轮对照为：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-06-security-privacy/report.md`

R6 固定 baseline 与 R5 baseline 内容一致，SHA-256 均为
`28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580`。R5 supplement
作为规范性补充后，本轮判定发生如下变化：

| id | R5 result | R6 result | delta |
| --- | --- | --- | --- |
| SP-01 | 通过 | 通过 | 无变化 |
| SP-02 | 通过 | 通过 | 无变化 |
| SP-03 | 通过 | 通过 | 无变化 |
| SP-04 | 通过 | 通过 | 无变化 |
| SP-05 | 部分通过 | 通过 | R5 `manifestSensitivitySchema` 补齐 metadata、producerRunIds、createdBy、diagnostics、命令行、环境变量、私有路径和 provider payload 字段边界 |
| SP-06 | 通过 | 通过 | 无变化 |
| SP-07 | 通过 | 通过 | 无变化 |
| SP-08 | 通过 | 通过 | 无变化 |
| SP-09 | 通过 | 通过 | 无变化 |
| SP-10 | 部分通过 | 通过 | R5 `manifestValidationTests` 与 `fixedBaselineTestContracts.securityPrivacy` 补齐 manifest、producer evidence、importer、mount scanner、compatibility checker 和 query gate 自动化断言 |

## required_design_changes

无阻塞设计变更。

为保持当前通过状态，后续实现必须按 R5 supplement 执行以下边界：

1. `BOOK_MANIFEST.json` unknown fields fail closed。
2. restricted 字段必须执行 schema、路径、长度和 secret scan 检查。
3. redacted 字段只能保存 digest、code 或 bounded summary。
4. producer evidence 必须通过 allowed/forbidden 字段验证后才可进入书包。
5. importer、mount scanner、compatibility checker 和 query gate 必须保持
   provider roots、credential roots、logs 和 private runtime roots no-read。

## residual_risks

剩余风险为实现与验证风险，不构成本轮 Type DD 固定基准失败：

1. Secret pattern scan 可能存在误报或漏报；实现阶段需要明确规则版本、
   fixtures 和升级回归测试。
2. Redacted summary 的摘要长度、异常消息归类和 digest 规范需要实现层严格
   固化，避免把 raw payload 或私人路径编码进摘要。
3. `sourceRedactionModes` 允许 include source EPUB 或 normalized input only；实际
   分发默认值和用户选择仍需产品策略约束，以免用户误分发其不希望共享的源内容。
4. 本轮只审计设计文档，不证明代码、脚本或未来实现已经满足这些合同。
