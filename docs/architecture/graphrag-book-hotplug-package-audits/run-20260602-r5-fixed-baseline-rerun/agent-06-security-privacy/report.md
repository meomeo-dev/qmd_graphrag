# agent-06-security-privacy R5 固定基准复审报告

## scenario

用户分发单本 GraphRAG 书包时，导出的
`graph_vault/books/{bookId}` 目录不得泄露 provider payload、密钥、日志、
恢复载荷、调试转储、发送方私人路径或接收方不需要的本地运行状态。

复审对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

主文档声明 R3 fixups 为规范性补充文档，适用于 identity semantics、schema
upgrade、migration evidence、sensitive material extension、scanner no-read、
qmd availability、qmd diagnostics 和 compatibility bridge lifecycle。本轮仅评估
设计文档是否满足固定 10 维 `passCriteria`。

本轮未读取 provider payload、secrets、`.env`、凭据、请求响应日志、日志
payload、恢复 payload 或私有运行数据。

## reused_fixed_baseline

本轮复用固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-06-security-privacy/baseline.yaml`

固定 10 维保持原顺序，未新增、删除、重命名或重排任何审计维度，未修改任何
`passCriteria`。

| id | name | R5 result |
| --- | --- | --- |
| SP-01 | Provider payload 零分发 | 通过 |
| SP-02 | 密钥与凭据零分发 | 通过 |
| SP-03 | 日志与恢复载荷隔离 | 通过 |
| SP-04 | 私人路径最小化 | 通过 |
| SP-05 | Manifest 敏感字段控制 | 部分通过 |
| SP-06 | Producer evidence 脱敏契约 | 通过 |
| SP-07 | 导出前安全门禁 | 通过 |
| SP-08 | 导入与扫描不触碰敏感根 | 通过 |
| SP-09 | 可变状态与诊断边界 | 通过 |
| SP-10 | 安全隐私测试可实施性 | 部分通过 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R5 baseline 是否存在 | 通过 |
| baseline auditAgent | `agent-06-security-privacy` |
| baseline 是否为固定 10 维 | 通过 |
| 维度 id 顺序 | 通过，仍为 SP-01 到 SP-10 |
| 维度名称 | 通过，未新增、删除、重命名 |
| passCriteria | 通过，未修改 |
| baseline SHA-256 | `28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580` |
| 与上一轮 R4 baseline 内容比较 | 通过，内容一致 |
| baseline.yaml 覆盖状态 | 通过，本轮未覆盖 baseline.yaml |
| 本轮写入文件 | 仅本 `report.md` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、日志载荷或私有根 |

## findings

### SP-01 Provider payload 零分发

结论：通过。

主文档在 scope 中排除 provider 请求、provider 响应、密钥和日志 payload 的
分发，并在 `bookManifestSchema.exclusions`、`securityExportPolicy` 和
`sensitiveMaterialTaxonomy` 中禁止 provider requests、provider responses、
completion、prompt、token-usage、request bodies、response bodies、raw prompts
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
credentials。设计满足密钥、凭据、provider auth config、credential store 和相似
凭据不得进入书包，并在导出前 fail-closed 扫描的要求。

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
`BOOK_MANIFEST.json` 中。absoluteLocalPath、userHomePath、originalInboxPath、
tempDirectoryPath 和 shellCommandCwd 均被归入私人路径敏感字段。该维度满足固定
判据。

### SP-05 Manifest 敏感字段控制

结论：部分通过。

主文档已有 `bookManifestSchema`，覆盖 identity、mount、source、input、qmd、
graphrag、files、checksums、exclusions 和 compatibility。`securityExportPolicy`
对 manifest 字段给出 public、restricted、forbidden 分类，并禁止 provider
payload、API key、bearer token、environment value、absoluteLocalPath 和
userHomePath。`sensitiveMaterialTaxonomy.manifestSensitiveFields` 又禁止
commandLineArgsWithSecrets、environment、providerHeaders、requestBodies、
responseBodies、rawPrompts、rawCompletions 和 tokenUsageDetails。

R3 fixups 补强 migration evidence forbidden fields，并规定
`BOOK_MANIFEST.mount.packageRoot` 不得携带绝对本机路径。

仍为部分通过的原因是固定判据要求 `BOOK_MANIFEST.json` schema 对 identity、
source、qmd、graphrag、compatibility、producerRunIds 和 metadata 字段都规定
敏感信息边界。当前设计对 `metadata/**` 允许导出并纳入 secret scan，但未定义
manifest metadata section 或 metadata 子字段边界；对 `producerRunIds`、
`createdBy`、diagnostic detail、异常摘要、完整命令行和环境变量字段的 schema 级
禁止规则仍偏间接。`commandLineArgsWithSecrets` 只禁止带 secret 的命令行，但固定
判据要求禁止完整命令行进入 manifest。

### SP-06 Producer evidence 脱敏契约

结论：通过。

`securityExportPolicy.producerEvidenceRedaction.allowedFields` 将可导出 producer
evidence 限定为 producerRunId、stage、parentProducerRunIds、input/output
artifact hashes、model/embedding fingerprint、toolVersion 和 completedAt。
forbiddenFields 禁止 prompts、rawResponses、providerHeaders、requestBodies、
responseBodies、environment 和 absolutePaths。

GraphRAG query-ready gate 依赖包内 artifact closure、hash binding、schema、
兼容性输入和 producer lineage summary，不要求读取 provider response 文件、请求
日志、环境变量或外部运行目录。R3 fixups 的 migration evidence schema 也禁止
providerRequestPayload、providerResponsePayload、rawPrompt、rawCompletion、
absoluteLocalPath 和 secretValue。该维度满足固定判据。

### SP-07 导出前安全门禁

结论：通过。

主文档规定 export 为 allowlist-first。任何 path、symlink、manifest field、
producer evidence 或 diagnostic entry 无法归类为 safe 时必须 fail closed。安全
门禁覆盖 allowed package roots、denied patterns、绝对路径拒绝、父目录逃逸拒绝、
symlink escape 拒绝、package 外 hardlink 拒绝和导出前 secret scan。

`moduleBoundary` 将 `book-package-security.mjs` 的职责定义为执行 allowlists、
denylist defense、path safety、symlink policy、secret scan 和 producer evidence
redaction。该维度满足固定判据。

### SP-08 导入与扫描不触碰敏感根

结论：通过。

主文档定义 scanner read policy：import 为
`manifest_and_sidecars_first_no_sensitive_roots`，mountScan 为
`no_provider_roots_no_runtime_payload_roots`，migration 为
`no_raw_provider_payload_reads`，query 为 `no_provider_calls_on_gate_failure`。

R3 fixups 为 importer、mount scanner、compatibility checker 和 query gate 分别
列出 mayRead 与 mustNotRead，明确不得读取 provider payload roots、credential
stores、runtime logs、raw recovery payloads、runtime diagnostic payloads、raw
prompts、raw completions、provider auth config、credentials 和 raw logs。缺失敏感
根从不作为 query-ready 的必要条件；如果某包需要敏感根证明 readiness，该包无效
并标记为 not_query_ready。该维度满足固定判据。

### SP-09 可变状态与诊断边界

结论：通过。

共享包默认 readonly。导入诊断、mount 状态、本地查询缓存、扫描事务状态和 qmd
projection 分别位于 `graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`，不属于可分发书包。

若产生 debug support bundle，Type DD 要求它是 redacted support bundle。R3
fixups 规定 readonly mounted package 的 local projection 默认不再导出；只有显式
repack 才能创建新的 packageGeneration 并重新生成 manifest 与 sidecar。qmd
diagnostics 必须 stable、bounded、package-relative，并且不含 provider payloads
和 absolute paths。该维度满足固定判据。

### SP-10 安全隐私测试可实施性

结论：部分通过。

主文档测试合同已覆盖 provider payload、logs、corrupt artifacts、runtime
recovery files 排除，secret scan、path escape、symlink escape 和 unclassified
producer evidence fail-closed。`sensitiveMaterialTaxonomy.tests` 覆盖 provider
cache path、`.npmrc`、`.netrc`、SSH key、TLS private key、absolute path
redaction、importer refuses sensitive root 和 scanner refuses provider root。R3
fixups 的 no-read contract 使导入、扫描、兼容性检查和 query gate 的安全边界更
具体。

仍为部分通过的原因是固定判据要求可自动化断言覆盖 manifest 敏感字段、producer
evidence 脱敏和导入不访问 provider。当前测试合同对 `BOOK_MANIFEST` forbidden /
restricted 字段、metadata 字段、producer evidence allowed / forbidden 字段、
compatibility checker no-read 行为，以及缺失敏感根不影响 query-ready 的断言仍偏
摘要式，尚未形成 fixture 级或 schema 级测试矩阵。

## pass_fail

总体结论：部分通过。

| 结果 | 数量 | 维度 |
| --- | ---: | --- |
| 通过 | 8 | SP-01、SP-02、SP-03、SP-04、SP-06、SP-07、SP-08、SP-09 |
| 部分通过 | 2 | SP-05、SP-10 |
| 未通过 | 0 | 无 |

R3 fixups 已关闭 provider cache、provider auth config、credential store、
mount.packageRoot、scanner no-read 和缺失敏感根不影响 query-ready 等关键缺口。
剩余问题集中在 manifest 字段 schema 细化和安全隐私测试合同可实施性。

## criteria_delta_from_previous_run

上一轮对照为：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-06-security-privacy/report.md`

R5 固定 baseline 与 R4 baseline 内容一致，SHA-256 均为
`28416a825150494fbd6cfdd6607df7b6f8b9f6ba66e62b39b103461599e36580`。本轮未发现
设计文档相对上一轮产生可改变 agent-06 判定的新增安全隐私合同。

| id | R4 result | R5 result | delta |
| --- | --- | --- | --- |
| SP-01 | 通过 | 通过 | 无变化 |
| SP-02 | 通过 | 通过 | 无变化 |
| SP-03 | 通过 | 通过 | 无变化 |
| SP-04 | 通过 | 通过 | 无变化 |
| SP-05 | 部分通过 | 部分通过 | metadata、完整命令行和 manifest 字段边界仍不足 |
| SP-06 | 通过 | 通过 | 无变化 |
| SP-07 | 通过 | 通过 | 无变化 |
| SP-08 | 通过 | 通过 | 无变化 |
| SP-09 | 通过 | 通过 | 无变化 |
| SP-10 | 部分通过 | 部分通过 | manifest 与 producer evidence 测试仍不够具体 |

## required_design_changes

1. 补齐 `BOOK_MANIFEST.json` metadata section 或 metadata 字段 schema，明确允许
   字段、restricted 字段、forbidden 字段和 redaction 规则。

2. 在 manifest schema 层显式覆盖 `producerRunIds`、`createdBy`、diagnostic
   detail、异常摘要、命令行字段和环境变量字段，禁止完整命令行、未脱敏异常、
   raw payload、secret、私有路径和环境变量值进入 manifest。

3. 将 manifest 敏感字段测试拆成可执行断言，至少覆盖 forbidden 字段拒绝、
   restricted 字段脱敏、metadata 字段扫描和 `producerRunIds` 只允许非敏感 id。

4. 将 producer evidence 脱敏测试拆成 schema 级断言，分别验证 allowed fields
   可保留、forbidden fields fail-closed、payload 文本不进入诊断。

5. 将 no-read 测试拆成 importer、mount scanner、compatibility checker 和 query
   gate 四组 fixture，断言缺失 provider/secrets/log roots 不导致 query-ready
   失败，且不触发 provider 调用或读取 provider root。

## residual_risks

- `metadata/**` 作为允许导出根存在合理业务需求，但缺少子 schema 时仍可能承载
  私人备注、原始异常文本、完整命令行或路径化 provenance。

- `producerRunIds` 本身通常不是 secret，但若 run id 生成策略嵌入本机路径、
  用户名、时间批次命名或 provider 标识，当前设计需要依赖上游生成规则保证安全。

- secret scan 与 denylist 不能证明无敏感信息；生产实现仍需要 allowlist schema、
  结构化解析、字段级 redaction 和 fail-closed 分类共同执行。

- 本轮仅审计 Type DD 设计合同是否满足固定基准，不证明现有实现脚本已经满足这些
  合同。
