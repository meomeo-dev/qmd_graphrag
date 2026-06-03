# implementation audit: agent-3-runtime-provider

## scenario

重点场景（primary scenario）：
外部 provider、环境变量（environment variables）和
`graph_vault/settings.yaml` 投影存在波动时，单本书热插拔包是否仍能依靠
状态管理（state management）与恢复机制（recovery mechanism）继续运行，
并保持 fail-closed。

## audit scope

本轮只审计以下材料与代码：

- `docs/architecture/graphrag-book-hotplug-package.README.md`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
- `src/cli/qmd.ts`
- `src/integrations/python-bridge.ts`
- `src/graphrag/book-hotplug-catalog.ts`
- `src/graphrag/settings-projection.ts`
- `scripts/graphrag/book-hotplug-package.mjs`
- `scripts/graphrag/backfill-hotplug-packages.mjs`
- `test/cli-graphrag-route.test.ts`
- `test/unified-query.test.ts`

本轮未读取 provider payload、provider response body、secret 文件、
`.env` 实际值、请求响应日志载荷或外部私有运行目录。

## reused_fixed_baseline

`agent-3-runtime-provider` 目录此前没有独立冻结基线。本轮不发明新维度，
直接复用既有固定基线：

- source:
  `docs/architecture/graphrag-book-hotplug-package-audits/agent-09-graphrag-query/baseline.yaml`
- copied to:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r1__open/agent-3-runtime-provider/baseline.yaml`
- SHA-256:
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

复用原因：
该固定 10 维基线直接覆盖单书 GraphRAG 直接查询、artifact gate、
producer lineage、provider no-read、恢复诊断与测试合同，和
runtime/provider/settings 波动场景最接近。维度、顺序和
`passCriteria` 均未改动。

## baseline_integrity_check

| check | result |
| --- | --- |
| baseline 文件存在 | PASS |
| baseline 维度数量 | PASS，10 个 |
| baseline id 与顺序 | PASS，与复用源完全一致 |
| `passCriteria` 是否变更 | PASS，未变更 |
| 是否创建新基准 | NO |
| 是否覆盖 baseline.yaml | NO |
| 本轮写入范围 | `baseline.yaml` 复制，`report.md` 新增 |

## overall_result

总评：

- PASS: 2
- PARTIAL: 5
- FAIL: 3

当前实现已经补上一个关键恢复点：
CLI 会在 GraphRAG 查询前自动修复缺失或漂移的
`graph_vault/settings.yaml` 管理投影（managed projection），因此
fresh vault 场景下，settings 缺失不再是立即阻塞点。

但当前实现还没有真正落成 manifest-first direct query path。
查询入口仍然依赖 capability/catalog 路径，并且 `dataDir` 仍指向旧布局
`books/{bookId}/output`，而不是热插拔设计要求的
`books/{bookId}/graphrag/output`。这使得 runtime/provider 波动场景下，
最核心的“只拷一书目录即可挂载查询”仍未闭合。

## fixed baseline review

### 1. `direct_query_entrypoint`

- 编号（id）: `direct_query_entrypoint`
- 名称（name）: 直接查询入口
- 通过标准（passCriteria）:
  挂载扫描完成后，GraphRAG 查询入口能仅凭 `BOOK_MANIFEST.json`
  和包内 artifacts 定位本书查询上下文，不依赖全局 catalog、旧 batch
  状态、provider payload、发送方绝对路径或人工补参。
- 结论（result）: FAIL

证据：

1. 设计定稿已经要求 manifest-first resolver：
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942-989`
   明确 `manifestFirstDirectQueryResolver`，并要求
   `catalog projection deleted` 时 direct query gate 仍可成功。
2. CLI 在查询前确实会自愈 settings 投影：
   `src/cli/qmd.ts:3274-3277`、
   `src/cli/qmd.ts:3365-3367`、
   `src/cli/qmd.ts:5247-5255`，
   最终调用
   `src/graphrag/settings-projection.ts:361-451`
   的 create/rewrite 逻辑。
