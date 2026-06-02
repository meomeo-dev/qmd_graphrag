# agent-06-security-privacy R3 复审报告

## scenario

用户分发单本 GraphRAG 书包时，导出的
`graph_vault/books/{bookId}` 目录不得泄露 provider payload、密钥、
日志、恢复载荷、调试转储、发送方私人路径或接收方不需要的本地运行
状态。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本复审只读取
公开设计文档、固定 baseline 与上一轮公开审计报告；未读取 provider
payload、secrets、`.env`、请求响应日志、恢复载荷或私有运行目录。

## reused_fixed_baseline

本次 R3 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-06-security-privacy/baseline.yaml`

固定 10 维如下，未新增、删除、重命名任何维度，未改变任何
`passCriteria`。

| id | name | R3 result |
| --- | --- | --- |
| SP-01 | Provider payload 零分发 | 部分通过 |
| SP-02 | 密钥与凭据零分发 | 部分通过 |
| SP-03 | 日志与恢复载荷隔离 | 通过 |
| SP-04 | 私人路径最小化 | 部分通过 |
| SP-05 | Manifest 敏感字段控制 | 部分通过 |
| SP-06 | Producer evidence 脱敏契约 | 通过 |
| SP-07 | 导出前安全门禁 | 通过 |
| SP-08 | 导入与扫描不触碰敏感根 | 部分通过 |
| SP-09 | 可变状态与诊断边界 | 通过 |
| SP-10 | 安全隐私测试可实施性 | 部分通过 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R3 baseline 是否存在 | 通过 |
| R3 baseline 是否复用固定 10 维 | 通过 |
| R2/R3 baseline 内容比较 | 通过，`cmp -s` 返回 `0` |
| baseline SHA-256 | `28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，仍为 SP-01 到 SP-10 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮只新增 `report.md` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、日志载荷或私有根 |

## findings

### SP-01 Provider payload 零分发

结论：部分通过。

R3 Type DD 已新增 `sensitiveMaterialTaxonomy`，将 provider requests、
provider responses、completion、prompt 与 token-usage 归入
`providerPayloads` 禁止类。`producerEvidenceRedaction` 禁止 prompts、
rawResponses、providerHeaders、requestBodies 与 responseBodies；raw provider
request/response evidence 明确不属于 book package。`manifestSensitiveFields`
也禁止 provider headers、request/response bodies、raw prompts、raw
completions 和 token usage details。

仍未完全通过的原因是固定基线要求显式禁止 provider cache 和任何可还原
provider 交互内容进入导出闭包、manifest files、producer evidence 或诊断。
当前 Type DD 只在测试用例中写出 `provider cache path rejected`，未在
`forbiddenClasses.providerPayloads.patterns` 或导出闭包规则中把 provider
cache 作为正式禁止类别。retry transcript、provider interaction transcript
等可还原交互载荷也未被显式点名。

### SP-02 密钥与凭据零分发

结论：部分通过。

R3 Type DD 相比 R2 明显补强凭据类别。`securityExportPolicy` 继续要求
allowlist-first、denylist 防御、导出前 secret scan 和命中 fail-closed；
`sensitiveMaterialTaxonomy.credentials.patterns` 新增 `.npmrc`、`.netrc`、
`.pypirc`、`id_rsa`、`id_ed25519`、`*.pem`、`*.key`、credential 与 secret
模式。测试合同也覆盖 `.npmrc`、`.netrc`、SSH key 和 TLS private key。

剩余缺口是固定基线要求显式禁止 credential store、provider auth config 和
相似凭据进入书包。当前设计可通过 `credential`、`secret`、`key` 等泛化模式
阻断一部分文件，但未点名 provider auth config、credential store export、
cloud credential 文件、OAuth refresh token 文件、`.p12` 或 `.pfx`。在安全
审计口径下，这些仍应作为正式禁止类别写入 Type DD。

### SP-03 日志与恢复载荷隔离

结论：通过。

Type DD 明确排除 `**/logs/**`、`**/.durable-recovery.jsonl`、
`**/*.corrupt-*`、`**/debug/**` 与 `**/trace/**`。`runtimePayloads` 将日志、
debug、trace、durable recovery 和 corrupt artifact 分类为禁止敏感材料。
`externalRuntimeLayout` 将导入诊断、mount 状态、本地查询缓存和扫描事务状态
放在接收方本地根，不属于可分发书包。

包内 `state/` 只允许脱敏 final state snapshot，secret scan 诊断只允许
file path、pattern id 和 byte range class，禁止包含命中文本。该设计满足
日志、恢复载荷和含 payload 诊断默认不导出的固定判据。

