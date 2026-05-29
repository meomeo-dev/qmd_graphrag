# GraphRAG EPUB Provider Auth 恢复开发审计报告

结论：FAIL

审计范围：只读审计 `scripts/graphrag/batch-epub-workflow.mjs`、
`src/contracts/batch-run.ts`、`test/cli.test.ts`、
`docs/operations/graphrag-epub-resume-boost.md`、
`docs/operations/graphrag-epub-resume-commands.md`。未读取或输出 `.env`
密钥值；仅审计 present/missing/source/fingerprint/redacted 语义。

## Must Fix

1. `providerAuthSummaryProjection` 仍会在非候选 item 上投影过期 provider auth
   metadata。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:1079` 到 `1089` 只要历史 metadata
     存在 provider auth 字段，即进入 provider auth summary 投影。
   - `scripts/graphrag/batch-epub-workflow.mjs:1090` 到 `1123` 在
     `providerAuthReopenDecision(checkpoint)` 返回 `candidate=false` 时，直接
     从旧 metadata 复制 `providerAuthReopenDecision`、
     `providerAuthReopenReason`、`providerAuthConfigChanged`、
     `providerAuthFailureFingerprint`、`currentProviderAuthFingerprint`、
     `providerAuthReadinessStatus`、`providerAuthCredentialSources` 等字段，同时
     固定写 `providerAuthReopenEligible: false`。

   可复现风险：

   一个历史 provider auth failed item 被后续真实闭环跑成 `completed` 后，checkpoint
   metadata 仍可能保留 `providerAuthReopenDecision=reopen_...`、
   `providerAuthReopenReason=...` 或旧 `currentProviderAuthFingerprint`。因为
   completed item 不再是 reopen candidate，summary 会走非候选分支并继续显示旧
   reopen/reason/fingerprint/readiness 字段。操作者看到 `status=completed` 同时看到
   `providerAuthReopenDecision=reopen_...`，会误判该 item 当前仍需要或允许 provider
   auth reopen。该风险正是本轮重点要求中的“providerAuthSummaryProjection 是否仍会
   投影过期 metadata”。

   建议修复：

   - 非候选 item 不应投影旧 `providerAuthReopenDecision`、`providerAuthReopenReason`、
     `providerAuthReopenBlockedReason`、`providerAuthConfigChanged`、
     `currentProviderAuthFingerprint`、`providerAuthReadinessStatus` 等当前性字段。
   - 若需要保留审计历史，应改用明确历史字段，例如 `providerAuthHistoryPresent`、
     `lastProviderAuthFailureFingerprint`、`lastProviderAuthReopenedAt`，并避免表达为当前
     reopen 决策。
   - 或者只在 `decision.candidate=true` 时投影 provider auth reopen 状态；非候选
     仅保留必要的历史 fingerprint/时间字段，且字段名必须带 `last` 或 `history`。

   建议测试：

   - 新增 status-json 回归：先构造一个 `completed` checkpoint，metadata 内保留
     `providerAuthReopenDecision=reopen_legacy_provider_auth_key_present`、
     `providerAuthReopenEligible=true`、`providerAuthReopenReason=...`、
     `currentProviderAuthFingerprint=old-fingerprint`；运行 `--status-json` 后断言
     summary 不包含当前 reopen decision/reason/eligible，不包含旧 current fingerprint，
     且 checkpoint 文件字节不变。
   - 新增真实闭环回归：沿用
     `test/cli.test.ts:6228` 到 `6447` 的 provider auth reopen 成功路径，完成后再执行
     `--status-json`，断言 completed item 不再投影 `reopen_...` 当前决策。

## 通过项

1. Provider auth failure 分类覆盖 401、403、`INVALID_API_KEY`、`unauthorized`、
   `forbidden` 和 authentication 文本；认证失败会触发 stop-until-fixed 路径。
   见 `scripts/graphrag/batch-epub-workflow.mjs:780` 到 `794`、
   `5004` 到 `5011`。测试覆盖见 `test/cli.test.ts:6029` 到 `6226`、
   `7461` 到 `7624`。

2. Provider auth context 的 required endpoint 包含 `OPENAI_BASE_URL`，配置不可读、
   缺 key、缺 endpoint、process env shadow 均 fail-closed。见
   `scripts/graphrag/batch-epub-workflow.mjs:801` 到 `838`、
   `875` 到 `945`、`1027` 到 `1033`。测试覆盖见
   `test/cli.test.ts:6449` 到 `6601`、`6867` 到 `7128`。

3. Dotenv 优先级符合设计：默认先加载项目根 `.env`，后加载 `graph_vault/.env`；
   当变量不是初始 process env 时，graph_vault 值可覆盖项目根值；`--skip-dotenv`
   不加载 dotenv。见 `scripts/graphrag/batch-epub-workflow.mjs:1804` 到 `1817`。
   测试覆盖见 `test/cli.test.ts:6758` 到 `6865`、`7012` 到 `7060`。

4. Process env shadow 覆盖 key 和 endpoint，且会阻断 provider auth reopen。见
   `scripts/graphrag/batch-epub-workflow.mjs:841` 到 `872`、
   `896` 到 `917`。测试覆盖见 `test/cli.test.ts:6449` 到 `6601`。

5. Provider auth reopen 决策顺序整体正确：not-ready 优先，其后是 current
   fingerprint missing、attempt-limit、unchanged、already_reopened，最后才 reopen。
   attempt count 取历史数组长度和显式计数的最大值，避免降级。见
   `scripts/graphrag/batch-epub-workflow.mjs:983` 到 `1077`。测试覆盖见
   `test/cli.test.ts:7130` 到 `7348`。

6. `--status-json` 基本只读路径成立：事件写入、typed JSON 写入、locked
   read-write、目录创建、migration 均有 status-json 旁路；main 在打印状态后返回。
   见 `scripts/graphrag/batch-epub-workflow.mjs:1699` 到 `1724`、
   `1819` 到 `1834`、`1902` 到 `1917`、`5103` 到 `5107`。测试覆盖见
   `test/cli.test.ts:6449` 到 `6516`、`6758` 到 `6840`、
   `8152` 到 `8268`、`9699` 到 `9973`。

7. `migrate-only` 不降级 completed。`loadCheckpoint` 在 migrate-only 分支跳过
   `downgradeCompletedIfClosedLoopInvalid`，只做 hydrate/persistence invariant；测试验证
   缺 GraphRAG evidence 的 completed 仍保持 completed。见
   `scripts/graphrag/batch-epub-workflow.mjs:2181` 到 `2191`，
   `test/cli.test.ts:8518` 到 `8647`。

8. Running/CAS 对 item start 和 provider auth reopen 有文件锁内关键字段比较；
   fresh remote running 不被 normal run 或 status-json 抢占，stale remote running 可投影或
   恢复。见 `scripts/graphrag/batch-epub-workflow.mjs:1559` 到 `1579`、
   `1308` 到 `1337`、`4860` 到 `4918`。测试覆盖见
   `test/cli.test.ts:8038` 到 `8516`。

9. Secret redaction 覆盖 process env、dotenv 解析值、URL credential、Bearer token、
   absolute path、event metadata 和 raw logs。见
   `scripts/graphrag/batch-epub-workflow.mjs:1618` 到 `1693`、
   `1784` 到 `1802`、`1819` 到 `1834`、`4001` 到 `4005`。测试覆盖见
   `test/cli.test.ts:10145` 到 `10340`。

10. 每本书完整 qmd + GraphRAG 闭环门控较完整。`runItem` 只有在 GraphRAG resume
    ready、27 个固定 qmd checks 全通过、qmd build、GraphRAG build、GraphRAG query
    均 succeeded 后才写 completed。GraphRAG evidence 校验 bookId、content hash、
    provider fingerprint、stage fingerprint、producer run lineage、artifact content 和
    book-scoped output。见 `scripts/graphrag/batch-epub-workflow.mjs:2500` 到 `3215`、
    `4695` 到 `4824`。测试覆盖见 `test/cli.test.ts:8766` 到 `9973`。

## 其他观察

- `src/contracts/batch-run.ts:270` 到 `295` 已纳入 provider auth summary 字段契约。
  契约允许字段存在，但不区分“当前决策”和“历史状态”；must-fix 修复后建议同步收紧字段
  语义或新增历史字段。
- 文档声明与多数实现一致，尤其是 dotenv 权威性、provider auth reopen 前置、
  status-json 只读、闭环门控和禁止 skipped/imported 伪完成。见
  `docs/operations/graphrag-epub-resume-boost.md:140` 到 `184`、
  `217` 到 `239`、`271` 到 `299`。
