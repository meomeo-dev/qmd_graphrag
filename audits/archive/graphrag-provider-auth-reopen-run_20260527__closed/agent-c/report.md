# Provider Auth Failure Reopen 审计报告

结论：不通过。

审计对象为当前 provider auth fail-fast、既有 local reopen 机制，以及与拟议
provider auth 修复后自动重开相关的状态契约。审计未读取或输出任何 `.env`
密钥值；以下只讨论 redacted fingerprint 级别的状态。

## 总体判断

当前实现已经把 provider auth failure 从 transient retry 中隔离出来。`401/403`
和 `INVALID_API_KEY` 会被识别为 permanent/non-retryable，并触发
`stop_until_fixed` 停止策略。这满足 fail-fast 的一半目标。

不通过的原因是：修复 credential 后没有可审计的状态重开机制。启动时
`shouldStopBatchBeforeProcessing` 会先命中失败 checkpoint 并停止，既没有比较
当前 redacted credential fingerprint，也没有把已修复的 provider auth item
转换为 pending 的受控路径。用户仍然只能人工编辑 checkpoint、换 runId，或依赖
未定义行为继续推进，这不满足本轮要求。

## 关键证据

- `batch-failure-classifier.mjs:21` 至 `31` 将所有 `4xx` provider status code
  分类为 `failureKind=permanent`、`retryable=false`。
- `batch-epub-workflow.mjs:748` 至 `761` 将 `401`、`403`、invalid api key、
  unauthorized、forbidden 和 authentication 文本识别为 provider auth failure。
- `batch-epub-workflow.mjs:4331` 至 `4338` 对 provider auth failure 执行
  `stop_until_fixed` 停止判定。
- `batch-epub-workflow.mjs:4466` 至 `4475` 在主循环处理任何 item 前先停止，
  因而修复 credential 后仍无自动 reopen 机会。
- `batch-epub-workflow.mjs:4536` 至 `4640` 只给非 retryable failed item 提供
  local artifact gate repair 或继续保持 failed，没有 provider auth reopen 分支。
- `batch-epub-workflow.mjs:2916` 至 `2998`、`4272` 至 `4328` 是 transient provider
  wait 机制，有 wait count 和 wait limit；provider auth 不应进入该路径。
- `batch-epub-workflow.mjs:4100` 至 `4169` 的 completed 写入路径要求真实
  GraphRAG resume 和 27 个 qmd command checks，这是 reopened item 应进入的路径。
- `src/contracts/batch-run.ts:197` 至 `214` 的 event schema 和 `216` 至 `270`
  的 recovery summary item schema 没有 provider auth reopen 专用字段。
- `batch-epub-workflow.mjs:3100` 至 `3160` 的 recovery summary projection 只投影
  local repair 与 transient wait 字段，不投影 auth fingerprint 或 auth reopen
  decision。
- `batch-epub-workflow.mjs:1169` 至 `1199` 的 batch dotenv loader 只加载项目
  root `.env`；拟议机制若以 `graph_vault/.env` 修复为触发条件，必须明确凭据
  来源解析边界，不能与实际 GraphRAG provider 读取路径分叉。

## 基准结果

| 基准 | 结果 | 说明 |
| --- | --- | --- |
| C-01 | 通过 | provider auth 目前按 permanent/stop_until_fixed 分类，未进入 transient wait。 |
| C-02 | 不通过 | checkpoint 没有保存失败时 redacted credential fingerprint 和凭据来源。 |
| C-03 | 不通过 | 没有基于当前 fingerprint 变化的显式 reopen predicate。 |
| C-04 | 不通过 | 没有按 current fingerprint 去重，变化后无防循环状态。 |
| C-05 | 部分通过 | local repair 已排除 provider status code，但 provider auth reopen 机制缺失。 |
| C-06 | 不通过 | 有 stop event，但无 reopen candidate/blocked/reopened/refailed event。 |
| C-07 | 部分通过 | completed 路径足够严格；缺少 provider auth reopen 到该路径的入口。 |
| C-08 | 不通过 | 新状态字段未进入 batch contract 和 summary projection。 |
| C-09 | 部分通过 | 现有 redaction 较完整；reopen fingerprint secret hygiene 未定义。 |
| C-10 | 不通过 | 现有测试覆盖 stop，不覆盖修复 credential 后 reopen 闭环。 |

## 必须修复项

