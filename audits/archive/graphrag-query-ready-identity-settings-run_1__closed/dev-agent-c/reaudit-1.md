# GraphRAG Settings Projection Design Reaudit 1 - Agent C

结论：PASS。

复审基准为
`audit/graphrag-query-ready-identity-settings-run_1__closed/dev-agent-c/baseline.md`。
本次只审计当前工作区最新设计文档，未修改 baseline。

前次 FAIL 的主要缺口已经在当前设计中补齐：settings projection drift 现在有
writer-equivalent loader comparison、安全 atomic rewrite、user-owned fail-closed、
same-runId 幂等恢复、book-scoped output 非破坏性边界、事件与
`recovery-summary.json` 观测字段，以及真实 failure acceptance、测试和 runbook
归属。

## 固定 Criterion 结果

1. The design defines `.qmd/index.yml` as the source of truth for managed
   GraphRAG settings.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.md:553` 至 `:567` 定义项目配置
入口和优先级；`:660` 至 `:663` 明确 `.qmd/index.yml` 是配置事实源。
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1279` 至 `:1304` 将
`.qmd/index.yml` 设为 `graph_vault/settings.yaml` 的 `source_of_truth`。

2. `graph_vault/settings.yaml` must be treated as a generated projection, not a
   manually owned configuration file.

结果：PASS。

证据：`docs/architecture/graphrag-integration.md:164` 至 `:181` 说明
`settings.yaml` 由 `src/graphrag/settings-projection.ts` 从 `.qmd/index.yml`
投影生成，不手工复制模板覆盖；`docs/architecture/unified-retrieval-plane.md:660`
至 `:663` 明确它是受管生成物，不是人工维护配置。

3. Projection comparison must use the same loader semantics as the writer and
   must not compare against an accidentally default-loaded config.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.md:665` 至 `:668` 要求比较端复用
writer 等价 loader 语义，包括同一 `.qmd/index.yml` 解析入口、默认值填充、
环境变量占位保留、排序和 canonical serialization，并禁止与 GraphRAG
default-loaded config 比较。`docs/architecture/unified-retrieval-plane.type-dd.yaml:1311`
至 `:1316` 给出同一规则。

4. A mismatched managed settings projection must be recoverable by rewriting
   the projection when source config is valid and no user-owned settings file is
   being overwritten.

结果：PASS。

证据：`docs/architecture/graphrag-integration.md:177` 至 `:180` 将 source
fingerprint mismatch 定义为可恢复 drift，并要求 managed marker、valid source
config 和非 user-owned file 才能安全重写。`docs/architecture/unified-retrieval-plane.type-dd.yaml:1317`
至 `:1323` 要求 atomic rewrite，并对缺少 managed marker、invalid source config
或 user-owned target fail-closed。

5. Recovery must be idempotent across repeated resume attempts.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.md:669` 至 `:672` 要求重复同一
`runId` resume 产生相同 projected content、source fingerprint 和 recovery
decision。`docs/architecture/unified-retrieval-plane.type-dd.yaml:1674` 至 `:1678`
进一步规定成功 rewrite 后第二次 resume 只观察 matching projection state，不再重写。
`docs/operations/graphrag-epub-batch-runbook.md:99` 至 `:107` 在操作手册中给出同一
幂等要求。

6. Projection repair must not delete or invalidate unrelated book-scoped
   GraphRAG outputs.

结果：PASS。

证据：`docs/architecture/graphrag-integration.md:180` 至 `:182` 限定修复只改写
`graph_vault/settings.yaml`，不得删除或污染 book-scoped output。
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1324` 至 `:1327` 规定
settings projection repair 只能改 `settings.yaml` 和 atomic-write 临时文件，不得
delete、migrate、truncate 或 mark stale 任何
`graph_vault/books/<book_id>/output` artifact。

7. Logs and recovery summaries must make the active GraphRAG stage, command,
   and projection repair decision observable.

结果：PASS。

证据：`docs/architecture/graphrag-integration.md:208` 至 `:212` 要求 drift 修复事件
和 recovery summary 记录 rewrite/reject decision、source fingerprint、project
config locator、settings locator、evidence locator 和 redacted reason。
`docs/architecture/unified-retrieval-plane.md:758` 至 `:761` 明确还要记录 active
GraphRAG stage 和 active command。`docs/architecture/unified-retrieval-plane.type-dd.yaml:416`
至 `:435` 及 `:1679` 至 `:1685` 将这些字段纳入 summary / event 观测契约。

8. Long-running GraphRAG stages must be resumable or recoverable after runner
   interruption without corrupting batch state.

结果：PASS。

证据：`docs/operations/graphrag-epub-batch-runbook.md:47` 至 `:56` 定义 runner
ownership、heartbeat TTL 和 stale running recovery；`:65` 至 `:82` 定义同一
runId resume、BookResumePlan.nextStage 和不重跑已完成 stage。
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1650` 至 `:1656` 定义 batch
resume 与 retry window；settings repair 继续当前 BookResumePlan，不绕过批量状态。

9. Design acceptance must include the real failure
   `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.md:868` 至 `:873` 明确将该真实
failure text 加入回归验收，并要求 valid source config rewrite、user-owned
settings 负例、loader-equivalence mismatch 负例、invalid source config 负例和
same-runId 幂等断言。`docs/architecture/unified-retrieval-plane.type-dd.yaml:2049`
至 `:2059` 将同一 failure text 纳入 acceptance requirements。

10. The design must specify where implementation tests and operational runbook
    notes belong.

结果：PASS。

证据：`docs/architecture/unified-retrieval-plane.type-dd.yaml:2056` 至 `:2059`
指定 settings projection tests 覆盖 writer-equivalent loader comparison、
default-loaded config mismatch rejection、user-owned overwrite rejection、
invalid source config rejection、same-runId idempotency 和 recovery summary
fields。`docs/operations/graphrag-epub-batch-runbook.md:99` 至 `:109` 记录操作手册
恢复规则；`:184` 至 `:194` 记录 focused regression 与负例归属。

## 残余风险

- 本次为设计复审，未运行实现测试，也未验证实际 runner 是否已按设计实现。
- 设计已满足固定基准；后续实现审计应重点核对 typed fields、atomic rewrite、
  user-owned detection 和 loader-equivalent serialization 是否真实落地。
