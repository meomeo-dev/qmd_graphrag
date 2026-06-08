# implementation-turn_021 agent-1 实施审计报告

## 审计结论

final verdict: PASS

最新 HEAD `51bba035bc9acda8b79cd88536ecda8b0a9da648`
（`Fix hotplug GraphRAG query env and scope resolution`）相对
implementation-turn_020 三代理 PASS 基线没有破坏固定 D01-D10 发布门槛。
增量范围集中在 GraphRAG 查询运行时 provider env overlay 和单书 hotplug
scope 派生；未发现可发布包泄露 secret、catalog 被提升为权威、固定预算、
typed error、evidence lineage、单书 hotplug、书架或 library package-root
闭环回归。

## 审计范围

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 对照基线：implementation-turn_020 三代理报告与汇总报告均为 PASS。
- 增量提交：`39e38cb..51bba03`。
- 增量文件：
  `src/cli/qmd.ts`、`src/integrations/python-bridge.ts`、
  `python/qmd_graphrag/bridge.py`、
  `test/cli/document-commands.test.ts`、
  `test/python/test_graphrag_bridge_scope.py`。

本次未修改固定基准，未修改代码，未改写真实包或 base 审计基准。唯一写入文件
为本报告。

## 只读验证记录

- `git rev-parse HEAD` 确认为
  `51bba035bc9acda8b79cd88536ecda8b0a9da648`。
- `git diff --stat 39e38cb..51bba03` 显示仅 5 个文件发生增量修改。
- 当前 `graph_vault/.env` 存在 provider key：
  `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`JINA_API_KEY`、`JINA_API_BASE`。
  审计未输出 secret 值。
- 当前真实 package readiness：
  `audit-shelf-a` 与 `audit-shelf-b` 的 `CURRENT.json` 均为
  `queryReady=true`、`bookshelf_query_ready`；
  `audit-library` 的 `CURRENT.json` 为 `queryReady=true`、
  `library_query_ready`。
- 固定基准 D01-D10 文件只读读取，未修改。

本 agent 未重跑会写入工作区的验证命令。`npm run build` 会写 `dist`，
Python/Vitest/真实 CLI smoke 可能写缓存、provider request artifact、query log
或 runtime ledger；这与本轮“只读实施审计、唯一写入 report.md”约束冲突。
主线程和 turn_021 其他 agent 报告记录的真实运行证据覆盖：`qmd query`、
`qmd vsearch`、单书 `--graph-book-id`、书架 `--bookshelf-id`、library
`--library-id`、书架/library `--upper-synthesis` 成功；单书 qmd SQLite
副本查询成功且原包 hash match；`npm run build`、`npm run test:types`、
`python test/python/test_graphrag_bridge_scope.py -v` 和目标 vitest 通过。

## 增量核对

### graph_vault/.env overlay

`src/cli/qmd.ts` 新增 `applyGraphVaultDotenvForCli` 与
`applyGraphVaultDotenvForCliValues`，只读取四个 provider 相关 key。`qmd query`
与 `qmd vsearch` 在运行期间应用 overlay，并在 `finally` 中恢复原环境。该路径
只改变查询运行时进程环境，不写 manifest、index、catalog projection、
quality gate 或发布闭包。

`src/integrations/python-bridge.ts` 新增 bridge 子进程 env overlay。合并顺序为
`process.env`、project `.env`、request `rootDir/.env`，因此 graph vault provider
配置覆盖 shell/project env。overlay 仍只进入 child process `env`，没有被序列化
到 provider request artifact、可发布包或查询 metadata。既有 sanitizer 与
forbidden artifact 规则仍负责拦截 provider payload、raw prompt/completion、
secret 和绝对路径。

结论：overlay 只影响查询/bridge 运行时 provider resolution，不把
secrets/payload 写入可发布包，D08 不回归。

### hotplug package scope authority

`python/qmd_graphrag/bridge.py` 的新增 fallback 从
`graph_vault/books/<bookId>` package-local 文件派生 book/document identity：

- `_load_hotplug_book_job` 要求 `BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、`graphrag/output/qmd_output_manifest.json` 存在；
- manifest kind 必须为 `qmd_graphrag_book_package`；
- publish marker kind 必须为 `qmd_graphrag_book_publish_ready` 且 `bookId`
  匹配包目录；
