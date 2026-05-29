Status: FAIL

# Implementation Audit R7 - agent-c

## 总体结论

固定 10 条 criteria 判定：7 PASS，3 FAIL。

R7 相比 R6 有实质进展：

- shared durable store stale lock recovery 已新增持久记录
  `.durable-recovery.jsonl`，R6 的 shared-store recovery record 缺口已闭合。
- batch manifest invalid-schema quarantine 已从裸 `renameSync` 改为
  `renameWithDurableEvidence()`，R6 的 manifest quarantine bare rename 缺口已闭合。
- checksum provenance 已要求 `operationId`、`runnerSessionId`、
  `fencingTokenHash` 与 `targetGeneration`，较 R6 更强。

但实现仍未满足固定 criteria。阻塞项集中在 durable 边界（durable
boundary）未完全统一、直接调用链仍有裸读/裸 rename 旁路、以及 fault
injection evidence 未覆盖这些剩余旁路。

本轮未修改 criteria，未修改生产代码，未启动真实 EPUB runner。

## Criteria Checklist

| ID | 判定 | 证据 |
| --- | --- | --- |
| I01_temp_identity_exclusive_create | PASS | shared store temp 名由 target path 加 `.tmp-${pid}-${timestamp}-${operationId}` 组成，`operationId` 为 UUID，并以 `wx` exclusive create 写 target/checksum temp：`src/job-state/durable-state-store.ts:394`, `src/job-state/durable-state-store.ts:395`, `src/job-state/durable-state-store.ts:404`, `src/job-state/durable-state-store.ts:420`, `src/job-state/durable-state-store.ts:1616`, `src/job-state/durable-state-store.ts:1621`。runner adapter 同样使用 target path、pid、timestamp、operationId UUID 与 `wx`：`scripts/graphrag/batch-epub-workflow.mjs:2320`, `scripts/graphrag/batch-epub-workflow.mjs:2322`, `scripts/graphrag/batch-epub-workflow.mjs:4040`, `scripts/graphrag/batch-epub-workflow.mjs:4042`, `scripts/graphrag/batch-epub-workflow.mjs:4051`, `scripts/graphrag/batch-epub-workflow.mjs:4072`。EEXIST 被分类为 temp collision：`src/job-state/durable-state-store.ts:1414`, `scripts/graphrag/batch-epub-workflow.mjs:4016`。 |
| I02_single_durable_boundary | FAIL | 多数受审模块已复用 shared store：`src/job-state/repository.ts:70`, `src/graphrag/capability-catalog.ts:31`, `src/graphrag/settings-projection.ts:6`, `src/job-state/durable-json.ts:1`, `src/integrations/python-bridge.ts:11`, `src/dspy/policy-store.ts:55`。但 shared store quarantine 仍直接 `rename` / `renameSync` durable target，未走同文件已有的 `renameWithEvidence()` ENOENT 分类：`src/job-state/durable-state-store.ts:1271`, `src/job-state/durable-state-store.ts:1286`, `src/job-state/durable-state-store.ts:1303`, `src/job-state/durable-state-store.ts:1318`，对比 `src/job-state/durable-state-store.ts:1194`。runner 也仍在 reconcile 后裸 `YAML.parse(readFileSync(...))`：`scripts/graphrag/batch-epub-workflow.mjs:5662`, `scripts/graphrag/batch-epub-workflow.mjs:5665`, `scripts/graphrag/batch-epub-workflow.mjs:5666`, `scripts/graphrag/batch-epub-workflow.mjs:6305`, `scripts/graphrag/batch-epub-workflow.mjs:6308`。 |
| I03_lock_owner_fencing | PASS | shared lock owner 记录 pid、host、runnerSessionId、generation、fencingTokenHash、targetLocator、operationId、heartbeatAt、expiresAt：`src/job-state/durable-state-store.ts:1654`, `src/job-state/durable-state-store.ts:1657`, `src/job-state/durable-state-store.ts:1659`, `src/job-state/durable-state-store.ts:1660`, `src/job-state/durable-state-store.ts:1661`, `src/job-state/durable-state-store.ts:1670`, `src/job-state/durable-state-store.ts:1672`, `src/job-state/durable-state-store.ts:1673`, `src/job-state/durable-state-store.ts:1674`。stale lock 删除前校验 TTL、expiresAt、recovery fence、host 与 pid liveness，并写 `durable_lock_recovered` 到 `.durable-recovery.jsonl`：`src/job-state/durable-state-store.ts:811`, `src/job-state/durable-state-store.ts:818`, `src/job-state/durable-state-store.ts:819`, `src/job-state/durable-state-store.ts:820`, `src/job-state/durable-state-store.ts:821`, `src/job-state/durable-state-store.ts:822`, `src/job-state/durable-state-store.ts:826`, `src/job-state/durable-state-store.ts:827`。runner stale lock recovery 也写 event：`scripts/graphrag/batch-epub-workflow.mjs:4952`, `scripts/graphrag/batch-epub-workflow.mjs:4963`。 |
| I04_live_temp_cleanup_safety | PASS | runner cleanup 在 `withJsonFileLock()` 内执行 reconcile：`scripts/graphrag/batch-epub-workflow.mjs:4632`, `scripts/graphrag/batch-epub-workflow.mjs:4635`, `scripts/graphrag/batch-epub-workflow.mjs:4767`, `scripts/graphrag/batch-epub-workflow.mjs:4770`。清理前验证 owner evidence、target、generation/fencing、target checksum 未推进、最小年龄、owner live / lease expired：`scripts/graphrag/batch-epub-workflow.mjs:4176`, `scripts/graphrag/batch-epub-workflow.mjs:4195`, `scripts/graphrag/batch-epub-workflow.mjs:4203`, `scripts/graphrag/batch-epub-workflow.mjs:4211`, `scripts/graphrag/batch-epub-workflow.mjs:4219`, `scripts/graphrag/batch-epub-workflow.mjs:4233`, `scripts/graphrag/batch-epub-workflow.mjs:4244`, `scripts/graphrag/batch-epub-workflow.mjs:4252`。shared store cleanup 同样校验 owner target、createdAt、cleanup fence、target checksum、age、owner liveness 与 lease expiry：`src/job-state/durable-state-store.ts:889`, `src/job-state/durable-state-store.ts:901`, `src/job-state/durable-state-store.ts:903`, `src/job-state/durable-state-store.ts:904`, `src/job-state/durable-state-store.ts:906`, `src/job-state/durable-state-store.ts:907`, `src/job-state/durable-state-store.ts:909`, `src/job-state/durable-state-store.ts:912`, `src/job-state/durable-state-store.ts:917`。 |
| I05_checksum_commit_recovery | PASS | target-new/checksum-missing、target-new/checksum-old、pending meta commit 与 checksum mismatch quarantine 均实现：`src/job-state/durable-state-store.ts:518`, `src/job-state/durable-state-store.ts:526`, `src/job-state/durable-state-store.ts:535`, `src/job-state/durable-state-store.ts:547`, `src/job-state/durable-state-store.ts:562`, `src/job-state/durable-state-store.ts:566`。checksum provenance 要求 operationId、runnerSessionId、fencingTokenHash 与 targetGeneration：`src/job-state/durable-state-store.ts:1468`, `src/job-state/durable-state-store.ts:1473`, `src/job-state/durable-state-store.ts:1474`, `src/job-state/durable-state-store.ts:1475`, `src/job-state/durable-state-store.ts:1476`；runner adapter 同样校验：`scripts/graphrag/batch-epub-workflow.mjs:3922`, `scripts/graphrag/batch-epub-workflow.mjs:3924`, `scripts/graphrag/batch-epub-workflow.mjs:3925`。测试覆盖 shared checksum recovery/quarantine 与 runner pending meta/partial sidecar：`test/book-job-state.test.ts:459`, `test/book-job-state.test.ts:1737`, `test/cli.test.ts:3207`, `test/cli.test.ts:3280`。 |
| I06_fsync_platform_failure | PASS | shared store file fsync 与 directory fsync failure 均投射为 `DurableStateError`，携带 fsyncTarget、fsyncErrno、fsyncPlatform、durableMode 与 completedPublishRule forbidden：`src/job-state/durable-state-store.ts:1362`, `src/job-state/durable-state-store.ts:1371`, `src/job-state/durable-state-store.ts:1376`, `src/job-state/durable-state-store.ts:1377`, `src/job-state/durable-state-store.ts:1378`, `src/job-state/durable-state-store.ts:1379`, `src/job-state/durable-state-store.ts:1380`, `src/job-state/durable-state-store.ts:1389`, `src/job-state/durable-state-store.ts:1399`, `src/job-state/durable-state-store.ts:1400`, `src/job-state/durable-state-store.ts:1401`, `src/job-state/durable-state-store.ts:1402`, `src/job-state/durable-state-store.ts:1403`。runner adapter 同样分类 directory/file fsync failure：`scripts/graphrag/batch-epub-workflow.mjs:2715`, `scripts/graphrag/batch-epub-workflow.mjs:2724`, `scripts/graphrag/batch-epub-workflow.mjs:2729`, `scripts/graphrag/batch-epub-workflow.mjs:2730`, `scripts/graphrag/batch-epub-workflow.mjs:2731`, `scripts/graphrag/batch-epub-workflow.mjs:2732`, `scripts/graphrag/batch-epub-workflow.mjs:2733`, `scripts/graphrag/batch-epub-workflow.mjs:2763`。CLI directory fsync fault injection 覆盖 completed publication blocking：`test/cli.test.ts:2821`。 |
| I07_batch_observability_schema | PASS | checkpoint、command check、event 与 recovery summary schema 均包含 failureKind、localFailureClass、recoveryDecision、failedStage、redactedEvidenceLocator 及 durable metadata：`src/contracts/batch-run.ts:134`, `src/contracts/batch-run.ts:145`, `src/contracts/batch-run.ts:150`, `src/contracts/batch-run.ts:151`, `src/contracts/batch-run.ts:153`, `src/contracts/batch-run.ts:184`, `src/contracts/batch-run.ts:188`, `src/contracts/batch-run.ts:226`, `src/contracts/batch-run.ts:229`, `src/contracts/batch-run.ts:230`, `src/contracts/batch-run.ts:232`, `src/contracts/batch-run.ts:255`, `src/contracts/batch-run.ts:347`, `src/contracts/batch-run.ts:358`, `src/contracts/batch-run.ts:363`, `src/contracts/batch-run.ts:364`, `src/contracts/batch-run.ts:366`, `src/contracts/batch-run.ts:393`, `src/contracts/batch-run.ts:399`, `src/contracts/batch-run.ts:409`, `src/contracts/batch-run.ts:412`, `src/contracts/batch-run.ts:413`, `src/contracts/batch-run.ts:415`, `src/contracts/batch-run.ts:432`。runner projection 和 recovery summary 保留这些字段：`scripts/graphrag/batch-epub-workflow.mjs:2557`, `scripts/graphrag/batch-epub-workflow.mjs:2563`, `scripts/graphrag/batch-epub-workflow.mjs:2564`, `scripts/graphrag/batch-epub-workflow.mjs:2566`, `scripts/graphrag/batch-epub-workflow.mjs:2574`, `scripts/graphrag/batch-epub-workflow.mjs:8062`。 |
| I08_failure_classifier_mapping | PASS | classifier 在 provider transient 之前先识别 local durable failure：`scripts/graphrag/batch-failure-classifier.mjs:7`, `scripts/graphrag/batch-failure-classifier.mjs:14`, `scripts/graphrag/batch-failure-classifier.mjs:47`。映射覆盖 rename ENOENT、temp collision、live temp deletion、directory/file fsync、checksum old/missing/mismatch、partial checksum 与 lock timeout：`scripts/graphrag/batch-failure-classifier.mjs:83`, `scripts/graphrag/batch-failure-classifier.mjs:102`, `scripts/graphrag/batch-failure-classifier.mjs:118`, `scripts/graphrag/batch-failure-classifier.mjs:128`, `scripts/graphrag/batch-failure-classifier.mjs:137`, `scripts/graphrag/batch-failure-classifier.mjs:146`, `scripts/graphrag/batch-failure-classifier.mjs:156`, `scripts/graphrag/batch-failure-classifier.mjs:166`, `scripts/graphrag/batch-failure-classifier.mjs:172`, `scripts/graphrag/batch-failure-classifier.mjs:178`, `scripts/graphrag/batch-failure-classifier.mjs:347`。测试确认 durable classifier 不被 provider text 抢先匹配：`test/cli.test.ts:2606`。 |
| I09_direct_call_chain_coverage | FAIL | repository/capability/settings/durable-json/python bridge/DSPy 的正常写入多已走 shared store：`src/job-state/repository.ts:400`, `src/job-state/repository.ts:411`, `src/graphrag/capability-catalog.ts:342`, `src/graphrag/capability-catalog.ts:745`, `src/graphrag/settings-projection.ts:299`, `src/integrations/python-bridge.ts:11`, `src/dspy/policy-store.ts:632`。但受审直接调用链仍有 durable target mutation 和 durable reads 未完全纳入同一契约：shared store invalid/checksum quarantine 裸 `rename` / `renameSync`：`src/job-state/durable-state-store.ts:1286`, `src/job-state/durable-state-store.ts:1318`；runner `discoverItems()` 在 coordinator lock 与 runner_start preflight 前读取 catalog：`scripts/graphrag/batch-epub-workflow.mjs:10330`, `scripts/graphrag/batch-epub-workflow.mjs:10335`, `scripts/graphrag/batch-epub-workflow.mjs:10337`，并在 `loadCatalogBySourceHash()` 中 reconcile 后裸 parse：`scripts/graphrag/batch-epub-workflow.mjs:5662`, `scripts/graphrag/batch-epub-workflow.mjs:5666`。runner graph evidence readers 也使用 reconcile 后裸 YAML parse：`scripts/graphrag/batch-epub-workflow.mjs:6305`, `scripts/graphrag/batch-epub-workflow.mjs:6308`, `scripts/graphrag/batch-epub-workflow.mjs:6725`, `scripts/graphrag/batch-epub-workflow.mjs:6990`。 |
| I10_fault_injection_tests | FAIL | 已有测试覆盖 same-ms temp、runner temp collision、directory fsync、runner pending meta/partial checksum、runner rename ENOENT、preflight unresolved temp 与 checksum quarantine：`test/book-job-state.test.ts:420`, `test/book-job-state.test.ts:459`, `test/book-job-state.test.ts:1737`, `test/book-job-state.test.ts:3336`, `test/book-job-state.test.ts:3538`, `test/cli.test.ts:2752`, `test/cli.test.ts:2821`, `test/cli.test.ts:3207`, `test/cli.test.ts:3280`, `test/cli.test.ts:3464`, `test/cli.test.ts:3601`。但 fault injection evidence 未覆盖 R7 剩余旁路：shared store quarantine rename ENOENT 未测试；shared store `.durable-recovery.jsonl` stale-lock recovery record 未被测试断言；runner catalog/evidence YAML 读路径未测试 checksum crash-window、live temp 或 concurrent mutation 不会在 preflight/reader 外退化为 unknown。 |

