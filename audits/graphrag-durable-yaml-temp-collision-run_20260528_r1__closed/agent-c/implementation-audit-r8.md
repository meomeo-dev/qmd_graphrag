Status: FAIL

# Implementation Audit R8 - agent-c

## 总体结论

固定 10 条 implementation criteria 判定：9 PASS，1 FAIL。

R7 的两个实现 blocker 已闭合：

- shared durable store quarantine 已改为 evidence rename：
  `src/job-state/durable-state-store.ts:1382`,
  `src/job-state/durable-state-store.ts:1397`,
  `src/job-state/durable-state-store.ts:1414`,
  `src/job-state/durable-state-store.ts:1429`。
- runner durable YAML readers 已在同一 per-target lock 内执行
  reconcile/read/parse：
  `scripts/graphrag/batch-epub-workflow.mjs:5785`,
  `scripts/graphrag/batch-epub-workflow.mjs:5788`,
  `scripts/graphrag/batch-epub-workflow.mjs:5789`,
  `scripts/graphrag/batch-epub-workflow.mjs:6429`,
  `scripts/graphrag/batch-epub-workflow.mjs:6431`,
  `scripts/graphrag/batch-epub-workflow.mjs:6436`,
  `scripts/graphrag/batch-epub-workflow.mjs:6438`,
  `scripts/graphrag/batch-epub-workflow.mjs:6439`。

剩余 blocker 在 I10：fault injection evidence 仍未覆盖 shared-store
stale lock recovery record、shared-store quarantine rename ENOENT，以及
runner YAML reader 旁路关闭后的 checksum/live-temp 读路径故障注入。

