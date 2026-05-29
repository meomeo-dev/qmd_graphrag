# r5 GraphRAG qmd Build Gate 开发审计结果

## 审计范围

审计对象为当前工作区 r5 修复状态，重点文件为
`scripts/graphrag/batch-epub-workflow.mjs`、`src/contracts/batch-run.ts`、
`test/cli.test.ts` 和 `docs/operations/` 下三份批处理操作文档。

本审计未读取、打印或总结 `.env` 密钥值；provider 配置只按
present/missing/source/fingerprint/redacted 语义检查。未运行真实 EPUB 批处理，
未运行会调用外部 provider 的命令。

## 总体结论

PASS。未发现阻断项。当前实现满足 r5 审计重点：`completed` 由 qmd build
manifest、GraphRAG build、GraphRAG query 和 27 个 command checks 共同约束；
`--migrate-only` 与 `--status-json` 均会重开缺证据的旧 completed；`qmdBuildStatus`
不再由 command checks 伪造；`status-json` 是只读投影；provider auth stale
reopen 逻辑未见回归；GraphRAG artifacts 按 book-scoped output 和 producer
lineage 校验。

## 1. 完成状态闭环原则

状态：PASS

证据：`downgradeCompletedIfClosedLoopInvalid` 只处理 completed checkpoint，并在
`scripts/graphrag/batch-epub-workflow.mjs:3648` 到 `3657` 同时要求
`commandCheckStatus`、`qmdBuildStatus`、`graphBuildStatus` 和 `graphQueryStatus`
均为 `succeeded`。正常写入路径在 `scripts/graphrag/batch-epub-workflow.mjs:4969`
到 `5052` 先执行 GraphRAG resume、27 个 CLI checks、qmd build manifest 写入，
再校验 qmd build、GraphRAG build 和 GraphRAG query 后写 `completed`。
文档在 `docs/operations/graphrag-epub-resume-boost.md:236` 到 `241` 记录相同门槛。

风险说明：未见旧 checkpoint 字段直接绕过完成门。剩余风险是未来新增 command
check 或 GraphRAG stage 时未同步固定集合和文档。

必要修复建议：无阻断修复。新增 CLI 子命令或 stage 时，同步更新固定集合、
manifest fingerprint、fixture 和 runbook。

## 2. 独立 qmd build 证据原则

状态：PASS

证据：`scripts/graphrag/batch-epub-workflow.mjs:2530` 到 `2535` 将 qmd build
evidence 定位到 `books/<bookId>/qmd/qmd_build_manifest.json`。
`scripts/graphrag/batch-epub-workflow.mjs:3431` 到 `3518` 读取该 manifest，并校验
runId、itemId、bookId、source hash、normalized hash、qmd index hash、config
hash、command check names 和 fingerprint。`withBuildStatusSnapshot` 在
`scripts/graphrag/batch-epub-workflow.mjs:2241` 到 `2247` 每次持久化或投影时重新
计算 `qmdBuildEvidence(item)`。runbook 在
`docs/operations/graphrag-epub-batch-runbook.md:120` 到 `123` 明确
`qmdBuildStatus` 不得作为信任源。

风险说明：`qmdCommandCheckEvidence` 仍存在于
`scripts/graphrag/batch-epub-workflow.mjs:3294` 到 `3343`，但当前未被调用，未参与
`qmdBuildStatus`。

必要修复建议：非阻断建议：确认废弃后删除或加注释，降低未来误用风险。

## 3. 固定 command check 集合原则

状态：PASS

证据：`scripts/graphrag/batch-epub-workflow.mjs:186` 到 `214` 定义固定 27 个
`requiredCommandCheckNames`，`scripts/graphrag/batch-epub-workflow.mjs:222` 固定
期望数量。`commandCheckSetEvidence` 在
`scripts/graphrag/batch-epub-workflow.mjs:3566` 到 `3600` 校验数量、唯一性、缺失、
未知名称和失败状态；正常运行的 `validateCommandChecks` 在
`scripts/graphrag/batch-epub-workflow.mjs:4909` 到 `4928` 执行同类强校验。
`test/cli.test.ts:9541` 到 `9817` 覆盖缺少 `qmd-cleanup` 时旧 completed 被投影为
pending。

