# implementation-turn_021 agent-3 实施审计报告

## 审计结论

final verdict: PASS

最新 HEAD `51bba03`（`Fix hotplug GraphRAG query env and scope resolution`）
相对 implementation-turn_020 PASS 基线未改变固定 D01-D10 发布门槛的通过
状态。增量范围限定在真实 provider 配置加载与单书 hotplug scope resolution
修复；未发现上层 bookshelf/library package authority、质量门、固定预算、
evidence lineage、发布闭包或 runtime artifact 跟踪边界被破坏。

## 审计基准

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- turn_020 汇总结论：三代理均为 PASS。
- 最新提交：`51bba035bc9acda8b79cd88536ecda8b0a9da648`
- 父提交：`39e38cb7a34defcc63b0f5865bf0f59532d9f5de`

本轮未修改 base 审计基准，未修改代码，未修改真实包或审计基准数据。

## 增量范围核对

`51bba03` 只修改以下文件：

- `src/cli/qmd.ts`
- `src/integrations/python-bridge.ts`
- `python/qmd_graphrag/bridge.py`
- `test/cli/document-commands.test.ts`
- `test/python/test_graphrag_bridge_scope.py`

未修改 `src/graphrag/upper-index/**`、上层构建发布路径、base YAML、
`graph_vault`、`dist` 或 runtime artifact 路径。`git ls-files graph_vault
dist runtime` 无跟踪文件；针对 `graph_vault`、`dist`、`runtime` 和 base YAML 的
`git status --short --untracked-files=all` 无输出。

## 发布可用性核对

1. 最新提交只闭合真实 provider config 与单书 hotplug scope resolution。
   CLI 在 `qmd query` 与 `qmd vsearch` 运行期间临时应用 graph vault `.env`
   中的 provider env keys，并在 finally 中恢复原环境。Python bridge 对
   request `rootDir` 加载 graph vault `.env`，覆盖 subprocess provider env。
   单书 hotplug scope fallback 从 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
   `qmd_output_manifest.json` 与 `qmd_graph_text_unit_identity.json` 派生
   book、document identity 和 graph capability，但仍要求 query-ready
   lineage artifact、checkpoint、fingerprint、provider fingerprint 与
   content hash 校验通过。未发现 bookshelf/library authority 被 catalog
   projection 或单书 fallback 取代。

2. 主线程真实 smoke 覆盖发布门槛所需路径。证据覆盖普通 `qmd query`、
   `qmd vsearch`、单书 `--graph-book-id`、书架 `--bookshelf-id`、library
   `--library-id`、书架/library `--upper-synthesis`，并覆盖
   `npm run build`、`npm run test:types`、
   `python test/python/test_graphrag_bridge_scope.py -v` 和目标 vitest。该矩阵
   覆盖 D01 authority、D02 固定预算、D03 语义对齐、D04 evidence lineage、
   D05 恢复闭环、D06 质量门、D08 安全、D09 CLI 行为和 D10 可测试性。

3. 单书 hotplug 分发闭包未被验证动作污染。最新增量没有写入单书包闭包的代码
   路径；scope fallback 是运行期只读派生。主线程证据显示单书 qmd SQLite
   副本查询成功且原包 hash match，说明验证动作没有改变 qmd SQLite 副本或
   原始包 hash。Python bridge 的 fallback 仍以 package manifest、publish
   marker、graph output manifest、identity 文件和 artifact 校验作为前置条件，
   不把缺失 catalog projection 当作允许污染单书包的理由。

4. runtime `graph_vault`/`dist` 没有进入 git。只读核对显示本提交没有这些路径的
   tracked 增量；工作区状态对 `graph_vault`、`dist`、`runtime` 无 tracked 或
   untracked 输出。

## D01-D10 结论

| 维度 | 结论 | 核对结果 |
| --- | --- | --- |
| D01_authority_boundaries | PASS | 单书 hotplug fallback 只读取单书 package authority；bookshelf/library 仍由各自 package root、manifest、publish marker 和 quality gate 授权。 |
| D02_fixed_query_budget | PASS | 增量未触碰上层 fixed budget；真实 smoke 已覆盖普通、单书、书架、library 和 synthesis 查询。 |
| D03_graphrag_semantic_alignment | PASS | 增量未改变上层 community reports、semantic units、semantic edges 或 evidence map 语义输入。 |
| D04_evidence_traceability | PASS | 单书 fallback 校验 sourceId、documentId、contentHash、graphDocumentId、graphTextUnitIds 与 artifact lineage；上层 evidence lineage 未改动。 |
| D05_state_recovery | PASS | 增量未改变 membership generation、CURRENT、PUBLISH_READY、quality gate 或 stale 判定；hotplug fallback 仍要求 query-ready lineage。 |
| D06_quality_gates | PASS | 书架/library quality gate 未改动；单书 fallback 不绕过 artifact、checkpoint、fingerprint 和 hash 校验。 |
| D07_incremental_scaling | PASS | 增量没有改变书架分层、library membership、manifest sha256 或 generation 设计。 |
| D08_security_privacy | PASS | provider env overlay 只在进程环境中临时应用；未写入 manifest、index 或 query metadata。 |
| D09_cli_operability | PASS | CLI provider env 与 explicit scope 路径更可运行；ambiguous scope 和上层 typed error 路径未被削弱。 |
| D10_testability | PASS | 新增测试覆盖 graph vault `.env` overlay、hotplug package 无 catalog fallback 和缺 identity 失败路径；主线程全矩阵通过。 |

## Required Fixes

无。
