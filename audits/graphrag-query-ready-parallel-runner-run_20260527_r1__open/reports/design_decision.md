# 设计决策

## 状态

设计审计已通过。前序失败结论保留为历史背景；本轮已补齐 producer
lineage recovery 与 parallel runner 资源竞争边界，并完成最小实施修复。

## 决策

本轮采用两段式方案。

第一段修复当前真实阻塞：

- 保持 `query_ready` fail-closed，不放宽门控。
- `buildEffectiveResumeState()` 不再让旧 succeeded producer candidate 覆盖当前
  非成功高成本 checkpoint。
- 将
  `query_ready requires completed graph_extract, community_report and embed stages`
  纳入 producer-lineage/local-artifact-gate 分类。
- 批处理 writer 不能在可 repair 的 local artifact gate 前提前停止。
- repair-only 路径负责验证旧 producer artifact；验证通过才显式重写当前
  checkpoint，验证失败则返回需要真实重建的 stage。

第二段只形成并行 runner 设计，不在本轮启用：

- 当前 batch writer 仍保持单 runner。
- 未来并行化必须先引入 item lease、book lease、catalog writer lane、qmd index
  writer lane、provider semaphore 和 fencing token。
- 首个可实施形态应是单进程 worker pool，而不是多个无协调 writer 进程。

## 通过条件

- 文档记录 producer lineage 恢复 taxonomy 和并行 runner 前置条件。
- 回归测试证明当前 `running/failed` 高成本 checkpoint 不会被旧 succeeded
  candidate 静默覆盖。
- 回归测试证明真实失败文本不再是 unknown。
- 聚焦测试、语法检查、类型检查通过。
- 三个实施审计代理复审通过后，本审计目录才能改为 `__closed`。

## 复审结论

- producer lineage recovery 设计记录在
  `docs/architecture/graphrag-producer-lineage-recovery.type-dd.yaml`。
- parallel runner 设计边界记录在
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`。
- 当前正式恢复路径仍使用单 runner；多 runner 并行作为后续设计，不在本轮启用。
- 实施审计 A、B、C 均已通过，本轮可以恢复真实 batch。
