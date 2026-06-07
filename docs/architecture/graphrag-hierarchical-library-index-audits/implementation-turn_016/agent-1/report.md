# implementation-turn_016 / agent-1 审计报告

## Result: PASS

## Scope

审计对象为本轮 controlled deepening（受控下钻）实现及其接线：

- `src/graphrag/upper-index/controlled-deepening.ts`
- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/library-query.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/graphrag/upper-index/library-graph-contracts.ts`
- `src/graphrag/upper-index/upper-catalog-projection.ts`
- `src/graphrag/upper-index/upper-package-paths.ts`
- `src/cli/qmd.ts`
- `test/graphrag-controlled-deepening.test.ts`
- 相关 bookshelf、library、CLI fail-closed 测试

未修改任何文件。

## Evidence

- Type DD 要求显式 `--upper-deepening` 才能从已选上层证据
  （selected upper evidence）进入固定预算单书下钻，且
  `--max-deepening-targets` 只能收窄预算：
  `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:87`
- 上层包权威根限定在 `graph_vault/bookshelves/**` 与
  `graph_vault/library/**`，catalog 仅为 projection（投影）：
  `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:147`
- `readQueryReadyPackage` 先校验 package root、`CURRENT.json`、
  manifest、quality gate、`PUBLISH_READY.json` 与 checksum sidecar；
  legacy catalog-only artifact 缺 package root 时 fail-closed：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/upper-package-paths.ts:275`
- `applyControlledDeepening` 默认关闭；仅从 `upperResponse.evidence`
  选 target；请求预算超过 package budget 时返回 typed error：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/controlled-deepening.ts:310`
- 缺失被选中单书的 `graph_query` capability 时返回
  `upper_index_stale`：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/controlled-deepening.ts:364`
- 单书下钻 runtime/provider 失败被映射为
  `upper_index_runtime_error`，诊断不包含 provider payload：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/controlled-deepening.ts:386`
- bookshelf 查询使用 `maxBooksForDeepening`，library 查询使用
  `maxBookshelves`，未使用未定义的 `maxBookshelvesForDeepening`：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/library-query.ts:421`
- CLI 参数 `--upper-deepening` 默认 `false`，且
  `--max-deepening-targets` 无 `--upper-deepening` 时拒绝：
  `/Users/jin/projects/qmd_graphrag/src/cli/qmd.ts:3560`
- catalog projection schema 固定 `catalogIsAuthority: false`，并只写
  `projection.yaml`：
  `/Users/jin/projects/qmd_graphrag/src/graphrag/upper-index/upper-catalog-projection.ts:28`
- 相关测试已运行通过：`npm run test:node --
  test/graphrag-controlled-deepening.test.ts
  test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts
  test/cli-graphrag-upper-index-failclosed.test.ts`，结果为 4 个测试文件、
  18 个测试全部通过。

## D01-D10 Verdict Table

| 维度 | Verdict | 结论 |
|---|---:|---|
| D01_authority_boundaries | PASS | 单书包权威未被上层索引改变；上层包读取 package root，不读 catalog 为权威。 |
| D02_fixed_query_budget | PASS | 上层 report search 固定预算；受控下钻仅显式启用且受 package budget 限制。 |
| D03_graphrag_semantic_alignment | PASS | 查询基于预计算 community reports / evidence map，不退化为全库扫描。 |
| D04_evidence_traceability | PASS | 上层 evidence 保留 book/source/document/content/text-unit lineage；下钻 evidence 添加 upper lineage。 |
| D05_state_recovery | PASS | 查询前校验 CURRENT、manifest、PUBLISH_READY、quality gate 和 stale 条件。 |
| D06_quality_gates | PASS | bookshelf/library quality gate 失败时 fail-closed，并暴露 typed diagnostics。 |
| D07_incremental_scaling | PASS | 本轮未改变构建分层；library 固定预算按 `maxBookshelves` 收敛。 |
| D08_security_privacy | PASS | 上层 manifest/artifact 敏感扫描存在；CLI polluted parquet 测试验证不泄露敏感 payload。 |
| D09_cli_operability | PASS | CLI 默认关闭 deepening，错误映射为 typed query error，并保留 timing stage。 |
| D10_testability | PASS | 覆盖默认关闭、预算收窄、缺 capability、library 去重、catalog 非权威和敏感 fail-closed。 |

## Findings

None.

## Residual Risks

- 真实外部 provider 的成功下钻路径未在本次测试命令中执行；当前覆盖为
  fixture/injectable runner 与 CLI 接线层验证。
- `applyControlledDeepening` 的 injectable `loadBookCapabilities` 测试缝
  （test seam）信任调用方返回值；生产路径使用
  `loadGraphQueryCapabilities` 过滤 `graph_query` capability。

## Required Fixes

None.