### SP-04 私人路径最小化

结论：部分通过。

Type DD 要求从 package-relative paths 生成 `BOOK_MANIFEST.json`，`files`
条目必须使用 package-relative path，绝对路径、父目录逃逸、symlink escape 和
package 外 hardlink 均被拒绝。外部 source path 只能作为 provenance，legacy
`graph_vault/input` path 只能作为 compatibility metadata。新增
`sensitiveMaterialTaxonomy.privatePaths` 后，absoluteLocalPath、userHomePath、
originalInboxPath、tempDirectoryPath 与 shellCommandCwd 均被列为敏感字段。
`catalogProjectionSchemas.booksYaml.packageRoot` 也来自
`scan.packageRootRelativePath`。

未完全通过的原因是 `bookManifestSchema.mount.requiredFields` 仍包含
`packageRoot`，但该字段合同只说明 readonly 与 writable runtime state，并未
明确 `packageRoot` 必须是 package-relative locator、接收方运行时解析值，或
不得承载发送方绝对路径。固定基线要求所有挂载定位字段均为 package-relative
路径；该字段仍需在 manifest schema 层收紧。

### SP-05 Manifest 敏感字段控制

结论：部分通过。

R3 Type DD 已有两层字段控制。`securityExportPolicy.manifestFieldClassification`
将 identity、source kind、input path、qmd required artifacts、GraphRAG
required artifacts 与 compatibility 列为 public，将 provenance、model/tool
summary 与 errorCode 列为 restricted，并禁止 absoluteLocalPath、
environmentVariableValue、provider payload、apiKey、bearerToken 和
userHomePath。`sensitiveMaterialTaxonomy.manifestSensitiveFields` 又禁止
commandLineArgsWithSecrets、environment、providerHeaders、requestBodies、
responseBodies、rawPrompts、rawCompletions 与 tokenUsageDetails。

未完全通过的原因是固定基线要求 BOOK_MANIFEST schema 对 identity、source、
qmd、graphrag、compatibility、producerRunIds 和 metadata 字段都规定敏感边界。
当前设计尚未逐项覆盖 `metadata/`、checksum metadata、`createdBy`、
`producerRunIds`、qmd/graphrag manifest path、完整命令行、未脱敏异常和
diagnostic detail 的 schema 级处理策略。`commandLineArgsWithSecrets` 只覆盖
带 secret 的命令行，未达到“禁止完整命令行”的固定判据。

### SP-06 Producer evidence 脱敏契约

结论：通过。

`producerEvidenceRedaction.allowedFields` 将可导出 producer evidence 限定为
producerRunId、stage、parentProducerRunIds、input/output artifact hashes、
model/embedding fingerprint、toolVersion 和 completedAt。forbidden fields
包括 prompts、rawResponses、providerHeaders、requestBodies、responseBodies、
environment 和 absolutePaths。

GraphRAG query-ready gate 依赖包内 artifact closure、hash binding、schema
与维度兼容性，不要求读取 provider response 文件、请求日志、环境变量或外部运行
目录。gate failure 返回稳定诊断，且不会隐式触发 provider calls。该维度满足
固定基线。

### SP-07 导出前安全门禁

结论：通过。

Type DD 明确 export 是 allowlist-first，denylist 仅作为 defense in depth。
任何 path、symlink、manifest field、producer evidence 或 diagnostic entry
无法归类为 safe 时必须 fail closed。安全合同包含 allowed package roots、
denied patterns、绝对路径拒绝、父目录逃逸拒绝、symlink escape 拒绝、package
外 hardlink 拒绝，以及导出前 secret scan。

`book-package-security.mjs` 的职责被定义为执行 allowlist、denylist、path
safety、symlink policy、secret scan 和 producer evidence redaction。该设计
满足导出前安全门禁固定判据。

### SP-08 导入与扫描不触碰敏感根

结论：部分通过。

R3 Type DD 新增 `scannerReadPolicy`：export 为
`allowlist_only_and_secret_scan`，import 为
`manifest_and_sidecars_first_no_sensitive_roots`，mountScan 为
`no_provider_roots_no_runtime_payload_roots`，migration 为
`no_raw_provider_payload_reads`，query 为
`no_provider_calls_on_gate_failure`。这比 R2 更接近固定基线。readiness gate 的
query-ready 判定也基于 manifest、sidecars、artifact closure 和 lineage binding，
不依赖 provider payload、secrets 或日志。