3. 但真正的查询入口仍不是 manifest-first：
   `src/cli/qmd.ts:3405-3462`
   先通过 `loadGraphQueryCapabilities()` 和 route decision 选书，
   再调用 runtime。
4. 更关键的是，CLI 传入的 `dataDir` 仍是旧路径
   `graph_vault/books/{bookId}/output`
   （`src/cli/qmd.ts:3440`），而热插拔包和脚本都把 GraphRAG 产物定义在
   `graphrag/output`
   （`scripts/graphrag/book-hotplug-package.mjs:31-43`,
   `:523-531`）。
5. 测试夹具也仍写入旧布局
   `graph_vault/books/{bookId}/output`
   （`test/cli-graphrag-route.test.ts:207-325`），所以没有证明
   hotplug-v1 的真实目录结构已被查询入口消费。

判定：
settings 自愈已实现，但 manifest-first direct query resolver 尚未实现；
现有查询路径仍依赖 catalog/capability 选择和旧目录布局，因此本维度未通过。

### 2. `artifact_minimum_closure`

- 编号（id）: `artifact_minimum_closure`
- 名称（name）: 查询 Artifact 最低闭包
- 通过标准（passCriteria）:
  Type DD 明确列出 GraphRAG 查询所需的最低 artifact 集合、文件角色、schema
  version、bytes、sha256 与 required 标记，并说明缺少任一必需 artifact 时
  必须 fail closed 为 not query-ready。
- 结论（result）: PARTIAL

证据：

1. 设计文档给出了最低闭包：
   `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:582-593`
   列出最低 artifact 集合；
   `:1614` 附近定义 required artifact metadata。
2. 实现脚本也有一组固定 `RequiredGraphRagArtifacts`：
   `scripts/graphrag/book-hotplug-package.mjs:31-43`。
3. `files` 闭包包含 `bytes`、`sha256`、`required`
   和部分 `producerRunId`：
   `scripts/graphrag/book-hotplug-package.mjs:191-225`,
   `:290-337`。
4. `validateBookHotplugPackage()` 会对 required artifacts、
   file bytes 和 sha256 做 fail-closed 校验：
   `scripts/graphrag/book-hotplug-package.mjs:607-717`。
5. 但实现没有把
   `graphrag/output/artifact-metadata.json`
   纳入 `RequiredGraphRagArtifacts`，也没有在校验时验证 artifact metadata rows，
   而定稿合同把它列为 manifest-first resolver 必需输入：
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:955-967`。

判定：
最低文件闭包和 checksum 闭包已部分实现，但 artifact metadata
层还未进入当前实现闭环，因此只能部分通过。

### 3. `artifact_gate_state_machine`

- 编号（id）: `artifact_gate_state_machine`
- 名称（name）: Artifact Gate 状态机
- 通过标准（passCriteria）:
  设计定义从 copied、candidate、validated、mounted、query-ready、
  visible_not_query_ready 到 quarantined 的状态、转移条件、诊断输出和禁止
  查询条件，artifact gate 通过前不得投影为可查询。
- 结论（result）: FAIL

证据：

1. 定稿合同已经定义完整状态机：
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990-1097`。
2. 当前代码里，`mountScanBookPackages()` 只有两类结果：
   `mounted` 或 `failed`
   （`scripts/graphrag/book-hotplug-package.mjs:720-752`）。
3. `src/graphrag/book-hotplug-catalog.ts:104-135`
   只加载 `BOOK_MANIFEST.json + PUBLISH_READY.json`，
   `:335-347` 只在 catalog 缺失时重建 projection，
   没有落地 copied/candidate/validating/validated/
   visible_not_query_ready/quarantined/rolled_back 的显式状态机。

判定：
状态机是设计已定稿、实现未落地的典型项。当前实现不满足固定基线。

