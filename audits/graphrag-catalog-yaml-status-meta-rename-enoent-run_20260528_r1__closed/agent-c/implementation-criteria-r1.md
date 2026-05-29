# 实施审计基准 R1：Agent C

适用范围：Type DD 对齐、contract 对齐、观测恢复、测试矩阵与真实跑批恢复门。

1. 实现必须覆盖 Type DD 的 `readOnlyObserver` 契约，不得只在测试中模拟。
2. 实现必须覆盖 Type DD 的 `repairWriter` meta backfill 与 rename ENOENT
   失败策略。
3. `status_json_catalog_missing_checksum_meta` 验收项必须有自动化测试。
4. `status_json_checksum_meta_backfill_rename_enoent` 验收项必须有自动化测试
   或等价 repair writer 失败注入测试。
5. `sidecar_only_quarantine_boundary` 必须由实现保证：sidecar publish 失败
   不得 quarantine primary catalog YAML。
6. shared contract 与 runner 本地 schema 必须同步新增 diagnostics 与 sidecar
   evidence 字段。
7. 恢复摘要必须提供 `durableStateFailures`，并能派生 temp/lock diagnostics。
8. 真实 EPUB runner 在实施审计 PASS 前必须保持 `resumeAllowed: false`。
9. 验证记录必须包含语法检查、类型检查、聚焦 vitest 与 Type DD YAML 解析。
10. 若任一阻塞项失败，必须先修复实现或设计，再复用本基准重新审计。