未完全通过的原因是固定基线同时要求 mount scanner、importer 和 compatibility
check 均不得读取、修改或补全 provider payload roots、secrets、日志目录和发送方
私有路径，并且缺失这些材料不得成为 query-ready 失败原因。当前 Type DD 对
importer 使用了 `no_sensitive_roots`，但 mountScan 只显式覆盖 provider roots 和
runtime payload roots，未点名 secret roots 与 private path roots；compatibility
check 也未作为独立 reader 写入 no-read 合同。缺失敏感材料不影响 query-ready 的
规则虽可从 readiness inputs 推断，但仍未直接写成固定合同。

### SP-09 可变状态与诊断边界

结论：通过。

共享包默认 readonly。导入诊断、mount 状态、本地查询缓存、扫描事务状态和 qmd
projection 分别位于 `graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`，不属于可分发书包。

若产生 debug support bundle，Type DD 要求它是 redacted support bundle。包内
`state/` 只承载脱敏 final snapshot，运行时 import 状态不写入包内。该设计满足
可变状态、诊断与不可变分发闭包分离的固定判据。

### SP-10 安全隐私测试可实施性

结论：部分通过。

R3 Type DD 的测试合同已覆盖 provider payload、logs、corrupt artifacts、
runtime recovery files 排除，secret scan、path escape、symlink escape 和
unclassified producer evidence fail-closed。`sensitiveMaterialTaxonomy.tests`
新增 provider cache path、`.npmrc`、`.netrc`、SSH key、TLS private key、
absolute path redaction、importer refuses sensitive root 与 scanner refuses
provider root。

未完全通过的原因是固定基线要求的自动化断言还包括 manifest 敏感字段、
producer evidence 脱敏 schema、导入不访问 provider 的具体断言，以及缺失敏感
根不影响 query-ready。当前测试用例对这些点仍偏摘要式，没有明确要求对
BOOK_MANIFEST forbidden/restricted 字段、producer evidence allowed/forbidden
字段、compatibility check no-read 行为和 scanner secret/log root no-read 行为
建立自动化断言。

## pass_fail

总体判定：部分通过，未达到完全通过。

R3 修订相对 R2 有实质进展：新增 `sensitiveMaterialTaxonomy`，补入
provider prompt/completion/token-usage、`.npmrc`、`.netrc`、SSH/TLS 私钥、
private path 类别、scanner read policy 和若干安全隐私测试。SP-03、SP-06、
SP-07 与 SP-09 已满足固定基线。

仍未完全通过的维度为 SP-01、SP-02、SP-04、SP-05、SP-08 和 SP-10。主要原因是
若干固定基线点要求“显式禁止”或“schema 级边界”，而当前设计仍有部分条款只出现
在测试摘要、泛化模式或可推断规则中。

| baseline id | R3 result | 判定摘要 |
| --- | --- | --- |
| SP-01 | 部分通过 | prompt/completion/token usage 已补强；provider cache 与可还原 transcript 仍未正式禁止。 |
| SP-02 | 部分通过 | `.npmrc`、`.netrc`、SSH/TLS 已补强；provider auth config 与 credential store 仍未点名。 |
| SP-03 | 通过 | logs、recovery、corrupt、debug、trace 和诊断脱敏边界满足。 |
| SP-04 | 部分通过 | 路径安全增强；`mount.packageRoot` 的 manifest 语义仍需 package-relative 化。 |
| SP-05 | 部分通过 | manifest 敏感字段控制增强；metadata、run ids、createdBy、完整命令行与异常边界仍不完整。 |
| SP-06 | 通过 | producer evidence allowed/forbidden 字段和 query-ready 独立性满足。 |
| SP-07 | 通过 | allowlist、denylist、path/symlink、secret scan 和 fail-closed 满足。 |
| SP-08 | 部分通过 | importer no-sensitive-roots 已补；scanner、compatibility check 与缺失敏感材料规则仍需显式化。 |
| SP-09 | 通过 | 接收方可变状态和诊断已移出不可变分发闭包。 |
| SP-10 | 部分通过 | 新增多类隐私测试；manifest 字段、producer evidence schema 和导入侧 no-read 测试仍不足。 |

## criteria_delta_from_r2

固定基线判据变化：无。R3 复审使用与 R2 完全相同的 10 个 dimension id、name
与 `passCriteria`；没有新增、删除、重命名维度，也没有改变 `passCriteria`。
R2/R3 baseline SHA-256 均为
`28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580`。

