# Provider Auth Reopen 设计审计基准

## 范围

本基准用于审计 provider authentication failure 导致的批处理停止项重开
机制（reopen mechanism）。机制只有在当前 provider 配置存在、可用，且
当前脱敏指纹（redacted fingerprint）不同于上次失败指纹与上次重开
指纹时才可接受。审计轨迹中不得持久化、打印或推断任何密钥值。

## 固定基准

1. 安全与脱敏边界（security and redaction boundary）
   设计不得在 checkpoint、manifest、summary、event、测试 fixture 或日志
   中读取、持久化、打印或比较原始密钥值。provider 配置证据只能表示为
   present、redacted fingerprint 或 change status。

2. Provider 可用性门禁（provider readiness gate）
   重开必须在任何状态变更前要求当前 provider readiness 结果。该结果
   必须证明受影响 provider 边界的必要配置存在且结构可用。

3. 指纹变更门禁（fingerprint change gate）
   重开必须要求当前 redacted provider fingerprint 同时不同于同一 item
   或受影响 provider 边界记录的 last auth-failure fingerprint 与
   last auth-reopen fingerprint。

4. 幂等重开语义（idempotent reopen semantics）
   重开必须是幂等的。使用相同当前 fingerprint 的第二次调用不得再次
   重开同一 item、再次清理失败证据，或因同一重开决策再次执行 qmd 或
   GraphRAG 工作。

5. 状态迁移正确性（state transition correctness）
   只有 provider-auth stop_until_fixed item 可以从 failed 迁移到 pending。
   重开迁移必须清理调度所需的失败字段，同时在 metadata 与 event 中
   保留历史证据。

6. 批处理调度语义（batch scheduling semantics）
   有效重开后，批处理级 recoveryDecision 必须根据剩余 item 变为
   continue_pending 或 retry_same_run_id。旧 provider-auth stop checkpoint
   不得继续阻塞同一 run 中无关的 pending item。

7. Manifest 与 summary 一致性（manifest and summary consistency）
   重开后 checkpoint、manifest、recovery summary 与 event log 必须描述
   相同的 item 计数与恢复状态。summary 必须暴露 reopen metadata，且不
   暴露 provider secret。

8. 闭环真实执行要求（closed-loop execution requirement）
   被重开的 item 必须先运行正常 qmd 与 GraphRAG 闭环，之后才可完成。
   reopen metadata 本身不得满足 qmd build、GraphRAG build、graph query
   或固定 command-check 验收。

9. 模式边界正确性（mode boundary correctness）
   status-json 必须只读，不得写入 checkpoint、manifest、recovery-summary、
   event、log 或迁移 artifact。migrate-only 只能执行迁移专属写入，不得
   执行 provider-auth reopen，也不得执行 qmd 或 GraphRAG 工作。

10. 可测试性与旧 run resume 覆盖
    设计必须包含确定性测试（deterministic tests），覆盖 current run 与
    legacy run，包括 changed fingerprint、unchanged fingerprint、missing
    readiness、重复调用、混合 failed/pending item、status-json 只读、
    migrate-only 边界，以及 reopen 后真实 qmd/GraphRAG 执行。
