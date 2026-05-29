# GraphRAG Settings Projection Design Audit Report - Agent C

结论：FAIL。

审计对象为固定基准
`audit/graphrag-query-ready-identity-settings-run_1__closed/dev-agent-c/baseline.md`
及以下设计文档：

- `docs/architecture/graphrag-integration.md`
- `docs/architecture/unified-retrieval-plane.md`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml`
- `docs/operations/graphrag-epub-batch-runbook.md`

总体判断：当前设计已说明 `.qmd/index.yml` 是 GraphRAG runtime settings
的配置事实源（source of truth），也说明 `graph_vault/settings.yaml` 是受管
投影（managed projection）。但设计仍不足以指导修复真实失败
`graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`。
缺口集中在 loader 等价比较（loader-equivalent comparison）、安全重写
策略（safe rewrite strategy）、重复 resume 幂等性（idempotency）和 settings
projection repair 的观测面（observability）。

## 固定 Criterion 结果

1. The design defines `.qmd/index.yml` as the source of truth for managed
   GraphRAG settings.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.md:547` 至 `:560` 定义项目
配置入口和优先级，`docs/architecture/unified-retrieval-plane.type-dd.yaml:1254`
至 `:1279` 将 `.qmd/index.yml` 设为 `graph_vault/settings.yaml` 的
`source_of_truth`。

2. `graph_vault/settings.yaml` must be treated as a generated projection, not a
   manually owned configuration file.

结果：PASS。

证据：`docs/architecture/graphrag-integration.md:164` 至 `:173` 说明受管配置由
`src/graphrag/settings-projection.ts` 生成，且不得手工复制模板覆盖。
`docs/architecture/graphrag-integration.md:198` 至 `:201` 说明
`settings.yaml` 是 `.qmd/index.yml` 的 managed projection。

3. Projection comparison must use the same loader semantics as the writer and
   must not compare against an accidentally default-loaded config.

结果：FAIL。

缺口：设计只规定 managed header、source fingerprint 和 fingerprint mismatch 时
拒绝运行，未定义比较端必须使用与 writer 相同的 `.qmd/index.yml` loader、
环境占位解析、默认值填充和 canonical serialization。也未明确禁止把受管投影与
GraphRAG 默认加载配置（default-loaded config）比较。

证据：`docs/architecture/unified-retrieval-plane.md:654` 至 `:657` 只要求
managed header、source fingerprint 和 mismatch reject；
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1274` 至 `:1284`
的 `drift_control` 也只列出 header、fingerprint 与 reject。

4. A mismatched managed settings projection must be recoverable by rewriting
   the projection when source config is valid and no user-owned settings file is
   being overwritten.

结果：FAIL。

缺口：设计把 fingerprint mismatch 定义为拒绝运行（reject），没有定义在
`.qmd/index.yml` 有效、目标文件带 qmd managed marker、且不存在 user-owned
settings file 被覆盖风险时，自动重写 `graph_vault/settings.yaml` 的恢复路径。

证据：`docs/architecture/unified-retrieval-plane.md:654` 至 `:657` 明确是
fingerprint 不匹配时拒绝运行；`docs/architecture/unified-retrieval-plane.type-dd.yaml:1280`
至 `:1284` 同样没有 rewrite / repair 分支。

5. Recovery must be idempotent across repeated resume attempts.

结果：FAIL。

缺口：批量 resume 和本地 identity / capability projection reopen 有幂等约束，但
settings projection mismatch 没有可重复 resume 语义。由于 criterion 4 的 rewrite
路径缺失，设计也没有说明重复执行同一 runId 时应稳定保持同一 source fingerprint、
同一 projected content 和同一 recovery decision。

证据：`docs/operations/graphrag-epub-batch-runbook.md:62` 至 `:79` 定义的是
BookResumePlan 和本地 artifact gate reopen；`docs/architecture/unified-retrieval-plane.type-dd.yaml:1613`
至 `:1625` 只覆盖 query-ready / graph-query projection gate，不覆盖
`graph_vault/settings.yaml`。

6. Projection repair must not delete or invalidate unrelated book-scoped
   GraphRAG outputs.

结果：FAIL。

缺口：identity 和 capability projection repair 明确不得重跑高成本 stage，但 settings
projection repair 没有对应的非破坏性边界。设计未说明重写
`graph_vault/settings.yaml` 时不得删除、迁移、清空或标记 stale unrelated
`graph_vault/books/<book_id>/output`。

证据：`docs/architecture/unified-retrieval-plane.md:723` 至 `:731` 和
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1681` 至 `:1689`
只保护 `graph_identity_projection_missing` 场景下的
`graph_extract`、`community_report` 与 `embed`，没有 settings projection repair
等价规则。