风险说明：测试 fixture 中也有固定集合镜像，未来修改集合时需要同步。

必要修复建议：无阻断修复。后续可让测试 helper 从同一公开契约或快照导入集合。

## 4. GraphRAG producer lineage 原则

状态：PASS

证据：`validateGraphStageEvidence` 在
`scripts/graphrag/batch-epub-workflow.mjs:3024` 到 `3133` 校验 stage checkpoint、
bookId、content hash、stage fingerprint、provider fingerprint、producer runId 和
artifact 内容。`graphBuildEvidence` 在
`scripts/graphrag/batch-epub-workflow.mjs:3136` 到 `3250` 要求
`graph_extract`、`community_report`、`embed` 和 `query_ready` 全部有效，并在
`3195` 到 `3239` 校验 producer manifest 的 identity、outputDir、stage runId 和
fingerprints。`test/cli.test.ts:9907` 到 `10193` 覆盖 stale producer lineage 被
status-json 投影为 pending。

风险说明：校验完整；主要风险来自 producer manifest 生成端未来改动未保持字段一致。

必要修复建议：无阻断修复。继续把 producer manifest 生成端和 evidence 读取端放在
同一测试矩阵内。

## 5. book-scoped artifact 隔离原则

状态：PASS

证据：`scripts/graphrag/batch-epub-workflow.mjs:2526` 到 `2527` 定义合法 output
locator 为 `books/<bookId>/output`。`validateArtifactContent` 在
`scripts/graphrag/batch-epub-workflow.mjs:2821` 到 `2870` 校验 artifact bookId、
realpath、hash、parquet 和 LanceDB。`scripts/graphrag/batch-epub-workflow.mjs:2994`
到 `2999` 要求 artifact 路径位于当前书 output，embed 精确为
`books/<bookId>/output/lancedb`。runbook 在
`docs/operations/graphrag-epub-batch-runbook.md:258` 到 `269` 禁止共享
`graph_vault/output` 发布 graph capability。

风险说明：未见串书、共享 output 或 host absolute `outputDir` 可支持 completed 的
路径。

必要修复建议：无阻断修复。

## 6. 旧 completed 重开原则

状态：PASS

证据：`loadCheckpoint` 在 `scripts/graphrag/batch-epub-workflow.mjs:2177` 到
`2238` 的 migrate-only、status-json 和普通运行路径都调用
`downgradeCompletedIfClosedLoopInvalid`。`scripts/graphrag/batch-epub-workflow.mjs:3665`
到 `3716` 对缺失或失败证据生成 pending checkpoint，并保留 qmd、GraphRAG、query
和 command status。`test/cli.test.ts:8677` 到 `8810` 覆盖 `--migrate-only` 将缺
真实闭环证据的旧 completed 降级为 pending；`test/cli.test.ts:9247` 到 `9538` 覆盖
GraphRAG query failed；`test/cli.test.ts:9820` 到 `9905` 覆盖非 transient failed
command check。

风险说明：旧 completed 的重开覆盖缺 qmd manifest、缺 command check、failed
command check、GraphRAG query failed 和 stale producer lineage。

必要修复建议：无阻断修复。

## 7. migrate-only 审计迁移原则

状态：PASS

证据：migrate-only 加载路径在
`scripts/graphrag/batch-epub-workflow.mjs:2195` 到 `2216` 先降级 invalid completed
再持久化重算 checkpoint。主路径在 `scripts/graphrag/batch-epub-workflow.mjs:5338`
到 `5358` 仅执行 event log 迁移、raw log 迁移、book-scoped raw report 断言、
summary 和迁移事件，然后返回，不进入 `runItem`。真实 EPUB normalize、GraphRAG
resume 和 CLI checks 只在 `scripts/graphrag/batch-epub-workflow.mjs:4969` 到
`4975` 的 `runItem` 中执行。runbook 在
`docs/operations/graphrag-epub-batch-runbook.md:321` 到 `323` 明确该模式不执行
EPUB、GraphRAG、OpenAI Responses、Jina 或 qmd CLI 子命令。