本轮未修改 criteria，未修改生产代码，未启动真实 EPUB runner。状态报告显示
R8 已请求并列出预审验证通过：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:49`,
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:64`,
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:107`。

## Criteria Checklist

| ID | 判定 | 证据 |
| --- | --- | --- |
| I01_temp_identity_exclusive_create | PASS | shared store temp identity 使用 pid、timestamp 与 UUID operationId：`src/job-state/durable-state-store.ts:1727`, `src/job-state/durable-state-store.ts:1731`, `src/job-state/durable-state-store.ts:1732`；target/checksum temp 使用 `wx` exclusive create：`src/job-state/durable-state-store.ts:474`, `src/job-state/durable-state-store.ts:483`, `src/job-state/durable-state-store.ts:477`, `src/job-state/durable-state-store.ts:499`。runner adapter 同样使用 pid、timestamp、UUID 与 `wx`：`scripts/graphrag/batch-epub-workflow.mjs:2407`, `scripts/graphrag/batch-epub-workflow.mjs:2408`, `scripts/graphrag/batch-epub-workflow.mjs:2409`, `scripts/graphrag/batch-epub-workflow.mjs:4171`, `scripts/graphrag/batch-epub-workflow.mjs:4172`。EEXIST 被分类为 temp collision：`src/job-state/durable-state-store.ts:1520`, `src/job-state/durable-state-store.ts:1525`, `src/job-state/durable-state-store.ts:1529`, `scripts/graphrag/batch-epub-workflow.mjs:4136`, `scripts/graphrag/batch-epub-workflow.mjs:4138`, `scripts/graphrag/batch-epub-workflow.mjs:4142`。 |
| I02_single_durable_boundary | PASS | repository、capability catalog、settings projection、durable-json、python bridge 与 DSPy policy store 均复用 shared durable store：`src/job-state/repository.ts:70`, `src/graphrag/capability-catalog.ts:31`, `src/graphrag/settings-projection.ts:7`, `src/job-state/durable-json.ts:1`, `src/integrations/python-bridge.ts:11`, `src/dspy/policy-store.ts:55`。shared quarantine 已走 `renameWithEvidence()`：`src/job-state/durable-state-store.ts:1397`, `src/job-state/durable-state-store.ts:1429`。runner YAML reader 不再是 reconcile 后锁外裸 parse：`scripts/graphrag/batch-epub-workflow.mjs:5788`, `scripts/graphrag/batch-epub-workflow.mjs:5789`, `scripts/graphrag/batch-epub-workflow.mjs:6431`, `scripts/graphrag/batch-epub-workflow.mjs:6436`, `scripts/graphrag/batch-epub-workflow.mjs:6438`, `scripts/graphrag/batch-epub-workflow.mjs:6439`。 |
| I03_lock_owner_fencing | PASS | shared lock owner 记录 pid、host、runnerSessionId、generation、fencingTokenHash、targetLocator、operationId、heartbeatAt 与 expiresAt：`src/job-state/durable-state-store.ts:1765`, `src/job-state/durable-state-store.ts:1768`, `src/job-state/durable-state-store.ts:1769`, `src/job-state/durable-state-store.ts:1770`, `src/job-state/durable-state-store.ts:1771`, `src/job-state/durable-state-store.ts:1772`, `src/job-state/durable-state-store.ts:1781`, `src/job-state/durable-state-store.ts:1783`, `src/job-state/durable-state-store.ts:1784`, `src/job-state/durable-state-store.ts:1785`。stale lock 删除前校验 TTL、expiry、recovery fence、host 与 liveness，并写 recovery record：`src/job-state/durable-state-store.ts:890`, `src/job-state/durable-state-store.ts:897`, `src/job-state/durable-state-store.ts:898`, `src/job-state/durable-state-store.ts:899`, `src/job-state/durable-state-store.ts:900`, `src/job-state/durable-state-store.ts:901`, `src/job-state/durable-state-store.ts:904`, `src/job-state/durable-state-store.ts:905`, `src/job-state/durable-state-store.ts:906`。runner lock timeout 与 recovery 也保留 owner evidence：`scripts/graphrag/batch-epub-workflow.mjs:5210`, `scripts/graphrag/batch-epub-workflow.mjs:5216`, `scripts/graphrag/batch-epub-workflow.mjs:5234`, `scripts/graphrag/batch-epub-workflow.mjs:5278`, `scripts/graphrag/batch-epub-workflow.mjs:5083`, `scripts/graphrag/batch-epub-workflow.mjs:5093`。 |
| I04_live_temp_cleanup_safety | PASS | shared temp cleanup 验证 owner evidence、target、createdAt、cleanup fence、target checksum/generation、TTL、owner liveness 与 lease expiry：`src/job-state/durable-state-store.ts:968`, `src/job-state/durable-state-store.ts:981`, `src/job-state/durable-state-store.ts:982`, `src/job-state/durable-state-store.ts:983`, `src/job-state/durable-state-store.ts:985`, `src/job-state/durable-state-store.ts:986`, `src/job-state/durable-state-store.ts:988`, `src/job-state/durable-state-store.ts:991`, `src/job-state/durable-state-store.ts:993`, `src/job-state/durable-state-store.ts:996`。runner cleanup 同样基于 owner、TTL、fencing、target checksum 与 owner liveness：`scripts/graphrag/batch-epub-workflow.mjs:4296`, `scripts/graphrag/batch-epub-workflow.mjs:4297`, `scripts/graphrag/batch-epub-workflow.mjs:4315`, `scripts/graphrag/batch-epub-workflow.mjs:4323`, `scripts/graphrag/batch-epub-workflow.mjs:4339`, `scripts/graphrag/batch-epub-workflow.mjs:4353`, `scripts/graphrag/batch-epub-workflow.mjs:4364`, `scripts/graphrag/batch-epub-workflow.mjs:4372`。 |
| I05_checksum_commit_recovery | PASS | shared store 处理 target-new/checksum-missing、target-new/checksum-old、pending meta commit 与 mismatch quarantine：`src/job-state/durable-state-store.ts:597`, `src/job-state/durable-state-store.ts:605`, `src/job-state/durable-state-store.ts:614`, `src/job-state/durable-state-store.ts:626`, `src/job-state/durable-state-store.ts:641`, `src/job-state/durable-state-store.ts:642`, `src/job-state/durable-state-store.ts:645`。checksum provenance 要求 operationId、runnerSessionId、fencingTokenHash 与 targetGeneration：`src/job-state/durable-state-store.ts:1578`, `src/job-state/durable-state-store.ts:1584`, `src/job-state/durable-state-store.ts:1585`, `src/job-state/durable-state-store.ts:1586`, `src/job-state/durable-state-store.ts:1587`。runner adapter 对应恢复矩阵：`scripts/graphrag/batch-epub-workflow.mjs:4937`, `scripts/graphrag/batch-epub-workflow.mjs:4938`, `scripts/graphrag/batch-epub-workflow.mjs:4952`, `scripts/graphrag/batch-epub-workflow.mjs:4965`, `scripts/graphrag/batch-epub-workflow.mjs:4980`, `scripts/graphrag/batch-epub-workflow.mjs:4995`。 |
| I06_fsync_platform_failure | PASS | shared store file fsync 与 directory fsync failure 均投射为 DurableStateError，携带 fsyncTarget、fsyncErrno、fsyncPlatform、durableMode 与 completedPublishRule forbidden：`src/job-state/durable-state-store.ts:1446`, `src/job-state/durable-state-store.ts:1455`, `src/job-state/durable-state-store.ts:1460`, `src/job-state/durable-state-store.ts:1461`, `src/job-state/durable-state-store.ts:1462`, `src/job-state/durable-state-store.ts:1463`, `src/job-state/durable-state-store.ts:1464`, `src/job-state/durable-state-store.ts:1500`, `src/job-state/durable-state-store.ts:1505`, `src/job-state/durable-state-store.ts:1510`, `src/job-state/durable-state-store.ts:1514`。runner adapter 同样分类：`scripts/graphrag/batch-epub-workflow.mjs:2838`, `scripts/graphrag/batch-epub-workflow.mjs:2847`, `scripts/graphrag/batch-epub-workflow.mjs:2852`, `scripts/graphrag/batch-epub-workflow.mjs:2853`, `scripts/graphrag/batch-epub-workflow.mjs:2854`, `scripts/graphrag/batch-epub-workflow.mjs:2856`, `scripts/graphrag/batch-epub-workflow.mjs:2886`, `scripts/graphrag/batch-epub-workflow.mjs:2896`。 |
| I07_batch_observability_schema | PASS | item checkpoint、command check、event、manifest durableFailureSummary 与 recovery summary 均承载 durable failure 字段：`src/contracts/batch-run.ts:134`, `src/contracts/batch-run.ts:145`, `src/contracts/batch-run.ts:150`, `src/contracts/batch-run.ts:151`, `src/contracts/batch-run.ts:153`, `src/contracts/batch-run.ts:188`, `src/contracts/batch-run.ts:226`, `src/contracts/batch-run.ts:229`, `src/contracts/batch-run.ts:230`, `src/contracts/batch-run.ts:232`, `src/contracts/batch-run.ts:344`, `src/contracts/batch-run.ts:347`, `src/contracts/batch-run.ts:348`, `src/contracts/batch-run.ts:350`, `src/contracts/batch-run.ts:371`, `src/contracts/batch-run.ts:382`, `src/contracts/batch-run.ts:387`, `src/contracts/batch-run.ts:388`, `src/contracts/batch-run.ts:390`, `src/contracts/batch-run.ts:423`, `src/contracts/batch-run.ts:433`, `src/contracts/batch-run.ts:436`, `src/contracts/batch-run.ts:437`, `src/contracts/batch-run.ts:439`。runner recovery summary 投射 durable fields：`scripts/graphrag/batch-epub-workflow.mjs:8073`, `scripts/graphrag/batch-epub-workflow.mjs:8099`, `scripts/graphrag/batch-epub-workflow.mjs:8102`, `scripts/graphrag/batch-epub-workflow.mjs:8103`, `scripts/graphrag/batch-epub-workflow.mjs:8104`。 |
| I08_failure_classifier_mapping | PASS | classifier 在 provider transient 前先识别 local durable failure：`scripts/graphrag/batch-failure-classifier.mjs:7`, `scripts/graphrag/batch-failure-classifier.mjs:8`, `scripts/graphrag/batch-failure-classifier.mjs:14`, `scripts/graphrag/batch-failure-classifier.mjs:47`。映射覆盖 rename ENOENT、temp collision、live temp deletion、fsync、checksum window/missing/mismatch、target invalid 与 lock timeout：`scripts/graphrag/batch-failure-classifier.mjs:83`, `scripts/graphrag/batch-failure-classifier.mjs:102`, `scripts/graphrag/batch-failure-classifier.mjs:118`, `scripts/graphrag/batch-failure-classifier.mjs:128`, `scripts/graphrag/batch-failure-classifier.mjs:137`, `scripts/graphrag/batch-failure-classifier.mjs:147`, `scripts/graphrag/batch-failure-classifier.mjs:156`, `scripts/graphrag/batch-failure-classifier.mjs:166`, `scripts/graphrag/batch-failure-classifier.mjs:172`, `scripts/graphrag/batch-failure-classifier.mjs:178`, `scripts/graphrag/batch-failure-classifier.mjs:190`, `scripts/graphrag/batch-failure-classifier.mjs:347`。 |
| I09_direct_call_chain_coverage | PASS | repository writes/read-updates 走 durable store：`src/job-state/repository.ts:400`, `src/job-state/repository.ts:411`, `src/job-state/repository.ts:420`, `src/job-state/repository.ts:424`。capability catalog uses durable update/read：`src/graphrag/capability-catalog.ts:342`, `src/graphrag/capability-catalog.ts:350`, `src/graphrag/capability-catalog.ts:745`。settings projection、python bridge 与 DSPy policy store 使用 durable APIs：`src/graphrag/settings-projection.ts:263`, `src/graphrag/settings-projection.ts:270`, `src/graphrag/settings-projection.ts:299`, `src/integrations/python-bridge.ts:151`, `src/integrations/python-bridge.ts:155`, `src/dspy/policy-store.ts:190`, `src/dspy/policy-store.ts:194`, `src/dspy/policy-store.ts:198`, `src/dspy/policy-store.ts:632`。runner checkpoint/manifest/status 写入走 typed durable JSON path：`scripts/graphrag/batch-epub-workflow.mjs:5384`, `scripts/graphrag/batch-epub-workflow.mjs:5386`, `scripts/graphrag/batch-epub-workflow.mjs:5403`, `scripts/graphrag/batch-epub-workflow.mjs:5406`, `scripts/graphrag/batch-epub-workflow.mjs:6306`, `scripts/graphrag/batch-epub-workflow.mjs:6313`。 |
| I10_fault_injection_tests | FAIL | 已覆盖 same-ms temp、runner temp collision、live/stale temp、checksum crash window、directory fsync、runner rename ENOENT 与事件字段：`test/book-job-state.test.ts:420`, `test/book-job-state.test.ts:459`, `test/book-job-state.test.ts:569`, `test/book-job-state.test.ts:1755`, `test/book-job-state.test.ts:3354`, `test/book-job-state.test.ts:3556`, `test/cli.test.ts:2752`, `test/cli.test.ts:2821`, `test/cli.test.ts:2883`, `test/cli.test.ts:3280`, `test/cli.test.ts:3601`。但 R7 剩余 fault-injection evidence 未完全闭合，见 blocking findings。 |

## Blocking Findings

### 1. Shared-store stale lock recovery record 未被 fault injection 断言

证据：

- shared store stale lock recovery 已实现，并会写
  `.durable-recovery.jsonl` 的 `durable_lock_recovered`：
  `src/job-state/durable-state-store.ts:890`,
  `src/job-state/durable-state-store.ts:897`,
  `src/job-state/durable-state-store.ts:899`,
  `src/job-state/durable-state-store.ts:904`,
  `src/job-state/durable-state-store.ts:905`,
  `src/job-state/durable-state-store.ts:906`,
  `src/job-state/durable-state-store.ts:911`,
  `src/job-state/durable-state-store.ts:912`。
- shared-store recovery log 测试只断言 stale temp recovery：
  `test/book-job-state.test.ts:569`,
  `test/book-job-state.test.ts:654`,
  `test/book-job-state.test.ts:655`,
  `test/book-job-state.test.ts:660`,
  `test/book-job-state.test.ts:663`,
  `test/book-job-state.test.ts:667`。
- runner lock timeout 测试覆盖 `durable_lock_timeout`，不是 shared-store
  stale lock recovery record：
  `test/cli.test.ts:2641`,
  `test/cli.test.ts:2718`,
  `test/cli.test.ts:2719`,
  `test/cli.test.ts:2727`,
  `test/cli.test.ts:2736`。

影响：

I10 要求 fault injection 证明 durable state failures 的 evidence 稳定输出。
当前实现有 shared-store stale lock recovery 逻辑，但没有测试证明该路径写出
`durable_lock_recovered` record，R7 指定的 shared-store stale lock evidence
仍未闭合。

### 2. Shared-store quarantine rename ENOENT 未被 fault injection 覆盖

证据：

- shared store quarantine 已改为 evidence rename：
  `src/job-state/durable-state-store.ts:1382`,
  `src/job-state/durable-state-store.ts:1396`,
  `src/job-state/durable-state-store.ts:1397`,
  `src/job-state/durable-state-store.ts:1414`,
  `src/job-state/durable-state-store.ts:1428`,
  `src/job-state/durable-state-store.ts:1429`。
- `renameWithEvidence()` / `renameWithEvidenceSync()` 能把 ENOENT 分类为
  `durable_temp_rename_enoent`：
  `src/job-state/durable-state-store.ts:1305`,
  `src/job-state/durable-state-store.ts:1311`,
  `src/job-state/durable-state-store.ts:1313`,
  `src/job-state/durable-state-store.ts:1317`,
  `src/job-state/durable-state-store.ts:1321`,
  `src/job-state/durable-state-store.ts:1323`,
  `src/job-state/durable-state-store.ts:1333`,
  `src/job-state/durable-state-store.ts:1339`,
  `src/job-state/durable-state-store.ts:1341`,
  `src/job-state/durable-state-store.ts:1345`。
- 现有 shared-store quarantine 测试覆盖 checksum mismatch 后产生
  `.corrupt-*`，但没有注入 quarantine rename ENOENT：
  `test/book-job-state.test.ts:459`,
  `test/book-job-state.test.ts:510`,
  `test/book-job-state.test.ts:516`,
  `test/book-job-state.test.ts:1755`,
  `test/book-job-state.test.ts:1783`,
  `test/book-job-state.test.ts:1788`,
  `test/book-job-state.test.ts:3354`,
  `test/book-job-state.test.ts:3388`,
  `test/book-job-state.test.ts:3393`。
- runner rename ENOENT 测试只覆盖 batch checkpoint write path：
  `test/cli.test.ts:3601`,
  `test/cli.test.ts:3677`,
  `test/cli.test.ts:3679`,
  `test/cli.test.ts:3688`,
  `test/cli.test.ts:3704`,
  `test/cli.test.ts:3723`。

影响：

R8 实现已经闭合 R7 的 shared quarantine bare rename blocker，但 I10 的 fault
injection evidence 未证明 quarantine rename 在 ENOENT 下会稳定分类并保留
evidence。该缺口影响 shared durable store 的所有复用模块。

### 3. Runner durable YAML reader 旁路缺少故障注入回归证据

证据：

- runner catalog reader 已在 lock 内 reconcile/read/parse：
  `scripts/graphrag/batch-epub-workflow.mjs:5785`,
  `scripts/graphrag/batch-epub-workflow.mjs:5788`,
  `scripts/graphrag/batch-epub-workflow.mjs:5789`。
- graph evidence YAML reader 已在 lock 内 reconcile/read/parse：
  `scripts/graphrag/batch-epub-workflow.mjs:6429`,
  `scripts/graphrag/batch-epub-workflow.mjs:6431`,
  `scripts/graphrag/batch-epub-workflow.mjs:6436`,
  `scripts/graphrag/batch-epub-workflow.mjs:6438`,
  `scripts/graphrag/batch-epub-workflow.mjs:6439`。
- 读路径调用点包括 books catalog、book checkpoints 与 artifacts：
  `scripts/graphrag/batch-epub-workflow.mjs:6856`,
  `scripts/graphrag/batch-epub-workflow.mjs:6857`,
  `scripts/graphrag/batch-epub-workflow.mjs:7119`,
  `scripts/graphrag/batch-epub-workflow.mjs:7121`,
  `scripts/graphrag/batch-epub-workflow.mjs:7125`。
- 当前测试覆盖 runner JSON preflight checksum 与 terminal JSON evidence
  corrupt cases，但未覆盖 YAML reader 的 checksum crash window、live temp
  或 post-reconcile mutation 不会退化为 unknown/completed：
  `test/cli.test.ts:3280`,
  `test/cli.test.ts:3369`,
  `test/cli.test.ts:3372`,
  `test/cli.test.ts:13611`,
  `test/cli.test.ts:13655`,
  `test/cli.test.ts:13665`。

影响：

R8 代码已修复 runner YAML reader 的锁边界，但缺少针对该 reader adapter 的
fault injection evidence。固定 I10 要求测试证明真实 runner 不发布错误
completed，并在本地 durable state 失败中写出稳定 checkpoint、event、
status-json 与 recovery summary；当前 YAML reader 旁路闭合缺少回归证据。

## R7 Blocker Closure

| R7 blocker | R8 状态 | 说明 |
| --- | --- | --- |
| shared durable store quarantine 使用裸 rename | 已闭合 | quarantine 路径使用 `renameWithEvidence()` / `renameWithEvidenceSync()`。 |
| runner durable YAML readers 是 reconcile 后裸 parse | 已闭合 | `loadCatalogBySourceHash()` 与 `readYamlFileIfExists()` 在 `withJsonFileLock()` 内完成 reconcile/read/parse。 |
| fault injection evidence 未覆盖剩余旁路 | 未闭合 | stale temp 有测试；shared stale lock、shared quarantine ENOENT、runner YAML reader fault injection 仍缺证据。 |

## Verification

执行了只读静态审计：读取固定 criteria、R7 报告、设计文档、状态报告、相关源码
与测试。未执行测试命令，未启动真实 EPUB runner，未读取 `.env`。