## Blocking Findings

### 1. Shared durable store quarantine 仍使用裸 rename

证据：

- shared store 已有 `renameWithEvidence()` / `renameWithEvidenceSync()`，能把
  ENOENT 分类为 `durable_temp_rename_enoent` 并记录 failedSyscall、errno、
  renameCause 与 evidence：`src/job-state/durable-state-store.ts:1194`,
  `src/job-state/durable-state-store.ts:1202`,
  `src/job-state/durable-state-store.ts:1204`,
  `src/job-state/durable-state-store.ts:1210`,
  `src/job-state/durable-state-store.ts:1212`,
  `src/job-state/durable-state-store.ts:1222`,
  `src/job-state/durable-state-store.ts:1230`.
- 但 invalid/checksum mismatch quarantine 直接调用 `rename()` /
  `renameSync()`：`src/job-state/durable-state-store.ts:1271`,
  `src/job-state/durable-state-store.ts:1286`,
  `src/job-state/durable-state-store.ts:1303`,
  `src/job-state/durable-state-store.ts:1318`.
- `classifyDurableWriteError()` 只补 EEXIST，不补 ENOENT：
  `src/job-state/durable-state-store.ts:1409`,
  `src/job-state/durable-state-store.ts:1414`,
  `src/job-state/durable-state-store.ts:1430`.

