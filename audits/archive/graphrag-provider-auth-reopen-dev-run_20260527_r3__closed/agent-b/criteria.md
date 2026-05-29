# GraphRAG EPUB Batch Provider Auth Reopen 审计基准

1. `--status-json` 必须是只读投影（read-only projection）：不得创建、
   修改或删除 manifest、checkpoint、event log、recovery summary、GraphRAG
   artifacts、raw logs 或锁文件。

2. `--status-json` 可以重新计算派生状态（derived state），但投影结果必须与
   持久化状态分离；任何 pending/running/failed/stale 降级或恢复只能出现在
   stdout JSON 中，不能落盘。

3. `--migrate-only` 只能执行显式迁移（schema、event log、path、raw log
   migration），不得重开 `completed`、`failed`、`skipped` 或 provider-auth
   checkpoint，不得触发真实 EPUB、GraphRAG、provider 或 qmd CLI 工作。

4. provider auth reopen 只允许处理
   `failed + retryable=false + recoveryDecision=stop_until_fixed` 且证据明确为
   provider authentication failure 的 checkpoint；其他永久失败、transient
   failure 和 local artifact gate failure 必须保持原状态机路径。

5. provider auth reopen 必须 fail-closed：provider 配置不可读、必需 key 或
   endpoint 缺失、当前 provider auth fingerprint 缺失、或 shell env 遮蔽权威
   dotenv 时，必须阻断重开并保持 checkpoint 失败态。

6. provider auth reopen 必须有界且幂等（bounded and idempotent）：同一 current
   provider auth fingerprint 不得重复重开，失败 fingerprint 未变化不得重开，
   attempt count 不得被 fingerprint 列表长度或 legacy metadata 降级。

7. provider auth failure 的持久化元数据只能保存 present/missing、credential
   source、redacted fingerprint、config read status 和 redacted error；不得保存
   `.env` 原值、Bearer token、provider 原始请求体或 provider 原始响应体。

8. provider auth refail 后必须清除 stale reopen eligibility：checkpoint 和
   summary 均应投影为 blocked/false eligibility，记录当前失败 fingerprint，并保留
   历史 attempt count 作为上界。

9. 同一 runId 的写入 runner 必须有代码级互斥（code-level exclusion）：启动
   pending/reopen 工作前必须在锁内重读 checkpoint，并以 runner lease 或 CAS
   方式确认仍无人持有；人工 runbook 提醒不能替代代码防线。

10. runner 状态投影必须保守：fresh local/remote running checkpoint 不得被抢占；
    stale 或 orphaned running 只能恢复为 retryable pending；manifest counts、
    recovery summary counts 和 item status 投影必须一致。
