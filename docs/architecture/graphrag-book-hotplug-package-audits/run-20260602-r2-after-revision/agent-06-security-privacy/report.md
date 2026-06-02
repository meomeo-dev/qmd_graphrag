# agent-06-security-privacy R2 复审报告

## scenario

用户分发单本 GraphRAG 书包时，导出的
`graph_vault/books/{bookId}` 目录不得泄露 provider payload、密钥、日志、
恢复载荷、调试转储、发送方私人路径或接收方不需要的本地运行状态。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本复审未读取
provider payload、secrets、`.env`、请求响应日志、恢复载荷或私有运行目录。

## reused_fixed_baseline

本次 R2 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-06-security-privacy/baseline.yaml`

固定 10 维如下，未新增、删除、重命名任何维度，未改变任何 `passCriteria`。

| id | name | R2 result |
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
| R2 baseline 是否存在 | 通过 |
| R2 baseline 是否复用 R1 固定基线 | 通过 |
| R1/R2 baseline 内容比较 | 通过，`diff -u` 输出为空 |
| baseline SHA-256 | `28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，仍为 SP-01 到 SP-10 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮只写入 `report.md` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、日志载荷或私有根 |

## findings

### SP-01 Provider payload 零分发

结论：部分通过。

修订版已从单纯排除 provider requests/responses 扩展到
`securityExportPolicy`。导出采用 allowlist-first（允许清单优先），
`producerEvidenceRedaction` 禁止 prompts、rawResponses、providerHeaders、
requestBodies 和 responseBodies，raw provider request/response evidence 明确不
属于 book package。

未完全通过的原因是固定基线要求显式覆盖 provider cache、prompt/completion
payload、token usage 明细和任何可还原 provider 交互内容。当前 Type DD 未点名
provider cache、completion payload、usage 明细或可还原 retry transcript。虽然
unclassified entry fail closed 能降低风险，但尚未达到“显式禁止”的判据。

### SP-02 密钥与凭据零分发

结论：部分通过。

修订版新增 secret scan，要求导出前扫描并在命中时 fail closed。denylist 已覆盖
`.env`、`**/*secret*`、`**/*credential*`、`**/*token*`、`**/*key*`，manifest
forbidden 字段也包含 `apiKey` 和 `bearerToken`。

缺口是固定基线列出的若干凭据类型仍未显式禁止：credential store、
`.npmrc`、`.netrc`、SSH/TLS 私钥、provider auth config、cloud credential 文件和
不含 `key/token/secret/credential` 字样的凭据文件。secret scan 的存在是必要
门禁，但 Type DD 仍需把这些路径与内容类别写入安全合同。

### SP-03 日志与恢复载荷隔离

结论：通过。

修订版明确排除 `**/logs/**`、`**/.durable-recovery.jsonl`、
`**/*.corrupt-*`、`**/debug/**` 和 `**/trace/**`。`externalRuntimeLayout` 将导入
诊断、mount 状态、本地查询缓存和扫描事务状态放到接收方本地根，不属于可分发
书包。secret scan 诊断只允许包含 path、pattern id 和 byte range class，不得
输出命中文本。

包内 `state/` 只允许脱敏 final state snapshot，producer evidence 也只能是脱敏的
package-relative summary。该设计满足日志、恢复载荷和含 payload 诊断默认不导出的
固定判据。

### SP-04 私人路径最小化

结论：部分通过。

修订版显著补强路径安全。publish protocol 要求从 package-relative paths 生成
`BOOK_MANIFEST.json`；`files` 条目必须是 package-relative path；外部 source path
只能作为 provenance，legacy `graph_vault/input` path 只能作为 compatibility
metadata。`securityExportPolicy.pathSafety` 要求拒绝绝对路径、`..`、symlink
escape 和 package 外 hardlink，manifest forbidden 字段包含 `absoluteLocalPath`
和 `userHomePath`。

剩余缺口在 manifest 的定位字段边界。`mount.requiredFields` 仍包含
`packageRoot`，而 Type DD 未明确该字段必须由接收方运行时解析，或限定为
package-relative/vault-relative locator 且不得承载发送方路径。固定判据要求所有
挂载定位字段为 package-relative path；当前设计对 `packageRoot` 的语义仍需收紧。

### SP-05 Manifest 敏感字段控制

结论：部分通过。

修订版新增 `manifestFieldClassification`，把 identity、source kind、input path、
qmd required artifacts、GraphRAG required artifacts 和 compatibility 归为 public，
把 provenance、model/tool summary 和 errorCode 归为 restricted，并禁止
absoluteLocalPath、environmentVariableValue、provider payload、apiKey、
bearerToken 和 userHomePath。

未完全通过的原因是字段分级尚未覆盖固定基线要求的完整面。`metadata/`、
`producerRunIds`、checksum metadata、`createdBy`、qmd build manifest path、
GraphRAG output manifest path、完整命令行、未脱敏异常、prompt/completion payload
和 token usage 明细未被逐项纳入 manifest 敏感边界。该维度从 R1 的未通过提升为
部分通过，但仍需补齐 schema 级禁止项。

