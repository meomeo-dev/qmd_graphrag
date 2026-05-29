# r5 agent-b 开发审计结果

## 范围

审计对象：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`

未读取或记录 `.env` 值。未运行真实 EPUB 批处理，未运行会调用外部 provider 的
命令。

## 总结

结论：FAIL。

10 条基准中 9 条 PASS，1 条 FAIL。失败项是 checkpoint 身份保留
（checkpoint identity preservation）：hydration 层会在 completed 降级重算证据
之前覆盖 persisted checkpoint 的 `bookId`，导致本应按 checkpoint 实际书目录
重算的 qmd/GraphRAG 证据可能被按当前 catalog/default `bookId` 误算。

## 逐项结果

### 1. 独立 qmd 构建证据

状态：PASS

证据：

- qmd manifest locator 固定为 `books/${item.bookId}/qmd/qmd_build_manifest.json`：
  `scripts/graphrag/batch-epub-workflow.mjs:2530`。
- `qmdBuildEvidence` 读取该 manifest，并校验 run id、item id、book id、
  source hash、normalized path/hash、qmd index、config、27 个命令名和
  fingerprint：`scripts/graphrag/batch-epub-workflow.mjs:3431`。
- checkpoint snapshot 由 `qmdBuildEvidence(item)` 覆盖：
  `scripts/graphrag/batch-epub-workflow.mjs:2241`。
- runbook 明确 `qmdBuildStatus` 不得作为信任源：
  `docs/operations/graphrag-epub-batch-runbook.md:120`。

风险：未发现阻断风险。

修复建议：无。

### 2. 固定命令检查集合

状态：PASS

证据：

- 固定命令列表包含 27 个名称：
  `scripts/graphrag/batch-epub-workflow.mjs:186`。
- `commandCheckSetEvidence` 要求 27 个检查、27 个唯一名称、无缺失、无意外、
  无失败：`scripts/graphrag/batch-epub-workflow.mjs:3566`。
- recovery summary 单独输出 `commandCheckStatus`：
  `scripts/graphrag/batch-epub-workflow.mjs:3938`。
- 契约包含 `commandCheckStatus`：
  `src/contracts/batch-run.ts:227`。
- incomplete/failed command check 回归覆盖：
  `test/cli.test.ts:9541`、`test/cli.test.ts:9820`。

风险：未发现阻断风险。`qmdCommandCheckEvidence` 是未使用 helper，位置在
`scripts/graphrag/batch-epub-workflow.mjs:3294`，可能造成维护误读。

修复建议：可后续删除或重命名未使用 helper；活跃路径保持
`commandCheckSetEvidence`。

### 3. 闭环完成门

状态：PASS

证据：

- `runItem` 依次运行 resume、CLI checks、写 qmd manifest，并重算 qmd build、
  GraphRAG build、GraphRAG query：
  `scripts/graphrag/batch-epub-workflow.mjs:4969`。
- qmd build、GraphRAG build、GraphRAG query 任一非 `succeeded` 都抛错：
  `scripts/graphrag/batch-epub-workflow.mjs:4980`。
- `writeQmdBuildManifest` 要求完整 command check set 成功：
  `scripts/graphrag/batch-epub-workflow.mjs:3349`。
- completed checkpoint 只在所有门通过后写入：
  `scripts/graphrag/batch-epub-workflow.mjs:5029`。
- 文档同样定义该完成门：
  `docs/operations/graphrag-epub-resume-boost.md:236`。

风险：未发现新 completed 写入的阻断风险。

修复建议：无。

### 4. 旧完成状态降级

状态：PASS

证据：

- `loadCheckpoint` 在 `--migrate-only`、`--status-json` 和正式路径中调用
  `downgradeCompletedIfClosedLoopInvalid`：
  `scripts/graphrag/batch-epub-workflow.mjs:2195`、
  `scripts/graphrag/batch-epub-workflow.mjs:2218`。
- 降级函数要求 command checks、qmd build、GraphRAG build、GraphRAG query
  全部 succeeded，否则写 `item_completed_reopened` 并返回 pending：
  `scripts/graphrag/batch-epub-workflow.mjs:3646`。
- 非 transient 失败检查 reopen 为 `continue_pending`，不保留
  `retryExhausted=true`：`scripts/graphrag/batch-epub-workflow.mjs:3603`。
- `--status-json` 只打印 summary，不写 checkpoint：
  `scripts/graphrag/batch-epub-workflow.mjs:5334`。
- 回归覆盖 missing qmd evidence、failed graph query、incomplete checks、
  non-transient failed checks、stale producer lineage：
  `test/cli.test.ts:8677`、`test/cli.test.ts:9247`、
  `test/cli.test.ts:9541`、`test/cli.test.ts:9820`、`test/cli.test.ts:9907`。

风险：降级机制存在；第 5 项的身份覆盖缺陷会影响其证据输入。

修复建议：按第 5 项修复后补充身份漂移回归。

### 5. checkpoint 身份保留

状态：FAIL

证据：

- `loadCheckpoint` 先 hydrate，再尝试通过 `evidenceItemForCheckpoint` 用
  checkpoint 身份重算证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2193`。