影响：

当 durable YAML/JSON target 在 reconcile 判定 invalid 或 checksum mismatch 后、
quarantine rename 前被外部删除或移动时，错误会以普通 filesystem ENOENT
逃逸，而不是稳定投射为 local durable state failure。该路径影响
repository、capability catalog、settings projection、durable-json、python
bridge 与 DSPy policy store 复用的 shared store，违反 I02 与 I09。

### 2. Runner durable YAML readers 仍是 reconcile 后裸 parse

证据：

- `discoverItems()` 在 coordinator lock、runner_start preflight 与
  `reconcileDurableRunFiles()` 前执行：`scripts/graphrag/batch-epub-workflow.mjs:10330`,
  `scripts/graphrag/batch-epub-workflow.mjs:10335`,
  `scripts/graphrag/batch-epub-workflow.mjs:10337`,
  `scripts/graphrag/batch-epub-workflow.mjs:10340`.
- `loadCatalogBySourceHash()` 对 `graph_vault/catalog/books.yaml` 调用
  `reconcileDurableYamlTarget()` 后，释放 lock，再执行
  `YAML.parse(readFileSync(...))`：`scripts/graphrag/batch-epub-workflow.mjs:5662`,
  `scripts/graphrag/batch-epub-workflow.mjs:5665`,
  `scripts/graphrag/batch-epub-workflow.mjs:5666`.
