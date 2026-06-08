# implementation-turn_021 agent-2 实施审计报告

## 审计范围

- 固定基准（fixed baseline）：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 对照基线：implementation-turn_020 三代理 `PASS` 与汇总 `PASS`。
- 增量提交：`51bba03 Fix hotplug GraphRAG query env and scope resolution`。
- 增量文件：
  `src/cli/qmd.ts`、`src/integrations/python-bridge.ts`、
  `python/qmd_graphrag/bridge.py`、
  `test/cli/document-commands.test.ts`、
  `test/python/test_graphrag_bridge_scope.py`。

本次审计未修改固定审计基准，未修改代码。

## 增量结论

`51bba03` 未破坏 D01-D10 发布门槛。该提交主要修复查询时
`graph_vault/.env` provider 环境覆盖和单书 hotplug GraphRAG scope
派生。新增逻辑没有把 shell env 扩大为权威来源，没有把旧 catalog projection
提升为 package authority，也没有改变上层书架/library 固定预算、状态闭环、
质量门或 query-time synthesis 合同。

## 重点负向路径

### 1. `graph_vault/.env` overlay 与 secret 边界

`src/cli/qmd.ts` 新增 `applyGraphVaultDotenvForCli`，只读取四个 provider
key：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`JINA_API_KEY`、`JINA_API_BASE`。
这些值会覆盖旧 shell env，并在 `qmd vsearch` 与 `qmd query` 主路径中通过
`finally` 恢复原值。

`src/integrations/python-bridge.ts` 子进程 env 合并顺序为
`process.env`、project `.env`、graph vault `.env`，因此 graph vault
provider 设置对 GraphRAG bridge 查询有最高优先级。overlay 只传入子进程
environment，不写入 manifest、package artifact、catalog projection 或审计报告。
bridge subprocess record 只记录 run、pid、provider slot 等运行元数据，不记录
provider key 值。已有 sanitizer 继续覆盖 provider payload、secret、Bearer token
和绝对路径类输出。

结论：覆盖旧 shell env 的行为成立；未发现 secret 泄漏边界扩大。

### 2. hotplug package authority 派生 fail closed

`python/qmd_graphrag/bridge.py` 新增 hotplug package 派生路径，但派生条件是
收敛的：

- `_load_hotplug_book_job` 需要 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  `graphrag/output/qmd_output_manifest.json` 同时存在。
- manifest kind 必须是 `qmd_graphrag_book_package`。
- publish marker kind 必须是 `qmd_graphrag_book_publish_ready`，且 `bookId`
  与包目录一致。
- manifest identity 的 `bookId` 必须匹配，且 `graphrag.queryReady` 必须为
  `true`。
- graph output 必须包含 `stageFingerprints` 与 `providerFingerprint`。
- source hash、normalized path、content hash、document id 缺失时返回 `None`。
- `_load_hotplug_document_identity` 还要求
  `qmd_graph_text_unit_identity.json` 存在，`bookId` 匹配，并包含非空
  `graphTextUnitIds`。

显式 capability scope 解析会先用当前 book/package state 重新派生
`bookId:graph_query`。派生失败时直接抛出错误，不会回退信任 explicit catalog
中的同名 legacy capability。新增测试覆盖无 catalog hotplug 派生成功、缺 graph
identity 失败、缺 package book state 失败、identity 无效失败。

结论：缺 manifest、缺 `PUBLISH_READY`、缺 graph identity 或 identity 不一致时
保持 fail closed。

### 3. legacy catalog-only 与上层状态

该提交没有修改 bookshelf/library upper package 读取、catalog projection、
membership refresh、repair、stale 检测或上层质量门实现。新增 Python 逻辑只影响
单书 GraphRAG bridge 的 capability/book/document identity fallback，且 fallback
来源仍是 package-root hotplug artifacts，而非 catalog-only authority。

turn_020 已通过的 catalog projection 删除后书架/library 显式查询、failed/staging/
stale typed error、membership-only generation 非 query-ready 等路径不受本提交
影响。

结论：catalog-only legacy upper behavior 与 failed/staging/stale 上层状态无回归。

### 4. 固定预算、provider 请求数、typed error/timing

该提交未修改 upper index 查询算法、fixed top-K、controlled deepening、
`--upper-synthesis` 默认关闭策略、`max-synthesis-*` 预算收窄规则或 OpenAI
Responses request 计数逻辑。CLI 仅把 graph vault `.env` overlay 包进 query/vsearch
调用，并把 `graphVault` 参数传入 upper synthesis runner；runner 仍是一次受限
`withLLMSession(...generate...)`。

`graphRagQuerySearch` 仍保留 ambiguous scope typed error、upper scope typed
error 转换、timing recorder 与阶段化 timing metadata。Python bridge 新增
runtime scope validation 不改变成功查询的 fixed budget/timing 结构。

结论：fixed query budget、provider request count、typed error 与 timing 无回归。

## D01-D10 判定

| 维度 | 判定 | 增量影响 |
| --- | --- | --- |
| D01_authority_boundaries | PASS | hotplug 派生依赖 package-root manifest、publish marker 与 graph identity；书架/library authority 未变。 |
| D02_fixed_query_budget | PASS | 未修改上层 fixed budget、top-K、deepening 或 synthesis 预算逻辑。 |
| D03_graphrag_semantic_alignment | PASS | 未改变 community reports、entity、relationship 或 semantic unit 查询输入合同。 |
| D04_evidence_traceability | PASS | 新增 identity 派生强化 source/document/content/text unit lineage；未削弱上层 evidence map。 |
| D05_state_recovery | PASS | 缺失 package readiness 文件或 lineage 文件时 fail closed；上层 recovery/stale 路径未改。 |
| D06_quality_gates | PASS | 未修改书架/library package-local quality gate；单书 hotplug scope 只接受 query-ready manifest。 |
| D07_incremental_scaling | PASS | 未改变成员 manifest sha、generation 或 library/bookshelf 分层重建边界。 |
| D08_security_privacy | PASS | `.env` overlay 限定 provider keys，未序列化 secret；sanitizer 与 forbidden artifact 边界未削弱。 |
| D09_cli_operability | PASS | `.env` overlay 改善 query/vsearch provider resolution；typed error 与 timing 仍可观测。 |
| D10_testability | PASS | 新增 CLI dotenv overlay 测试与 Python scope fail-closed 测试；主线程证据显示 build、type、Python scope、目标 vitest 均通过。 |

## Required Fixes

无。

## Final Verdict

PASS