### 4. `producer_lineage_completeness`

- 编号（id）: `producer_lineage_completeness`
- 名称（name）: Producer Lineage 完整性
- 通过标准（passCriteria）:
  每个查询必需 artifact 均可追溯到 producer run、step、input hash、tool
  version、schema version、生成时间和上游 artifact hash；lineage 不完整时
  不得声明 queryReady。
- 结论（result）: FAIL

证据：

1. 设计要求完整 lineage schema：
   `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:594-609`。
2. 当前包构建只从 legacy manifest / graph manifest 推断一组
   `producerRunIds`
   （`scripts/graphrag/book-hotplug-package.mjs:350-364`），
   并在 GraphRAG file entries 上附带 `producerRunId`
   （`scripts/graphrag/book-hotplug-package.mjs:325-347`）。
3. 但当前实现没有把 `inputArtifactHashes`、`outputArtifactHashes`、
   `toolVersion`、`completedAt`、`parentProducerRunIds`、
   `modelProfile`、`embeddingProfile` 作为每个 query 必需 artifact
   的验证输入落地到包校验或 catalog 投影。
4. `src/graphrag/book-hotplug-catalog.ts`
   也没有读取 `graphrag/runs` 来做 lineage 完整性校验，
   仅从 manifest、graph identity、output manifest、qmd build manifest
   投影 capability。

判定：
当前只有 producer run id 级别的弱绑定，没有完整 lineage 验证链，未通过。

### 5. `lineage_artifact_binding`

- 编号（id）: `lineage_artifact_binding`
- 名称（name）: Lineage 与 Artifact 绑定
- 通过标准（passCriteria）:
  manifest 中 producerRunIds、graphrag/runs 证据和 files 闭包之间有可验证
  引用关系，能证明 artifact 是声明 producer 生成的当前文件，而非孤立残留或
  被替换文件。
- 结论（result）: PARTIAL

证据：

1. `BOOK_MANIFEST.files` 确实记录了 path、sha256、bytes、role，
   GraphRAG 输出路径也会映射 `producerRunId`
   （`scripts/graphrag/book-hotplug-package.mjs:191-225`,
   `:325-347`）。
2. `validateBookHotplugPackage()` 会校验 file sha256 / directory sha256
   （`scripts/graphrag/book-hotplug-package.mjs:677-704`）。
3. 但当前实现没有把 `graphrag/runs` 中的 producer evidence
   与 file closure 做可验证引用关系校验，也没有 producer output hash
   绑定检查。
4. `src/graphrag/book-hotplug-catalog.ts`
   完全没有读取 `graphrag/runs`。

判定：
当前实现有 file/hash 绑定，也有弱 `producerRunId` 标记，但还没有形成
“run evidence -> output hash -> current file”的完整可验证链，因此部分通过。

### 6. `schema_runtime_compatibility`

- 编号（id）: `schema_runtime_compatibility`
- 名称（name）: Schema 与运行时兼容
- 通过标准（passCriteria）:
  设计区分 GraphRAG runtime、parquet schema、LanceDB schema、embedding
  model/dimension、output manifest schema 和 package layout schema，并规定
  兼容失败的 query gate 行为。
- 结论（result）: PARTIAL

证据：

1. settings 运行时投影修复已经实现：
   `src/graphrag/settings-projection.ts:82-250`
   构建 runtime settings；
   `:361-451` 会在缺失或漂移时 create/rewrite；
   CLI 在 GraphRAG 查询前强制执行这一修复
   （`src/cli/qmd.ts:3274-3277`, `:3365-3367`, `:5247-5255`）。
2. 这意味着 `graph_vault/settings.yaml` 缺失这一类 runtime 波动，
   当前实现已经具备恢复能力。