- `readYamlFileIfExists()` 对 graph evidence readers 使用同样模式：
  `scripts/graphrag/batch-epub-workflow.mjs:6305`,
  `scripts/graphrag/batch-epub-workflow.mjs:6307`,
  `scripts/graphrag/batch-epub-workflow.mjs:6308`；
  调用点包括 books catalog、book checkpoints 与 artifacts：
  `scripts/graphrag/batch-epub-workflow.mjs:6725`,
  `scripts/graphrag/batch-epub-workflow.mjs:6990`,
  `scripts/graphrag/batch-epub-workflow.mjs:6994`.

影响：

该 adapter 已比 R6 多了 reconcile，但 parse/read 不在 durable reader 的同一
per-target lock 内完成，也没有把 parse/read race 或 post-reconcile mutation
稳定投射成 durable failure。fixed criteria 要求不存在未声明裸 YAML parse
旁路，或旁路具备同等 lock/checksum/reconcile/classification 语义；当前实现
仍不满足。

### 3. Fault injection evidence 未覆盖剩余 durable 旁路

证据：

- 现有 runner rename ENOENT 测试覆盖 item checkpoint 写入路径：
  `test/cli.test.ts:3601`, `test/cli.test.ts:3677`,
  `test/cli.test.ts:3688`, `test/cli.test.ts:3723`.
