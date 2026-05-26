# Graph Query Capability Derived Projection 审计报告

## 结论

FAIL。

本次修复覆盖了显式 `graph-capabilities.yaml` 存在但缺少当前稳定
`bookId` capability 的正向路径，但仍允许旧显式 catalog 在关键失败
路径中绕过当前 book state 派生（derived projection）约束。

## 逐条基准结果

1. FAIL。存在显式 catalog 时，代码会尝试从当前 book state 派生请求的
   `:graph_query` capability；但若当前 book state 缺失，仍可使用显式
   catalog 项解析成功。
2. PASS。派生循环仅遍历请求的 capability id，且仅处理以
   `:graph_query` 结尾的 id；未观察到派生未请求 book 的行为。
3. PARTIAL。成功派生时，派生项通过 `items_by_id` 覆盖同 id 显式项。
   但派生失败时会继续保留同 id 显式项，导致旧显式项可掩盖当前
   book state 或 identity 失败。
4. FAIL。显式项路径的 identity 校验弱于派生路径；例如
   `graphTextUnitIds` 为非列表但非空时，派生会失败，显式项仍可通过。
5. PASS。能力解析仍通过 query-ready lineage artifact ids 和
   `_validate_query_ready_artifacts` 校验 artifact 完整性。
6. FAIL。请求 `ghost:graph_query` 且无 `ghost` book state 时，若显式
   catalog 中同 capability id 指向现有 book 的有效 artifacts，解析可成功，
   不是 unknown/not-ready 错误。
7. FAIL。派生阶段捕获的 identity 失败只在最终缺失 capability 时抛出；
   若同 id 显式项通过后续较弱校验，具体 identity 失败会被隐藏。
8. FAIL。缺失当前 book state 的显式 capability id 可复用其他 book 的
   `bookId`、identity 和 artifacts，削弱 capability id 与 book state 的隔离。
9. PASS。现有 request-scope 检查仍覆盖 selected book ids、capability ids、
   source ids、document ids、content hashes 和 artifact ids。
10. PASS。新增回归测试覆盖了显式 catalog 存在但缺少当前稳定
    `bookId` capability 的正向派生场景。

## 发现的问题

### High：缺失当前 book state 的 graph_query capability 可由显式 catalog 解析成功

位置：`python/qmd_graphrag/bridge.py:881`、`python/qmd_graphrag/bridge.py:886`、
`python/qmd_graphrag/bridge.py:895`、`python/qmd_graphrag/bridge.py:943`。

当请求 id 以 `:graph_query` 结尾但 `books.yaml` 中不存在对应 book state
时，代码在 `book is None` 分支直接 `continue`，没有记录缺失状态。随后
同 capability id 的显式 catalog 项仍会进入解析流程。只要该显式项自身
指向的 `bookId`、identity 和 query-ready artifacts 有效，就会被视为
已解析 capability。

影响：违反基准 1、6、8。修复目标要求以当前 book state 为来源；缺失
当前 book state 应保持 unknown/not-ready，而不是由旧 catalog 静默兜底。

### High：派生失败可被同 id 显式 catalog 项掩盖

位置：`python/qmd_graphrag/bridge.py:888`、`python/qmd_graphrag/bridge.py:892`、
`python/qmd_graphrag/bridge.py:895`、`python/qmd_graphrag/bridge.py:945`。

代码只在最终 `missing` 时抛出 `derivation_errors`。如果同 capability id
的显式 catalog 项通过后续校验，该 id 不会出现在 `missing` 中，派生阶段的
具体失败会被吞掉。

已确认的失败形态：将 identity 的 `graphTextUnitIds` 改为非列表非空值时，
`_derive_graph_query_capability` 会报 `missing graphTextUnitIds`；但显式项
路径的 `_capability_identity_failure` 仅检查 truthiness，不检查列表类型，
因此解析仍可成功。

影响：违反基准 3、4、7。旧显式项不应优先于当前 book state 的失败结果，
identity 硬约束也不应因路径差异而变弱。

## 建议修复

1. 对请求的 `:graph_query` capability id 强制要求当前 book state 存在。
   若 `books.get(book_id)` 缺失，应把该 id 记为 unknown/not-ready，且不得
   允许同 id 显式 catalog 项兜底。
2. 若当前 book state 存在但派生失败，应立即失败或在最终解析前优先抛出
   对应 `derivation_errors`，不得让同 id 显式 catalog 项掩盖该错误。
3. 显式 catalog 项仍被接受时，应校验 `capabilityId` 与 `bookId` 的稳定
   关系，例如 `capabilityId == f"{bookId}:graph_query"`，防止 capability
   id 复用其他 book 的 scope。
4. 将 `_capability_identity_failure` 的 graph identity 校验与
   `_derive_graph_query_capability` 对齐，至少检查 `graphDocumentId` 为非空
   字符串、`graphTextUnitIds` 为非空列表。
5. 增加回归测试：显式 catalog 中存在同 id 旧项但当前 identity 无效时必须
   抛出具体 identity 错误；显式 catalog 中存在缺失 book state 的
   `ghost:graph_query` 项时必须 unknown/not-ready。

## 验证

运行相关 capability/scope 子集测试：

```text
pytest -q test/python/test_graphrag_bridge_scope.py \
  -k 'capability_scope or index_scope or filter_graphrag_frames_for_scope or build_graphrag_evidence'
```

结果：`18 passed, 8 deselected, 8 subtests passed`。

运行完整目标测试文件时，有 1 个与本审计路径无关的环境依赖失败：
`ModuleNotFoundError: No module named 'nest_asyncio2'`，失败发生在
GraphRAG index provider 注册路径。

## 残余风险

本审计未修改实现代码。除上述失败项外，artifact lineage 与 request-scope
相关测试在目标子集中通过，但完整环境缺少 `nest_asyncio2`，无法以当前环境
完成整文件全绿验证。