- `evidenceItemForCheckpoint` 本身会优先使用 checkpoint 的 `bookId` 和
  `normalizedPath`：`scripts/graphrag/batch-epub-workflow.mjs:2167`。
- 但普通 hydration 路径先把 `bookId` 覆盖为 `item.bookId ?? defaultBookId`：
  `scripts/graphrag/batch-checkpoint-hydration.mjs:194`。
- 两个特殊 hydration 分支也使用相同覆盖模式：
  `scripts/graphrag/batch-checkpoint-hydration.mjs:74`、
  `scripts/graphrag/batch-checkpoint-hydration.mjs:101`。
- 因为 `hydrateCheckpoint` 在 `evidenceItemForCheckpoint` 前执行，persisted
  `bookId` 可在证据重算前丢失：
  `scripts/graphrag/batch-epub-workflow.mjs:2131`。

风险：若 source identity、catalog identity 或 canonical book-id 规则漂移，合法的
历史 completed checkpoint 可能因按当前 `item.bookId` 重算而误降级为 pending；
也可能按错误书作用域误判成功或 stale。这违反“用 checkpoint 实际
`bookId/normalizedPath` 避免误 pending”的 r5 要求。

必要修复：

- hydration 中优先保留 `checkpoint.bookId`，仅 legacy 缺失时回退到
  `item.bookId` 或 `defaultBookId`。
- 同样优先保留 `checkpoint.normalizedPath`。
- 三个 hydration 分支都应用同一规则。
- 增加 `--status-json` 回归：当前 discovered `item.bookId` 与 persisted completed
  checkpoint `bookId` 不同时，若 persisted `bookId` 下证据有效，仍保持 completed。
- 增加负例：persisted `bookId` 下证据无效时，应按 persisted identity reopen。

### 6. GraphRAG 书级产物隔离

状态：PASS

证据：

- GraphRAG 输出 locator 为 `books/${bookId}/output`：
  `scripts/graphrag/batch-epub-workflow.mjs:2526`。
- artifact validation 拒绝 book mismatch 和 vault 外真实路径：
  `scripts/graphrag/batch-epub-workflow.mjs:2821`。
- stage artifact path 必须位于 `books/<bookId>/output/`，`lancedb` 必须精确为
  `books/<bookId>/output/lancedb`：
  `scripts/graphrag/batch-epub-workflow.mjs:2994`。
