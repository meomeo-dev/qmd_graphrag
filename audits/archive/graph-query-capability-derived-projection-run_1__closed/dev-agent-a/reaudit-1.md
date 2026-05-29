# Graph Query Capability Derived Projection 复审报告

## 结论

PASS。

复审确认，上次指出的两个 High 问题已修复：请求的 `*:graph_query`
capability 现在必须从当前 `books.yaml` book state 派生；显式 catalog
不能在 book state 缺失或派生失败时兜底。identity、source、document、
content、`graphDocumentId`、`graphTextUnitIds` 校验也已对齐到非空字符串
和非空列表等硬约束。

## 逐条基准状态

1. PASS。显式 `graph-capabilities.yaml` 存在时，请求的 `:graph_query`
   capability 仍由当前 book state 派生。
2. PASS。派生范围仅限请求集合中的 `:graph_query` capability id，未派生
   未请求 book。
3. PASS。请求的 `:graph_query` 显式 catalog 项会被排除，成功派生项成为
   唯一可解析项；派生失败时直接失败，不再回退到同 id 显式项。
4. PASS。派生路径校验 document identity、source hash/source id、
   document id、content hash、qmd corpus registration、graph document id
   和 graph text-unit ids；request-scope 校验与显式项身份校验也要求
   `graphDocumentId` 为非空字符串、`graphTextUnitIds` 为非空列表。
5. PASS。能力解析仍通过 query-ready lineage artifact ids 与
   `_validate_query_ready_artifacts` 校验完整 query-ready evidence。
6. PASS。缺失当前 book state 时记录 derivation error 并抛出
   unknown/not-ready capability 错误，显式 catalog 无法静默成功。
7. PASS。派生失败会优先抛出具体 identity/source/document/content/graph
   identity 错误，不再被 generic unknown 或显式 catalog 项掩盖。
8. PASS。请求的 graph query capability id 不再能复用其他 book 的显式
   catalog 项，book-scoped artifact isolation 未被削弱。
9. PASS。`_validate_capabilities_against_request_scope` 仍保留 selected
   book ids、capability ids、source ids、document ids、content hashes 和
   artifact ids 的 request-scope 检查。
10. PASS。测试覆盖了显式 catalog 存在但缺少当前稳定 book-id capability
    时的正向派生场景。

## 已复核的旧失败项

旧失败项 1：缺失当前 book state 时显式 catalog 兜底。

结果：已修复。手工复现 `ghost:graph_query` 且显式 catalog 指向 `book-2`
的场景，当前结果为：

```text
ValueError: capabilityScope references unknown or not-ready graphCapabilityId(s):
ghost:graph_query
```

旧失败项 2：派生失败被同 id 显式 catalog 项掩盖。

结果：已修复。手工复现 identity 中 `graphTextUnitIds` 为字符串的场景，
当前结果为：

```text
ValueError: book book-1 is missing graphTextUnitIds
```

## 负向测试覆盖

新增负向测试覆盖了以下关键路径：

1. `test_capability_scope_rejects_explicit_catalog_without_book_state`：
   显式 catalog 存在但当前 book state 缺失时必须 unknown/not-ready。
2. `test_capability_scope_rejects_explicit_catalog_when_derivation_fails`：
   同 id 显式 catalog 不得掩盖派生阶段的 identity 失败。
3. `test_capability_request_scope_requires_graph_text_unit_list`：
   request-scope 校验要求 `graphTextUnitIds` 是非空列表。

## 验证

相关 capability/scope 子集测试：

```text
pytest -q test/python/test_graphrag_bridge_scope.py \
  -k 'capability_scope or index_scope or filter_graphrag_frames_for_scope or build_graphrag_evidence'
```

结果：`20 passed, 9 deselected, 8 subtests passed`。

新增/关键负向测试：

```text
pytest -q test/python/test_graphrag_bridge_scope.py \
  -k 'derives_missing_capability_with_explicit_catalog or rejects_explicit_catalog_without_book_state or rejects_explicit_catalog_when_derivation_fails or requires_graph_text_unit_list'
```

结果：`4 passed, 25 deselected`。

完整目标测试文件：

```text
pytest -q test/python/test_graphrag_bridge_scope.py
```

结果：`1 failed, 26 passed, 2 skipped, 8 subtests passed`。失败仍为环境依赖
问题：`ModuleNotFoundError: No module named 'nest_asyncio2'`，发生在
GraphRAG index provider 注册路径，不在本次 capability 派生修复路径。

## 剩余问题

未发现与固定 10 条基准相关的剩余问题。

## 残余风险

完整目标测试文件受当前环境缺失 `nest_asyncio2` 影响，无法在本环境完成全绿
验证。复审未修改实现代码。
