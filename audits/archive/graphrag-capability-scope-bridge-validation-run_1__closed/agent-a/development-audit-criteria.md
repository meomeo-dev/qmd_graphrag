# Agent A Development Audit Criteria

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准如下：

1. 实现必须让 Python bridge 从当前 `artifacts.yaml` 按
   `bookId + stage + producerRunId + required kind` 选择 producer artifacts。
2. 实现不得把 explicit capability catalog 当作绕过 artifact gate 的信任源。
3. 实现必须保留 `_validate_artifact_subset()` 对 path、hash、parquet 和 lancedb
   完整性的校验。
4. 实现必须保留 stage fingerprint、provider fingerprint 和 corpus content hash
   校验。
5. 实现必须保留 producer run id 校验，并拒绝 run id 不匹配的 manifest artifact。
6. 实现必须让 checkpoint stats artifact id 陈旧但 manifest 当前有效时恢复。
7. 实现必须让 manifest 缺失 stats artifact 时继续 fail closed。
8. 实现必须让 manifest stats artifact fingerprint 不匹配时继续 fail closed。
9. 实现不得修改 GraphRAG vendor、输出格式、research 子命令或批处理主流程。
10. 相关 Python、CLI、book-state、typecheck 和 diff hygiene 验证必须通过或记录
    明确阻断原因。