风险说明：migrate-only 会写迁移后的 manifest/checkpoint/event/summary，这是该模式
定义内的迁移写入，不是只读投影。未见真实批处理或 provider 调用。

必要修复建议：无阻断修复。

## 8. status-json 只读投影原则

状态：PASS

证据：`ensureDirs` 在 `scripts/graphrag/batch-epub-workflow.mjs:1702` 到 `1727`
的 status-json 分支只校验路径，不创建目录。`event` 在
`scripts/graphrag/batch-epub-workflow.mjs:1836` 直接返回；`lockedReadWriteTypedJson`
在 `1905` 到 `1911` 不写文件；`writeTypedJson` 在 `1915` 到 `1921` 只返回 parsed
value；`updateManifest` 在 `3907` 到 `3911` 只有非 status-json 才写 manifest 和
summary；主路径在 `5332` 到 `5336` 不迁移 producer manifest，打印 summary 后返回。
`test/cli.test.ts:9907` 到 `10193` 断言 status-json 不改原 completed checkpoint，
也不写 event log。

风险说明：只读路径的主要写函数均有 status-json guard，未见 status-json 进入
`runItem` 或命令执行路径。

必要修复建议：无阻断修复。

## 9. provider auth 恢复安全原则

状态：PASS

证据：provider auth context 在 `scripts/graphrag/batch-epub-workflow.mjs:902` 到
`971` 只记录 presence、source、fingerprint、readiness 和 dotenv present 状态。
`providerAuthReopenDecision` 在 `1031` 到 `1104` 要求 failed、non-retryable、
`stop_until_fixed`、provider auth failure、context ready、fingerprint changed、
未超重开上限且未重复使用当前 fingerprint。`reopenProviderAuthCheckpoint` 在 `1188`
到 `1276` 将 checkpoint 改为 pending、清空 commandChecks、标记
`normalCommandChecksRequired`，不写 completed。测试在 `test/cli.test.ts:6727` 到
`6739`、`7288` 到 `7359`、`7361` 到 `7428`、`7542` 到 `7618` 分别覆盖 shadow 阻断、
当前 fingerprint 已重开阻断、fingerprint 未变化阻断，以及 completed item 不投影
stale reopen 状态。

风险说明：未见 stale reopen 回归；敏感值按 fingerprint/source/presence 投影，测试
覆盖不泄露测试密钥。

必要修复建议：无阻断修复。继续禁止在审计或日志中输出原始 provider 值。

## 10. 恢复语义保持原则

状态：PASS

证据：`reopenRecoveryFromStatus` 在
`scripts/graphrag/batch-epub-workflow.mjs:3603` 到 `3643` 对 transient failed command
check 保留 `retry_same_run_id`、`retryable: true`、`retryExhausted: false`、
`nextRetryAt`、`retryDelaySeconds` 和 provider wait。`recoverProviderTransientCheckpoint`
在 `3777` 到 `3822` 将 transient failed/pending checkpoint 投影为 pending，并保留
provider recovery wait。`updateManifest` 在 `3881` 到 `3900` 允许 provider wait
limit reached 时批次为 `incomplete`，item 仍为 pending。`test/cli.test.ts:9247`
到 `9538` 覆盖 GraphRAG query transient failure 从旧 completed 投影为 pending 和
`retry_same_run_id`。runbook 在 `docs/operations/graphrag-epub-batch-runbook.md:242`
到 `256` 记录 bounded wait 后同一 runId 继续。

风险说明：transient 失败不切换 runId，缺证据或非 transient 不误标 completed。未发现
会丢失 provider auth transient 恢复投影的回归。

必要修复建议：无阻断修复。

## 重点检查汇总

- completed 必须同时满足 qmd build manifest、GraphRAG build、GraphRAG query 和
  27 command checks：PASS。
- `--migrate-only` 会重开缺证据的 completed：PASS。
- `qmdBuildStatus` 不再由 27 command checks 伪造：PASS。
- `status-json` 只读：PASS。
- provider auth stale reopen 无回归：PASS。
- book-scoped output 不会串书：PASS。

## 验证说明

本轮审计使用静态代码、测试和文档证据完成。未运行真实 inbox/EPUB 批处理，未运行
任何会调用外部 provider 的命令。