3. 但 hotplug 包校验本身仍只做 presence/hash 校验，
   没有在 `scripts/graphrag/book-hotplug-package.mjs:607-717`
   中验证 parquet schema、LanceDB schema、embedding dimension、
   runtime reader version 等兼容项。
4. 相关测试也没有覆盖 schema incompatible 的 hotplug 负例；
   定稿合同要求这类测试：
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1091-1097`。

判定：
settings/runtime config 恢复已实现，但 package-level schema/runtime
兼容 gate 仍未闭环，只能部分通过。

### 7. `query_scope_isolation`

- 编号（id）: `query_scope_isolation`
- 名称（name）: 单书查询范围隔离
- 通过标准（passCriteria）:
  挂载后直接查询只能读取该书包声明的 GraphRAG output、producer evidence 和
  必要投影，不能把其他书、历史残留、全局缓存或 sibling roots 混入查询上下文。
- 结论（result）: PASS

证据：

1. CLI 把选中的 `selectedBookIds`、`graphCapabilityIds`、`sourceIds`、
   `documentIds`、`contentHashes` 和 `artifactIds`
   作为 capability scope 显式传入 runtime
   （`src/cli/qmd.ts:3338-3345`, `:3444-3451`）。
2. `test/unified-query.test.ts:795-815`
   明确验证显式 GraphRAG route 不依赖 qmd recall，
   作用域从 graph capabilities 构建。
3. `test/cli-graphrag-route.test.ts:827-844`
   验证 `--graph-book-id` 只命中选中的一本书，且返回结果中不泄露 vault 根路径。

判定：
尽管实际 `dataDir` 仍是旧布局，但查询 scope 是单书隔离的，本维度通过。

### 8. `privacy_payload_exclusion`

- 编号（id）: `privacy_payload_exclusion`
- 名称（name）: Provider Payload 排除
- 通过标准（passCriteria）:
  artifact gate 和 lineage 验证不得读取、要求或分发 provider request、
  provider response、secrets、logs payload 或 recovery payload；需要的证据以
  脱敏 metadata、hash 和 run manifest 表达。
- 结论（result）: PASS

证据：

1. 包构建脚本显式拒绝 `.env`、provider requests、provider responses、logs、
   debug、trace、durable recovery、corrupt 文件：
   `scripts/graphrag/book-hotplug-package.mjs:18-29`,
   `:93-123`, `:677-688`。
2. settings 投影写入的是 env placeholders，
   不是 secret 实值：
   `src/graphrag/settings-projection.ts:53-70`,
   `:135-170`。
3. Python bridge 会对 payload/secret 做脱敏，并只投影白名单 env：
   `src/integrations/python-bridge.ts:198-235`,
   `:333-341`, `:347-352`。
4. `test/unified-query.test.ts:739-757`
   验证 provider runtime failure 被转换为 typed error，
   不把 bridge 内部 provider 细节直接透传为结构化响应。

判定：
provider payload exclusion 在当前实现中是成立的，本维度通过。

### 9. `recovery_diagnostics`

- 编号（id）: `recovery_diagnostics`
- 名称（name）: 失败恢复与诊断
- 通过标准（passCriteria）:
  当 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容或 producer
  evidence 缺失时，设计给出稳定诊断、修复入口、quarantine 行为和 catalog
  projection 回滚规则。
- 结论（result）: PARTIAL

证据：

1. settings 投影修复会返回稳定 reason：
   `managed_projection_created`、
   `managed_projection_valid`、
   `managed_projection_rewritten`
   （`src/graphrag/settings-projection.ts:374-404`, `:420-450`）。
2. 包校验会返回稳定 diagnostics 列表，例如
   `missing_manifest`、
   `missing_publish_marker`、
   `manifest_sha256_mismatch`、
   `missing_required_file:*`
   （`scripts/graphrag/book-hotplug-package.mjs:607-717`）。
3. Python bridge 会记录 subprocess 生命周期与 `spawn_error` 等状态，
   便于恢复观察：
   `src/integrations/python-bridge.ts:53-76`,
   `:357-457`。
4. 但当前审计范围内没有实现定稿合同要求的完整 quarantine 记录、
   rollback record 和 projection rollback 行为。
   `src/graphrag/book-hotplug-catalog.ts` 只在缺 projection 时重建，
   没有 quarantine/rollback state store。

判定：
已经有局部稳定诊断和 settings 恢复机制，但完整 quarantine /
projection rollback 仍未落地，因此部分通过。

### 10. `executable_contract_tests`

- 编号（id）: `executable_contract_tests`
- 名称（name）: 可执行契约测试
- 通过标准（passCriteria）:
  Type DD 足够具体，使实现者能编写挂载后 GraphRAG 直接查询、artifact
  缺失、artifact 替换、lineage 缺失、schema 不兼容、跨书污染和 provider
  payload 不读取的自动化测试。
- 结论（result）: PARTIAL

证据：

1. 已有测试覆盖了若干关键行为：
   - fresh vault 缺失 settings 时自动重建：
     `test/cli-graphrag-route.test.ts:846-876`
   - provider runtime failure 转 typed error：
     `test/unified-query.test.ts:739-757`
   - 单书 scope 构建与隔离：
     `test/cli-graphrag-route.test.ts:827-844`
     和 `test/unified-query.test.ts:795-815`
2. 但定稿合同要求的测试仍缺：
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:984-989`
   要求至少覆盖：
   - catalog projection 删除后 direct query gate 仍成功
   - stale cache 不可强行标记 ready
   - provider roots absent 不影响 manifest-first query gate