- Graph build evidence 要求 producer manifest `outputDir` 等于 book-scoped locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3195`。
- absolute outputDir migration 仅在解析到当前 book output 时执行：
  `scripts/graphrag/batch-epub-workflow.mjs:3253`。
- runbook 写明同一要求：
  `docs/operations/graphrag-epub-batch-runbook.md:137`、
  `docs/operations/graphrag-epub-batch-runbook.md:258`。

风险：未发现阻断风险。

修复建议：无。

### 7. GraphRAG producer lineage 对齐

状态：PASS

证据：

- stage validation 拒绝 checkpoint book/content/fingerprint/provider/producer run
  mismatch：`scripts/graphrag/batch-epub-workflow.mjs:3024`。
- artifact selection 拒绝 artifact producer run、stage fingerprint、provider、
  corpus 和 book scope mismatch：
  `scripts/graphrag/batch-epub-workflow.mjs:2933`。
- build evidence 要求 `graph_extract`、`community_report`、`embed` 的
  `stageProducerRunIds` 存在并匹配对应 checkpoint run id：
  `scripts/graphrag/batch-epub-workflow.mjs:3197`。
- producer manifest 身份校验覆盖 `bookId`、`sourceHash`、`documentId`、
  `contentHash`、`providerFingerprint`、`outputDir` 和 stage fingerprints：
  `scripts/graphrag/batch-epub-workflow.mjs:3211`。
- stale producer lineage 回归覆盖：
  `test/cli.test.ts:9907`。

风险：未发现阻断 lineage 缺口。当前严格 run id 对齐集中在高成本 stages，
与 runbook 中 `stageProducerRunIds.graph_extract/community_report/embed` 要求一致：
`docs/operations/graphrag-epub-batch-runbook.md:153`。

修复建议：可补一个说明性回归，突变顶层
`qmd_output_manifest.json.producerRunId` 但保留 `stageProducerRunIds` 有效，
明确该顶层字段是 informational 还是必须等于 `query_ready` run id。

### 8. provider transient 恢复投影

状态：PASS

证据：

- `recoverProviderTransientCheckpoint` 将 failed/pending transient checkpoint 投影为
  same-run pending recovery，设置 `retry_same_run_id`、`retryExhausted=false`、
  `nextRetryAt` 和 wait metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:3777`。
- wait limit 仍保留 `retry_same_run_id`，不写 completed：
  `scripts/graphrag/batch-epub-workflow.mjs:5174`。
- recovery summary 输出 wait count、max waits、reason 和 waiting state：
  `scripts/graphrag/batch-epub-workflow.mjs:3947`。
- 回归覆盖 transient recovery 和 wait limit metadata：
  `test/cli.test.ts:2570`、`test/cli.test.ts:3688`、
  `test/cli.test.ts:3809`。

风险：未发现阻断风险。

修复建议：无。

### 9. 旧 provider auth 失败恢复

状态：PASS

证据：

- provider auth context 只记录 readiness、required names、presence、source、
  shadowing 和 fingerprint：
  `scripts/graphrag/batch-epub-workflow.mjs:902`。
- reopen decision 使用 stop checkpoint、当前 readiness、fingerprint 变化、历史
  reopen fingerprints 和 attempt limit：
  `scripts/graphrag/batch-epub-workflow.mjs:1031`。
- summary projection 从当前 context 重算，不信任 stale metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:1106`。
- auth reopen 重置为 pending、清空 command checks，并保留审计 metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:1188`。
- status-json shadow/stale readiness/secret redaction 回归：
  `test/cli.test.ts:6530`、`test/cli.test.ts:6609`、
  `test/cli.test.ts:6684`。
- attempt limit 和 completed stale metadata 回归：
  `test/cli.test.ts:7211`、`test/cli.test.ts:7542`。

风险：未发现阻断风险。provider 配置只以 present/source/fingerprint/readiness 和
redacted error 形式投影。

修复建议：无。

### 10. 契约、文档和回归一致性

状态：PASS

证据：

- recovery summary 契约包含 qmd、GraphRAG、graph query、command check、retry、
  provider recovery 和 provider auth 投影字段：
  `src/contracts/batch-run.ts:221`。
- legacy checkpoint parse 为缺失 build status 提供 pending 默认：
  `src/contracts/batch-run.ts:346`。
- runbook 覆盖 completed revalidation、qmd build manifest、27 command checks、
  GraphRAG producer lineage、`--migrate-only` 和 `--status-json`：
  `docs/operations/graphrag-epub-batch-runbook.md:120`。
- resume boost 文档定义完成门和最终完成判定：
  `docs/operations/graphrag-epub-resume-boost.md:236`、
  `docs/operations/graphrag-epub-resume-boost.md:282`。

风险：整体一致性较强；第 5 项缺少 persisted checkpoint identity 漂移回归。

修复建议：补充第 5 项回归后再复审。
