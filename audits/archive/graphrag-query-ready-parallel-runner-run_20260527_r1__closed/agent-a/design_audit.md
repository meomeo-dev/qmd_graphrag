# 设计审计 A

## 固定审计基准

1. `query_ready` 必须 fail-closed，不能在生产阶段未验证完成时发布 capability。
2. 恢复计划与 `query_ready` 门控必须读取一致的生产阶段事实。
3. 当前非成功高成本 checkpoint 不能被旧的 succeeded run record 静默覆盖。
4. 旧 succeeded 产物只有在显式修复（explicit repair）后才能重新成为当前事实。
5. producer runId 必须贯穿 checkpoint、artifact 和 output manifest。
6. GraphRAG 产物必须保持 book-scoped 隔离。
7. bootstrap checkpoint 不能满足真实 GraphRAG 完成状态。
8. 修复路径不得直接把 batch item 标记为 completed。
9. 失败分类必须可观测，不能把可恢复生产 lineage 问题留为 unknown。
10. 回归测试必须覆盖真实失败文本和当前/旧生产 checkpoint 冲突。

## 审计结论

不通过。当前 `query_ready` 门控本身正确，但恢复计划与门控使用了不同状态视图：
恢复计划通过 effective state 选中旧的 `graph_extract` succeeded run record，而
`query_ready` 脚本门控读取当前 checkpoint，发现 `graph_extract=running` 后拒绝。

真实批次中的失败不是 `query_ready` 应放宽，而是当前 producer checkpoint 未被
显式修复或废弃前，旧成功 lineage 不应自动覆盖当前 `running` 状态。

## 必须修正

- `buildEffectiveResumeState()` 在高成本 stage 当前状态为 `pending`、`running`
  或 `failed` 时，不得选旧 succeeded candidate 作为有效状态。
- 若要复用旧 succeeded producer lineage，必须通过 repair 路径验证 artifact、
  manifest、fingerprint 和 provider boundary 后，把当前 checkpoint 显式更新为
  succeeded 或 abandoned/superseded。
- `query_ready requires completed graph_extract, community_report and embed stages`
  必须进入本地 producer-lineage repair/rebuild 分类，不应保持 unknown。
