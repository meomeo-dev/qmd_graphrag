# Design Audit Scope R1

## 固定范围

本轮设计审计只覆盖真实 run
`epub-batch-20260529-post-r3-real-1` 暴露的 runner-start preflight
失败：`graph_vault/catalog/provider-requests/*.json` 在 manifest 创建前被
大量判定为 `durable_checksum_mismatch` 并 quarantine。

不得扩大到 GraphRAG provider 成本质量、EPUB 内容质量、模型输出质量、
外部网络稳定性、或与该启动期 durable 状态恢复无关的设计问题。

## 固定审计问题

1. Type DD 是否明确规定 runner-start preflight 可扫描哪些 durable
   target，以及哪些 target 允许在 manifest 创建前发生写入式修复或隔离。
2. `provider-requests` 是否应属于 runner-start 阻断性 preflight 范围。
3. 对历史 provider request target 的 checksum 缺失、checksum mismatch、
   checksum meta 缺失，设计是否区分 read-only diagnostic、bounded repair、
   quarantine 和 stop-until-fixed。
4. 启动前恢复动作是否必须设置数量上限、scope 上限、时间上限、事件上限，
   防止一次真实 runner 启动扩大历史状态损伤。
5. manifest 尚未创建时，runner 是否允许写入大量 recovery/quarantine
   事件；若允许，设计是否规定可观测的 startup recovery manifest。
6. provider request durable target 是否应被视为 cache-like historical
   observation，还是 critical catalog state；设计必须给出一致分类。
7. status-json read-only 与 normal runner-start preflight 对 provider
   request mismatch 的处理是否一致，且不会隐藏实际风险。
8. 对已存在的历史 mismatch，恢复策略是否能把状态收敛到 completed、
   repaired、quarantined 或 stop_until_fixed，而不形成无限 quarantine loop。
9. 设计是否要求 runner 在触发大规模 quarantine 前停止并给出人工确认或
   explicit repair command。
10. 设计是否给出后续实现验收点，能防止再次出现 manifest 创建前的无界
    provider request quarantine。

## 判定输出

每个代理必须给出：

- `PASS` 或 `FAIL`。
- 最多 10 条发现，按严重程度排序。
- 每条发现必须指向 Type DD 或现有实现的具体文件和行号。
- 每条 `FAIL` 必须给出设计操作建议：
  `补充设计`、`修正完善设计`、`修剪错误设计`、`继续实施`、`修正`、
  `修剪过度实施`、或 `补平`。
- 不得提出新审计范围或新基准。