- shared store checksum mismatch/quarantine 测试覆盖最终 quarantine 结果，
  但没有注入 quarantine rename ENOENT：
  `test/book-job-state.test.ts:459`,
  `test/book-job-state.test.ts:526`,
  `test/book-job-state.test.ts:530`,
  `test/book-job-state.test.ts:1737`,
  `test/book-job-state.test.ts:1765`,
  `test/book-job-state.test.ts:1769`,
  `test/book-job-state.test.ts:3336`,
  `test/book-job-state.test.ts:3370`,
  `test/book-job-state.test.ts:3373`.
- shared store stale lock recovery 已写 `.durable-recovery.jsonl`：
  `src/job-state/durable-state-store.ts:789`,
  `src/job-state/durable-state-store.ts:826`,
  `src/job-state/durable-state-store.ts:827`，但未找到测试断言该 record。

影响：

I10 要求 fault injection 证明本地 durable state failures 均写出稳定
checkpoint、event、status-json 与 recovery summary。当前 evidence 对 runner
主写入路径较充分，但未证明 shared-store quarantine ENOENT、shared stale-lock
recovery record、以及 runner catalog/evidence YAML reader 的 crash-window /
live-temp 状态不会绕过 durable schema。

## R6 Failure Closure

| R6 失败项 | R7 状态 | 说明 |
| --- | --- | --- |
| single durable boundary | 未闭合 | shared store quarantine bare rename 与 runner YAML bare parse 仍存在。 |
| shared store stale lock recovery record | 已闭合 | stale lock 删除后写 `.durable-recovery.jsonl` 的 `durable_lock_recovered`。 |
| direct call chain bare reads/renames | 部分闭合 | manifest quarantine 已修复；shared quarantine rename 与 runner YAML reads 未闭合。 |
| checksum provenance | 已闭合 | checksum evidence 已要求 operationId、runnerSessionId、fencingTokenHash、targetGeneration。 |
| fault injection evidence | 未闭合 | 缺少剩余 shared-store/runner-reader 旁路的 fault injection 证据。 |

## Verification

本轮执行了静态审计命令读取 criteria、R6 报告、受审源码与测试覆盖。未重新执行
用户已列出的本地验证，未启动真实 EPUB runner。
