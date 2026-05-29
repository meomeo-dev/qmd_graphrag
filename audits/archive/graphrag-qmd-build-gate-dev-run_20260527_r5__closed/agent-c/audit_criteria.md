# GraphRAG QMD Build Gate 开发审计基准

## 适用范围

本基准用于 GraphRAG EPUB 批处理恢复、状态投影和 completed 准入相关变更的
开发审计。基准应保持稳定复用；后续审计不得因单次实现细节随机增删原则。

## 固定基准

1. 独立证据优先（independent evidence first）。
   qmd 构建状态必须由当前书的
   `books/<bookId>/qmd/qmd_build_manifest.json` 重新计算，不得信任旧
   checkpoint 中的 `qmdBuildStatus`。

2. 命令检查独立（command checks separated）。
   27 个 qmd CLI 子命令检查必须由 `commandChecks` 单独计算，并通过
   `commandCheckStatus` 或等价投影表达，不得与 `qmdBuildStatus` 混同。

3. Completed 严格闭环（strict completed gate）。
   item 写入或保留 `completed` 必须同时满足 qmd build manifest、
   GraphRAG build、GraphRAG query 和 27 个命令检查全部通过。

4. 旧状态不可继承（legacy status is not authority）。
   `--migrate-only`、`--status-json` 和正式运行必须重新校验旧
   `completed` checkpoint；缺证据或陈旧证据必须降级为可恢复状态。

5. GraphRAG 产物书级隔离（book-scoped artifacts）。
   GraphRAG output、producer manifest 和 query-ready capability 必须限定在
   当前 `books/<bookId>/output`，不得接受共享或跨书产物。

6. Producer lineage 对齐（producer lineage alignment）。
   高成本阶段 artifact 的 producer run、stage fingerprint、provider
   fingerprint 和 corpus identity 必须与 checkpoint、producer manifest 和当前书
   identity 对齐。

7. Provider auth 恢复有界且保留投影（bounded auth repair）。
   provider auth 修复只允许在当前 provider context ready 且 fingerprint 变化或
   legacy 条件满足时有界重开；状态摘要必须保留 present、missing、source、
   fingerprint 和 redacted 决策信息。

8. 只读投影无副作用（read-only projection has no writes）。
   `--status-json` 不得执行 EPUB 规范化、GraphRAG、provider 调用或 qmd CLI 子命令，
   也不得写 manifest、checkpoint 或 event log。

9. 文档与 schema 一致（docs and schema agree）。
   操作文档必须说明真实完成条件、同一 runId 续跑方式、密钥脱敏规则和
   `BatchRecoverySummary` 的关键字段，包括 `commandCheckStatus`。

10. 回归测试覆盖失败模式（regression coverage for gate failures）。
    本地测试必须覆盖 qmd manifest 缺失、GraphRAG query failed、command check
    incomplete、stale producer lineage、provider auth repair 和 migrate-only
    reopen 等关键失败模式。
