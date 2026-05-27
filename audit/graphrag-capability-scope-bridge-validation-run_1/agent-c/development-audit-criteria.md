# Agent C Development Audit Criteria

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准如下：

1. 实现必须只触及必要的 bridge validation 和本次回归测试范围。
2. 实现必须不改变 LLM 调用、并发、token、网络恢复策略或配置模板。
3. 实现必须不改变 qmd / GraphRAG 构建状态展示语义。
4. 实现必须让 `_load_graph_capabilities()` 对真实失败书恢复 ready 判定。
5. 实现必须让 `_load_graph_capabilities()` 对缺失当前 stats artifact 继续失败。
6. 实现必须让 `_load_graph_capabilities()` 对 producer run id 不匹配继续失败。
7. 实现必须让 `_load_graph_capabilities()` 对 fingerprint 不匹配继续失败。
8. 实现必须保留 request scope 中 artifactIds 的 subset 校验。
9. 所列验证命令必须是真实执行过的命令，不能记录空匹配测试为通过。
10. 开发审计报告必须给出明确 verdict，且未通过时不得进入提交和真实跑。