3. 另外当前测试夹具仍使用旧 `books/{bookId}/output` 布局
   （`test/cli-graphrag-route.test.ts:207-325`），
   没有证明 hotplug-v1 `graphrag/output` 路径已被真实消费。
4. 本轮执行
   `npm exec -- vitest run test/cli-graphrag-route.test.ts test/unified-query.test.ts --testTimeout 120000`
   时，`45` 个测试里 `44` 个通过，`1` 个失败。
   失败用例是
   `CLI GraphRAG unified route > qmd query --graphrag non-json formats project unified evidence`，
   表现为 timeout 与 `ENOTEMPTY` 清理错误。

判定：
测试已经覆盖 settings 自愈与 typed provider failure，但还没有覆盖
manifest-first hotplug runtime 的核心合同，且目标测试集当前不全绿，因此部分通过。

## final judgment

当前“单本书热插拔包实现”对 runtime/provider 波动的真实进展如下：

1. 已通过：
   - 缺失 `graph_vault/settings.yaml` 的 managed projection 自愈。
   - provider payload / secret / runtime payload 的默认排除与脱敏。
2. 仍未通过：
   - manifest-first direct query resolver。
   - 完整 GraphRAG artifact gate state machine。
   - 完整 producer lineage completeness。
3. 主要偏差：
   - 查询入口仍绑定旧目录 `books/{bookId}/output`，未切到
     `books/{bookId}/graphrag/output`。
   - 测试夹具继续用旧布局，掩盖了 hotplug-v1 真实路径问题。
   - settings 恢复已经补上，但 schema/runtime gate、
     lineage gate 和 quarantine rollback 仍主要停留在设计侧。

## repair priority

按 runtime/provider 风险优先级，建议下一步按以下顺序修复：

1. 把 CLI GraphRAG 查询入口改为 manifest-first，并把 `dataDir`
   切到 `books/{bookId}/graphrag/output`。
2. 在 package validator / catalog projection 中加入 artifact metadata row、
   producer lineage summary 和 schema/runtime compatibility 的实际 gate。
3. 增加 fresh vault fixtures：
   删除 catalog projection、删除 settings、缺失 provider roots、
   删除旧 `output/` 目录，仅保留 hotplug-v1 布局，验证 direct query 仍按合同工作。
