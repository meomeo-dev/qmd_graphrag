# Provider Auth Reopen 开发审计基准

## 范围

审计对象是 provider auth reopen 实现。目标场景是旧的
`401 INVALID_API_KEY`、`recoveryDecision=stop_until_fixed` checkpoint
在用户修复 `.env` 后，可以被有界、可审计地重开为 `pending`，并进入真实
闭环重跑（closed-loop rerun）。实现不得泄露密钥，不得手工标记
`completed`。

## 基准

1. 状态机守卫（state-machine guard）

   仅允许满足以下全部条件的 checkpoint 进入 provider auth reopen：
   `status=failed`、`retryable=false`、`recoveryDecision=stop_until_fixed`，
   且失败证据包含 provider auth failure。非 auth、transient、running、
   completed、skipped、pending 项不得被该路径重开。

2. 状态迁移语义（transition semantics）

   重开只能从 failed stop-until-fixed 迁移到 `pending` +
   `recoveryDecision=continue_pending`。迁移必须清除旧失败字段、runner lease、
   retry 窗口和旧 command checks，并保留可审计原始失败元数据。

3. 真实闭环（real closed loop）

   重开后不得直接写 `completed`。后续完成必须经过 EPUB normalization、
   GraphRAG resume、GraphRAG build/query evidence，以及固定 qmd command
   check 集合全部通过。

4. 有界与防循环（bounded idempotence）

   每个 item 对同一当前 provider auth fingerprint 只能重开一次，并且总重开
   次数必须有硬上限。再次失败后不得在同一配置指纹下无限 failed-to-pending
   循环。

5. 配置变化判定（configuration change detection）

   对非 legacy checkpoint，必须比较失败时 provider auth fingerprint 与当前
   fingerprint。未变化不得重开。legacy 缺少失败 fingerprint 时，只能在必需
   credential present 且可审计标记 legacy 缺失的情况下开放一次受限重开。

6. secret hygiene

   `.env` 原值、Bearer token、API key、provider 原始凭据、完整 URL secret 不得
   写入 checkpoint、summary、event log、stdout/stderr 或审计文档。允许记录
   present/missing、fingerprint、change、source 等概念。

7. shell env shadow 处理

   若 shell `process.env` 中的必需 credential 覆盖 `.env` 中修复后的值，必须
   阻止重开或明确标记为不可安全重开。只读投影应能呈现 shadow 来源概念，不输出
   原值。

8. schema 与契约一致性（schema contract consistency）

   脚本内部 schema、公共 `src/contracts` schema 与实际写入字段必须一致。summary
   投影字段必须可由契约解析，且 metadata 中新增字段不得破坏现有 checkpoint/event
   schema。

9. 只读与迁移边界（read-only and migration boundaries）

   `--status-json` 必须只读，不写 manifest、checkpoint、event log 或 recovery
   summary；`--migrate-only` 只能做迁移职责，不执行 provider auth reopen、不运行
   GraphRAG/qmd，不把失败项改成 completed。

10. 测试覆盖与回归保护（test coverage）

   测试必须覆盖 legacy reopen 成功闭环、非 legacy unchanged blocked、同一
   fingerprint 防重复、attempt limit、shell env shadow blocked、secret
   redaction、`--status-json` 只读、`--migrate-only` 边界、runtime refail 停止
   与旧 checkpoint summary 投影。