- manifest identity `bookId` 必须匹配，`graphrag.queryReady` 必须为 `true`；
- graph output 必须包含 `stageFingerprints` 与 `providerFingerprint`；
- source hash、normalized path、content hash、document id 缺失时 fail closed；
- `_load_hotplug_document_identity` 还要求
  `qmd_graph_text_unit_identity.json` 存在、`bookId` 匹配且
  `graphTextUnitIds` 非空。

后续 `_derive_graph_query_capability`、`_capability_identity_failure`、
`_validate_capabilities_against_request_scope` 和
`_validate_query_ready_artifacts` 继续校验 sourceId、documentId、contentHash、
graphDocumentId、graphTextUnitIds、artifact lineage、checkpoint、stage
fingerprint、provider fingerprint 和 artifact hash。catalog 条目可以作为已有
projection 输入，但缺失 catalog 条目时的修复来源是 package-local
manifest/publish/output/state，不是 catalog authority。

结论：Python bridge 对 hotplug book package 的 capability/identity 派生仍以
package-local 权威为准；catalog 没有被提升为 authority，D01、D04、D05 不回归。

### 单书、书架、library 与预算

本提交没有修改 `src/graphrag/upper-index/**`、bookshelf/library graph build、
membership refresh、repair、quality gate、upper semantic search、
controlled deepening 或 `--upper-synthesis` 预算逻辑。CLI 仍保持
`--graph-book-id`、`--bookshelf-id`、`--library-id` 互斥；上层 scope error 仍转换
为 typed query error；`--upper-synthesis` 仍默认关闭，显式开启后只对已选上层
evidence 执行一次受限 LLM 调用，预算参数只能收窄 package-local budget。

结论：单书 hotplug、书架/library package root、fixed budget、typed error 和
evidence lineage 未见增量回归。

## D01-D10 判定

| 维度 | 判定 | 增量影响 |
| --- | --- | --- |
| D01_authority_boundaries | PASS | hotplug fallback 读取 package-local manifest、publish marker、output identity 与 state；书架/library package-root authority 未修改。 |
| D02_fixed_query_budget | PASS | 未触碰上层 top-K、deepening、synthesis budget 或 LLM call cap。 |
| D03_graphrag_semantic_alignment | PASS | 未改变 community reports、semantic units、semantic edges、entities 或 relationships 的上层查询合同。 |
| D04_evidence_traceability | PASS | 单书 fallback 强化 source/document/content/text-unit/artifact lineage 校验；上层 evidence map 未改。 |
| D05_state_recovery | PASS | 缺 manifest、publish marker、graph identity、fingerprint 或 lineage 时 fail closed；上层 CURRENT/PUBLISH_READY/quality gate/stale 路径未改。 |
| D06_quality_gates | PASS | 书架/library quality gate 未修改；单书 scope 不绕过 query-ready package 与 artifact 校验。 |
| D07_incremental_scaling | PASS | 未改变 member manifest sha、generation、书架分层或 library rebuild 边界。 |
| D08_security_privacy | PASS | `.env` overlay 只传递 provider keys 到运行时 env；未写入 manifest、index、catalog projection、query metadata 或可发布包。 |
| D09_cli_operability | PASS | query/vsearch provider resolution 改善；scope resolution、typed error 与 timing 结构未削弱。 |
| D10_testability | PASS | 新增 CLI dotenv overlay 测试与 Python hotplug package scope 成功/失败测试；主线程证据显示 build、types、Python scope 与目标 vitest 通过。 |

## required fixes

无。

## Final Verdict

PASS
