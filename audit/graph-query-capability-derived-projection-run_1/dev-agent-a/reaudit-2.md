# Graph Query Capability Derived Projection 最终复审报告

## 结论

PASS。

基于固定 10 条基准复审当前工作区最终代码，未发现阻断项。请求的
`*:graph_query` capability 必须由当前 book state 派生；显式 catalog
不能在 book 缺失或派生失败时兜底；identity、source、document、content、
`graphDocumentId`、`graphTextUnitIds` 硬约束保持严格一致。新增的
request-scope `graphTextUnitIds` 类型校验未引入已观察到的回归。

## 逐条基准状态

1. PASS。`_load_graph_capabilities` 对请求中的 `:graph_query` id 调用
   `_derive_graph_query_capability`，即使显式 catalog 存在也从当前
   `books.yaml` book state 派生。
2. PASS。派生集合仅来自请求 id 中以 `:graph_query` 结尾的条目，未派生
   未请求 book。
3. PASS。请求的 `:graph_query` 显式 catalog 项在 `items_by_id` 构建时被
   排除，成功派生项成为唯一解析来源；派生失败会先抛错，不再同 id 兜底。
4. PASS。派生路径校验 canonical book id、qmd corpus registration、
   source hash/source id、document id、content hash、`graphDocumentId`
   和非空列表 `graphTextUnitIds`；显式项身份校验和 request-scope 校验也已
   要求 `graphDocumentId` 为非空字符串、`graphTextUnitIds` 为非空列表。
5. PASS。query-ready lineage artifact ids 仍通过 checkpoint、manifest、
   artifact kind、path、hash、parquet 和 LanceDB 完整性校验。
6. PASS。缺失当前 book state 时记录 derivation error 并返回
   unknown/not-ready capability 错误，显式 catalog 不会静默成功。
7. PASS。派生失败会直接暴露具体 identity/source/document/content/graph
   identity 错误，不被 generic unknown 或显式 catalog 项掩盖。
8. PASS。请求的 graph query capability id 不能复用其他 book 的显式 catalog
   项，book-scoped artifact isolation 未被削弱。
9. PASS。request-scope 仍检查 selected book ids、capability ids、source ids、
   document ids、content hashes 和 artifact ids；新增 graph text-unit 类型
   检查未破坏有效 request-scope。
10. PASS。测试覆盖显式 catalog 存在但缺少当前稳定 book-id capability 的
    正向派生场景。

## 阻断项

无。

## 重点复核

`python/qmd_graphrag/bridge.py:910` 到 `python/qmd_graphrag/bridge.py:934`
确认：请求的 `:graph_query` id 先按 book state 派生；book 缺失写入
`derivation_errors`；派生失败写入 `derivation_errors`；显式 catalog 中同
请求 id 的条目被排除；存在任何派生错误时立即抛出。

`python/qmd_graphrag/bridge.py:598` 到 `python/qmd_graphrag/bridge.py:640`
确认：派生 capability 与当前 book state 的 source/document/content 字段
严格一致，并要求 `graphTextUnitIds` 为非空列表。

`python/qmd_graphrag/bridge.py:742` 到 `python/qmd_graphrag/bridge.py:807`
确认：request-scope 校验保留原有 scope 字段校验，并新增
`graphTextUnitIds` 非空列表约束。有效 request-scope 手工验证返回 OK。

## 验证

相关 capability/scope 子集：

```text
pytest -q test/python/test_graphrag_bridge_scope.py \
  -k 'capability_scope or index_scope or filter_graphrag_frames_for_scope or build_graphrag_evidence'
```

结果：`20 passed, 9 deselected, 8 subtests passed`。

新增/关键路径：

```text
pytest -q test/python/test_graphrag_bridge_scope.py \
  -k 'derives_missing_capability_with_explicit_catalog or rejects_explicit_catalog_without_book_state or rejects_explicit_catalog_when_derivation_fails or requires_graph_text_unit_list'
```

结果：`4 passed, 25 deselected`。

手工复现旧失败路径：

```text
derivation_fail_no_explicit_fallback: ValueError: book book-1 is missing graphTextUnitIds
missing_book_no_explicit_fallback: ValueError: capabilityScope references unknown or not-ready graphCapabilityId(s): ghost:graph_query
request_scope_valid_graph_text_units: OK
```

完整目标测试文件：

```text
pytest -q test/python/test_graphrag_bridge_scope.py
```

结果：`1 failed, 26 passed, 2 skipped, 8 subtests passed`。失败为当前环境缺少
`nest_asyncio2`，发生在 GraphRAG index provider 注册路径，不属于本次
graph_query capability 派生修复路径。

## 剩余问题

未发现与固定 10 条基准相关的剩余问题。

## 残余风险

由于当前环境缺少 `nest_asyncio2`，完整目标测试文件无法全绿验证。该限制与
本次复审的 graph_query capability 派生、identity 校验、request-scope 校验
路径无直接关系。本复审未修改实现代码。