### SP-06 Producer evidence 脱敏契约

结论：通过。

修订版为 producer evidence 定义了脱敏边界。允许字段限制为 producer run id、
stage、parent run ids、input/output artifact hashes、model/embedding fingerprint、
toolVersion 和 completedAt；forbidden fields 包含 prompts、rawResponses、
providerHeaders、requestBodies、responseBodies、environment 和 absolutePaths。

GraphRAG query-ready gate 依赖包内 artifact closure、hash binding、schema 和维度
兼容性。gate failure 返回稳定诊断，不隐式触发 provider calls。该设计不要求读取
provider response 文件、请求日志、环境变量或外部运行目录来判定 query-ready。

### SP-07 导出前安全门禁

结论：通过。

修订版明确 export 是 allowlist-first，denylist 是 defense in depth。任何 path、
symlink、manifest field、producer evidence 或 diagnostic entry 无法归类为 safe
时必须 fail closed。安全合同包含 allowed package roots、denied patterns、绝对
路径拒绝、父目录逃逸拒绝、symlink escape 拒绝、package 外 hardlink 拒绝，以及
导出前 secret scan。

`book-package-security.mjs` 的职责也被定义为执行 allowlist、denylist、path safety、
symlink policy、secret scan 和 producer evidence redaction。该维度满足导出前安全
门禁的固定判据。

### SP-08 导入与扫描不触碰敏感根

结论：部分通过。

修订版已经说明 mount scanner failure 不得 mutuate provider payload roots，query
gate failure 不触发 provider calls，接收方 runtime state 放到
`graph_vault/.local/book-runtime/{bookId}`。导入和扫描所需的权威输入也被限定为
book package manifest、sidecars 和包内 artifact closure。

未完全通过的原因是固定基线要求 importer、mount scanner 和 compatibility check
均不得读取、修改或补全 provider payload roots、secrets、日志目录和发送方私有
路径，并且缺失这些材料不得成为 query-ready 失败原因。当前 Type DD 只显式写到
scanner 不修改 provider roots 和 query 不触发 provider calls，尚未把“不读取
敏感根”和“缺失敏感材料不影响 query-ready”扩展到 importer 与兼容性检查。

### SP-09 可变状态与诊断边界

结论：通过。

修订版将共享包默认设为 readonly。导入诊断、mount 状态、本地查询缓存、扫描事务
状态和 qmd projection 分别位于 `graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`，不属于可分发书包。

若产生 debug support bundle，Type DD 要求它是 redacted support bundle。包内
`state/` 只承载脱敏 final snapshot，运行时 import 状态不写入包内。该设计满足
可变状态、诊断与不可变分发闭包分离的固定判据。

### SP-10 安全隐私测试可实施性

结论：部分通过。

修订版测试合同已覆盖 provider payload、logs、corrupt artifacts、runtime recovery
files 排除，以及 secret scan、path escape、symlink escape、unclassified producer
evidence fail closed。这比 R1 明显增强，已足以驱动核心负面测试。

未完全通过的原因是固定基线要求的自动化断言更细。当前测试合同未逐项覆盖 provider
cache、token usage 明细、`.npmrc`/`.netrc`/SSH/TLS 凭据、manifest 敏感字段分级、
producer evidence redaction schema、absolute path 字段、importer 不访问 provider
或 secret/log roots、以及缺失敏感材料不影响 query-ready 的导入侧断言。

## pass_fail

总体判定：部分通过，未达到完全通过。

修订版已经解决 R1 的多个关键安全缺口：导出从 denylist-only 变为
allowlist-first；secret scan、path safety、symlink/hardlink escape、producer
evidence redaction、外部 runtime state 和本地诊断隔离均已纳入 Type DD。SP-03、
SP-06、SP-07 和 SP-09 达到固定基线。

仍未完全通过的维度为 SP-01、SP-02、SP-04、SP-05、SP-08 和 SP-10。主要原因是
若干敏感类别未被显式点名，manifest 字段边界仍不完整，`packageRoot` 语义未完全
package-relative 化，导入/扫描“不读取敏感根”的约束未覆盖 importer 和兼容性检查，
测试合同也没有覆盖全部固定断言。

