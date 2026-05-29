# Provider Auth Failure Reopen 审计基准

状态：已固化。

适用范围：`batch-epub-workflow.mjs` 在 provider auth failure 修复后的
状态重开（reopen）、观测（observability）和真实续跑（real resume）机制。

1. C-01 provider auth 必须保持非 transient 分类。
   HTTP `401`、`403`、`INVALID_API_KEY`、unauthorized、forbidden 和明确
   authentication failure 必须进入 `failureKind=permanent`、
   `retryable=false`、`recoveryDecision=stop_until_fixed`。该类失败不得进入
   `waitingForProviderRecovery`、`nextRetryAt` 或 provider transient wait
   循环。

2. C-02 auth failure 必须持久化可比较状态。
   checkpoint 必须保存 provider 名称、provider status code、失败分类、
   失败 stage、失败时间、凭据来源 locator、env var 引用名，以及失败时的
   redacted credential fingerprint。不得保存或输出 `.env` 密钥值。

3. C-03 reopen predicate 必须显式且 fail-closed。
   只有既有 checkpoint 是 provider auth `stop_until_fixed`，且当前解析出的
   redacted credential fingerprint 与失败时 fingerprint 不同，才允许自动
   reopen。fingerprint 缺失、相同、无法解析、schema 无效或 runner lease
   活跃时必须保持 stopped。

4. C-04 同一 credential fingerprint 不得重复自动重开。
   对同一个 current redacted credential fingerprint，最多允许一次自动 reopen。
   如果新 credential 仍失败，系统必须持久化新的 failure fingerprint，并在后续
   启动中继续 stop，直到 fingerprint 再次变化。

5. C-05 不得存在无条件 provider auth reopen。
   `--status-json`、migration、completed/skipped reopen、local artifact repair
   或任何 CLI 开关都不得绕过 C-03。provider auth failure 不得被 local
   projection repair、data compatibility repair 或 transient retry 机制误接管。

6. C-06 所有 reopen 决策必须可追踪。
   event log 必须记录 provider auth reopen candidate、blocked、reopened 和
   refailed 结果。事件必须包含 itemId、bookId、provider、status code、
   from/to status、from/to recovery decision、redacted old/new fingerprint、
   reason 和 active command，不得包含 credential value。

7. C-07 reopened item 必须重新真实执行。
   自动 reopen 只能把 item 置为 `pending` 或等价的 runnable 状态，随后必须通过
   正常 `markItemRunning`、GraphRAG resume 和 qmd command-check 路径。不得直接
   写 `completed`，不得跳过 GraphRAG stage，不得把 skipped/imported checkpoint
   当作完成。

8. C-08 状态字段必须由 schema 覆盖。
   新增 checkpoint、event log、manifest、recovery summary 字段必须在 Type DD
   和运行时 schema 中定义并校验。不得只依赖任意 metadata key 作为外部状态契约；
   summary 中展示的字段必须能被 contract test 解析。

9. C-09 secret hygiene 必须覆盖 reopen 路径。
   reopen 计算可读取当前 credential 以产生 redacted fingerprint，但日志、
   stdout、stderr、checkpoint、manifest、event log、summary 和审计文档只能出现
   redacted fingerprint、provider 名称、env var 名和 portable locator。

10. C-10 回归测试必须覆盖恢复闭环。
    测试必须覆盖：相同 fingerprint 阻塞、变化 fingerprint reopen、新 credential
    仍失败后不循环、`--status-json` 只读、event/summary 可观测、schema parse、
    不泄露 secret、provider auth 不走 transient wait、reopened item 重新真实跑。