7. Logs and recovery summaries must make the active GraphRAG stage, command,
   and projection repair decision observable.

结果：FAIL。

缺口：事件和 recovery summary 对 failed stage、command failure、identity/capability
repair metadata 有约束，但没有 settings projection repair 的 decision 字段，例如
`settings_projection_rewritten`、`settings_projection_rejected_user_owned`、
`settingsProjectionSourceFingerprint` 或 rewrite/reject reason。真实失败发生时，
操作者仍无法仅通过 recovery summary 判断是安全重写、拒绝覆盖用户文件，还是
loader 语义不一致。

证据：`docs/architecture/unified-retrieval-plane.type-dd.yaml:341` 至 `:392`
列出 event log 的 `failureKind`、`recoveryDecision`、`failedStage` 和 local reopen
metadata；`:392` 至 `:410` 列出 recovery summary 字段。这些字段不包含 settings
projection repair decision。

8. Long-running GraphRAG stages must be resumable or recoverable after runner
   interruption without corrupting batch state.

结果：PASS。

证据：`docs/operations/graphrag-epub-batch-runbook.md:44` 至 `:53` 定义 runner
ownership 和 heartbeat stale recovery；`:62` 至 `:79` 定义同一 runId resume
和 BookResumePlan.nextStage；`:183` 至 `:223` 定义长 GraphRAG stage 的 timeout、
transient retry、provider recovery wait 和 incomplete resume。
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1626` 至 `:1646`
也定义 ownership、command timeout 和 retry budget。

9. Design acceptance must include the real failure
   `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`.

结果：FAIL。

缺口：四份被审计文档未包含该真实 failure text，也未将其纳入 acceptance /
focused regression。当前 acceptance 只覆盖 document identity missing 和
graph capability unknown / not-ready 两类历史失败。

证据：`docs/architecture/unified-retrieval-plane.type-dd.yaml:1959` 至 `:1976`
列出的真实回归是 `book-9f587b71073a-ad95ce2f`、`GraphRAG document identity is
missing for query_ready: doc-fd8875181a17` 和
`capabilityScope references unknown or not-ready graphCapabilityId(s):
book-356ff4920cdf-0bbd8bdb:graph_query`，未包含 settings projection mismatch。

10. The design must specify where implementation tests and operational runbook
    notes belong.

结果：FAIL。

缺口：设计为 identity / capability projection reopen 指定了 regression 和 runbook
内容，但未指定 settings projection mismatch 的实现测试位置、契约 fixture、
负例矩阵或操作手册章节。缺少至少以下归属：settings projection builder /
loader-equivalence tests、user-owned settings overwrite rejection tests、same
runId repeated resume idempotency tests，以及 runbook 中的 settings repair
操作说明。

证据：`docs/architecture/unified-retrieval-plane.type-dd.yaml:1978` 至 `:1988`
只要求 local projection reopen 和 negative reopen tests；
`docs/operations/graphrag-epub-batch-runbook.md:155` 至 `:169` 只要求两个
query-ready / graph-query 真实失败文本的 focused regression。

## 必须修复项

- 定义 settings projection drift 的比较契约：比较端必须复用 writer 的
  `.qmd/index.yml` 解析、默认值填充、环境占位保留、排序和序列化语义，不得与
  GraphRAG default-loaded config 比较。
- 定义安全 rewrite 策略：仅当 `graph_vault/settings.yaml` 带 qmd managed marker、
  source config valid、目标不是 user-owned file 时，才重写 managed projection；
  否则 fail closed，并给出 machine-readable recovery reason。
- 将 settings projection repair 纳入 batch event、command log 和
  `recovery-summary.json`，记录 active stage、command、rewrite/reject decision、
  source fingerprint、project config locator 和 redacted reason。
- 在 acceptance / tests / runbook 中加入真实失败
  `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`，
  覆盖 rewrite success、user-owned rejection、loader mismatch negative 和重复
  same runId resume 幂等性。