| baseline id | R2 result | 判定摘要 |
| --- | --- | --- |
| SP-01 | 部分通过 | provider request/response 已禁；cache、completion、usage 明细未显式覆盖。 |
| SP-02 | 部分通过 | secret scan 已有；`.npmrc`、`.netrc`、SSH/TLS 等未显式覆盖。 |
| SP-03 | 通过 | logs、recovery、corrupt、debug、trace 与诊断脱敏边界已满足。 |
| SP-04 | 部分通过 | 路径安全已补强；`packageRoot` 定位字段仍需收紧。 |
| SP-05 | 部分通过 | manifest 字段分级已有；metadata、run ids、异常和命令行仍不完整。 |
| SP-06 | 通过 | producer evidence 脱敏 schema 和 query-ready 独立性满足判据。 |
| SP-07 | 通过 | allowlist、denylist、path/symlink、secret scan 和 fail-closed 已满足。 |
| SP-08 | 部分通过 | query 不触发 provider；importer/scanner 不读取敏感根尚未完整写明。 |
| SP-09 | 通过 | 接收方可变状态和诊断已移出不可变分发闭包。 |
| SP-10 | 部分通过 | 核心测试已有；manifest、凭据细类和导入侧隐私测试不足。 |

## criteria_delta_from_r1

基线判据变化：无。R2 复审使用与 R1 完全相同的 10 个 dimension id、name 与
`passCriteria`；没有新增、删除、重命名维度，也没有改变 `passCriteria`。

| id | R1 result | R2 result | delta |
| --- | --- | --- | --- |
| SP-01 | 部分通过 | 部分通过 | producer evidence raw payload 禁止增强；cache/usage 仍缺。 |
| SP-02 | 部分通过 | 部分通过 | 新增 secret scan；凭据路径细类仍缺。 |
| SP-03 | 部分通过 | 通过 | debug/trace、本地诊断和脱敏 snapshot 边界已补齐。 |
| SP-04 | 部分通过 | 部分通过 | path safety 增强；`packageRoot` 语义仍需澄清。 |
| SP-05 | 未通过 | 部分通过 | 新增 manifest 字段分级；覆盖面仍不完整。 |
| SP-06 | 未通过 | 通过 | producer evidence redaction schema 已补齐。 |
| SP-07 | 部分通过 | 通过 | allowlist-first、secret scan、escape checks 和 fail-closed 已补齐。 |
| SP-08 | 部分通过 | 部分通过 | provider call 隔离增强；不读取敏感根仍未完整覆盖。 |
| SP-09 | 部分通过 | 通过 | 外部 runtime layout 与 readonly package policy 已补齐。 |
| SP-10 | 部分通过 | 部分通过 | 测试合同增强；细粒度隐私断言仍不足。 |

## required_design_changes

1. 在 `securityExportPolicy.deniedPatterns` 和 provider payload 合同中显式加入
   provider cache、prompt dump、completion dump、token usage 明细、retry
   transcript、provider trace event 和可还原交互内容，并规定这些内容不得进入
   manifest files、producer evidence 或 diagnostics。

2. 扩展凭据零分发规则，显式禁止 `.npmrc`、`.netrc`、SSH/TLS 私钥、
   credential store export、cloud credential files、provider auth config、`.pem`、
   `.p12`、`.pfx`、`id_rsa` 和同类凭据进入书包；secret scan 命中必须阻断导出。

3. 收紧 `mount.packageRoot`。该字段应由接收方运行时解析，或被限定为
   package-relative/vault-relative locator；不得保存发送方绝对路径、用户名路径、
   临时目录、旧 batch root 或外部 source root。

4. 扩展 `manifestFieldClassification`，覆盖 `metadata/`、`producerRunIds`、
   checksum metadata、`createdBy`、qmd/graphrag manifest path、完整命令行、
   原始异常、prompt/completion payload 和 token usage 明细，并定义 redact、
   hash、truncate 或 omit 策略。

5. 在 importer、mount scanner 和 compatibility checker 合同中写明：不得读取、
   修改或补全 provider payload roots、secret roots、logs roots 或发送方私有路径；
   缺失这些敏感材料不得造成已打包 artifact 的 query-ready 失败。

6. 扩展 `testContracts`，加入 provider cache、token usage、`.npmrc`、`.netrc`、
   SSH/TLS 私钥、manifest absolute path、manifest sensitive field、producer
   evidence redaction schema、importer 不访问敏感根和缺失敏感根仍可 query-ready
   的自动化断言。

## residual_risks

1. 只靠 denylist 无法覆盖未来工具新增的 cache、trace 或 usage 文件；必须保持
   allowlist-first 和 unclassified fail-closed 的实现约束。

2. producer evidence 脱敏会降低 lineage 可解释性。若后续为了可调试性恢复更多
   run 证据，需重新证明不会泄露 provider payload、环境变量或私人路径。

3. source EPUB、normalized input 和 human metadata 本身可能包含用户批注、购买
   水印或许可信息。这不属于 provider payload 泄露，但仍需要 source-redacted mode
   和 metadata privacy profile。

4. `sourceHash`、run id、时间戳、title slug 和 artifact digest 可能形成弱关联
   信息。高隐私分发场景可能需要匿名化 profile（anonymization profile）。

5. 如果实现把 import diagnostics 或 support bundle 写回 package root，并在二次
   导出时绕过 `securityExportPolicy`，仍可能泄露接收方本地路径或诊断上下文。