| id | R2 result | R3 result | delta |
| --- | --- | --- | --- |
| SP-01 | 部分通过 | 部分通过 | 新增 prompt/completion/token usage 禁止与 provider cache 测试；provider cache 正式禁止类仍缺。 |
| SP-02 | 部分通过 | 部分通过 | 新增 `.npmrc`、`.netrc`、SSH/TLS 私钥；provider auth config 与 credential store 仍缺。 |
| SP-03 | 通过 | 通过 | 无实质退化；runtime payload taxonomy 进一步支撑原通过结论。 |
| SP-04 | 部分通过 | 部分通过 | 新增 private path taxonomy 与 catalog relative packageRoot；manifest `mount.packageRoot` 仍未收紧。 |
| SP-05 | 部分通过 | 部分通过 | 新增 manifestSensitiveFields；schema 全字段边界仍不完整。 |
| SP-06 | 通过 | 通过 | 无实质退化；producer evidence 脱敏契约保持满足。 |
| SP-07 | 通过 | 通过 | 无实质退化；导出前安全门禁保持满足。 |
| SP-08 | 部分通过 | 部分通过 | 新增 scannerReadPolicy；compatibility check 和 scanner secret/private roots no-read 仍需显式化。 |
| SP-09 | 通过 | 通过 | 无实质退化；可变状态隔离保持满足。 |
| SP-10 | 部分通过 | 部分通过 | 新增凭据、cache、absolute path 与 importer/scanner 测试；manifest 与 producer evidence schema 测试仍不足。 |

## required_design_changes

1. 在 `sensitiveMaterialTaxonomy.forbiddenClasses.providerPayloads` 和
   `securityExportPolicy.deniedPatterns` 中正式加入 provider cache、provider
   retry transcript、provider trace event、provider interaction transcript 和
   任何可还原 provider 交互内容，并说明这些材料不得进入 manifest files、
   producer evidence 或 diagnostics。

2. 扩展凭据零分发合同，显式禁止 provider auth config、credential store export、
   cloud credential files、OAuth refresh token files、`.p12`、`.pfx` 和同类
   凭据。secret scan 命中必须继续阻断导出，诊断不得输出命中文本。

3. 收紧 `bookManifestSchema.mount`。`packageRoot`、`publishMarkerPath` 和所有
   挂载定位字段必须定义为 package-relative locator 或由接收方运行时解析的
   vault-relative locator；不得保存发送方绝对路径、用户名路径、临时目录、旧
   batch root 或外部 source root。

4. 扩展 BOOK_MANIFEST schema 的敏感字段分类，逐项覆盖 `metadata`、
   `producerRunIds`、checksum metadata、`createdBy`、qmd/graphrag manifest
   paths、diagnostic detail、exception detail 和 command line。完整命令行、
   环境变量、私有路径、未脱敏异常、原始 payload 和 secret 必须 omit、hash、
   truncate 或 redact，且策略需写入 schema。

5. 将 importer、mount scanner、migration reader、compatibility checker 和 query
   gate 统一纳入 no-sensitive-roots 合同。所有这些组件均不得读取、修改或补全
   provider payload roots、secret roots、logs roots、runtime payload roots 或
   发送方私有路径；缺失这些敏感材料不得导致已封装 artifact 的 query-ready
   失败。

6. 扩展 `testContracts` 和专项测试条目，加入 BOOK_MANIFEST forbidden/restricted
   字段断言、producer evidence allowed/forbidden schema 断言、provider cache
   正式禁止类断言、provider auth config 与 credential store 断言、scanner
   secret/log/private root no-read 断言、compatibility check no-read 断言，以及
   缺失敏感根仍可基于包内 artifact 判定 query-ready 的断言。

## residual_risks

1. 未来 provider SDK 可能新增 cache、trace、telemetry 或 usage 文件形态。实现
   必须保持 allowlist-first 与 unclassified fail-closed，否则 denylist 会快速
   失效。

2. producer evidence 脱敏会降低 lineage 可解释性。若后续为了排障恢复更多 run
   证据，需重新证明不会泄露 provider payload、环境变量、完整命令行或私人路径。

3. source EPUB、normalized input 和 human metadata 可能包含用户批注、购买水印、
   许可信息或私人书目偏好。这不属于 provider payload 泄露，但仍需要
   source-redacted mode 与 metadata privacy profile。

4. `sourceHash`、run id、时间戳、title slug、artifact digest 和 model fingerprint
   可能形成弱关联信息。高隐私分发场景可能需要 anonymization profile。

5. 如果实现把 import diagnostics、repair diagnostics 或 support bundle 写回
   package root，并在二次导出时绕过 `securityExportPolicy`，仍可能泄露接收方
   本地路径或诊断上下文。