1. 新增 provider auth reopen state machine。
   在读取 checkpoint 后、全局 `shouldStopBatchBeforeProcessing` 停止前，必须先对
   provider auth failed checkpoint 计算 reopen decision。decision 只能产生三类
   结果：`blocked_same_fingerprint`、`blocked_unresolved_current_fingerprint`、
   `reopened_changed_fingerprint`。只有第三类可把 item 转为 pending。

2. 定义 credential source 和 redacted fingerprint 边界。
   机制必须使用与实际 GraphRAG provider 相同的 credential 解析顺序，覆盖
   `graph_vault/.env`、process env 和 provider 配置中的 env var 引用。持久化内容
   只能是 provider、env var name、portable locator 和 redacted fingerprint。
   不得把 credential value、Bearer token、URL credential 或完整 secret-derived
   material 写入状态、日志或审计文档。

3. 阻止同一 fingerprint 自动重开循环。
   checkpoint 必须记录失败 fingerprint、已尝试 reopen 的 current fingerprint
   集合或等价计数。不同 fingerprint 可 reopen 一次；如果真实执行再次返回
   provider auth failure，必须用新的 failure fingerprint 覆盖 stop 状态，并在
   下一次启动继续阻塞。

4. 保持 provider auth 与 transient wait 隔离。
   provider auth reopen 后可以进入真实执行，但失败状态本身不得变成
   `failureKind=transient`、`retryable=true` 或 `waitingForProviderRecovery=true`。
   不得利用 `nextRetryAt` 等待 credential 修复。

5. 补齐 schema-first 状态字段。
   在 `src/contracts/batch-run.ts` 和脚本内联 schema 中增加 provider auth reopen
   字段，至少覆盖 provider、status code、failed/current redacted fingerprint、
   credential source locator、reopen decision、reopenedFromStatus、
   reopenedToStatus、reopenedFromRecoveryDecision、blocked reason、reopen attempt
   count。`recovery-summary.json` 中展示的字段必须由 schema 解析。

6. 增加事件与 summary projection。
   event log 至少需要：
   `item_provider_auth_reopen_blocked`、`item_provider_auth_reopened`、
   `item_provider_auth_refailed`。recovery summary 必须展示当前 item 是否因
   provider auth 被阻塞、是否 eligible、使用的 redacted old/new fingerprint，
   以及最后一次 reopen decision。

7. 保证 reopened item 重新真实跑。
   reopen 只能清除阻塞执行的 failure surface，并把 item 置为 `pending` 或
   `continue_pending`。下一步必须进入 `markItemRunning`、`runGraphResume` 和
   `runCliChecks`。不得直接写 `completed`，不得复用 failed command check 作为
   成功依据，不得跳过 GraphRAG producer stage 或 qmd query checks。

8. 增加 focused regression tests。
   必测场景包括：既有 `401 INVALID_API_KEY` checkpoint 在相同 fingerprint 下启动
   仍停止；current fingerprint 变化后自动 reopen 并调用真实 resume runner；
   新 credential 仍失败后持久化新 fingerprint 且不循环；`--status-json` 只读；
   event 和 recovery summary schema parse；日志、checkpoint 和 summary 不包含
   `.env` 值；provider auth 不进入 transient wait。

## 建议项

1. 将 provider auth reopen decision 独立成纯函数。
   输入为 checkpoint、当前 credential fingerprint projection、runner lease 状态；
   输出为 typed decision。这样可以用小型单元测试覆盖边界，不必启动完整 batch。

2. 使用嵌套 metadata 对象减少字段散落。
   建议形态为 `metadata.providerAuthFailure` 和
   `metadata.providerAuthReopen`，同时在 recovery summary 中投影稳定字段。
   metadata 可保留原始结构，summary 字段作为外部读取契约。

3. `--status-json` 展示 would-reopen 状态但不写文件。
   只读输出可以显示 `providerAuthReopenDecision` 和 redacted current fingerprint，
   帮助操作者确认修复是否被系统识别；实际 checkpoint 修改必须只发生在写入
   runner 中。

4. 将 `graph_vault/.env` 修复路径写入 runbook。
   runbook 应明确：操作者修复 credential 后不编辑 checkpoint，重新用同一 runId
   启动；系统比较 redacted fingerprint、记录事件，并重新真实构建。

5. 保留 fail-fast 的全局保护语义。
   如果任一 provider auth item 仍是 same-fingerprint blocked，batch 不应继续启动
   后续高成本 pending books。只有该 item 被明确 reopen 并真实执行后，才允许继续
   普通调度。
