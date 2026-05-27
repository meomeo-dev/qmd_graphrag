# 设计审计 C

## 固定审计基准

1. 批量状态必须区分外部 transient、局部投影缺失和生产 lineage 不一致。
2. `running` checkpoint 必须有 orphan/stale 判定，不得无限阻塞或被静默覆盖。
3. producer lineage 修复必须验证产物，而不是信任旧 run record。
4. 修复路径必须保留审计 metadata。
5. `query_ready` 不得绕过 `graph_extract`、`community_report`、`embed`。
6. `unknown + stop_until_fixed` 只能用于确实无法分类的失败。
7. 可恢复本地状态问题应回到同一 `runId`，不能要求新建 batch。
8. 需要真实重建时，状态必须暴露 rebuild stage。
9. 状态投影与写入 runner 必须使用同一分类规则。
10. 文档必须说明当前单 runner 边界和未来并行化前置条件。

## 审计结论

不通过。系统已有 orphan batch runner 恢复、provider transient 恢复和本地
artifact gate repair，但缺少对 book-stage producer lineage 冲突的显式分类。

当前失败属于“当前 producer checkpoint 仍是 running，但旧 producer artifact
和 run record 存在”的 lineage 冲突。它既不是 provider auth，也不是纯网络错误，
也不应被保留为 unknown。

## 必须修正

- 为真实失败文本补分类，使它进入 local artifact / producer-lineage repair path。
- repair-only 路径若能验证旧 producer artifact，应显式完成对应 producer stage；
  若不能验证，应返回 `requiresRealRebuild=true` 和具体 rebuild stage。
- 文档应记录 taxonomy：provider transient、orphan running、partial output、
  repairable projection、repairable producer lineage、rebuild required、
  permanent integrity error。
