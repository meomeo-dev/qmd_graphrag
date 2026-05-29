Status: FAIL

# Durable YAML/JSON Temp Collision 实施审计 R5

## 总体结论

固定 criteria 共 10 条：4 条 PASS，6 条 FAIL。

R5 相比 R4 有实质推进：runner 增加了 explicit adapter contract
（显式适配契约），qmd index file lock 增加 generation、fencing hash、
operationId、lane、owner 与 guarded release，preflight 已开始对 primary JSON
执行 checksum reconcile，matching pending checksum meta 也会收敛为
`committed`。

但固定基准仍未闭合。主要阻塞点是：runner 与 shared store 仍不是同一 durable
边界，也没有可执行的等价 adapter 验证；qmd index 与 checksum reconcile 仍有未在
per-target durable lock 内执行的路径；shared store 的 stale temp cleanup 会删除
无法证明 owner-dead 或 lease-expired 的 remote owner temp；checksum/generation
recovery 仍只用 checksum/meta locator 证明 backfill；before-claim /
before-resume preflight 未覆盖全部 durable target 与语义状态；固定 fault
injection 测试矩阵仍缺关键场景。

本轮未启动真实 EPUB runner，未处理真实 runId
`epub-batch-20260527-real-resume-1`，未读取或打印 `.env` 内容。

## Criteria Checklist

| ID | 判定 | 依据与残余风险 |
| --- | --- | --- |
| I01_single_durable_state_boundary | FAIL | runner 仅声明 `durableAdapterContract`，指向 `src/job-state/durable-state-store.ts`，但未导入或调用该 shared store：`scripts/graphrag/batch-epub-workflow.mjs:194-208`。shared store 也有独立 contract：`src/job-state/durable-state-store.ts:31-48`。两边仍各自实现 temp、checksum、lock、fsync、failure projection：runner 在 `scripts/graphrag/batch-epub-workflow.mjs:3821-3868`, `scripts/graphrag/batch-epub-workflow.mjs:4342-4582`, `scripts/graphrag/batch-epub-workflow.mjs:4720-4869`；shared store 在 `src/job-state/durable-state-store.ts:275-380`, `src/job-state/durable-state-store.ts:385-510`, `src/job-state/durable-state-store.ts:512-637`。语义也不完全等价，见 I04。 |
| I02_target_mapping_and_lane_enforcement | FAIL | R5 已把 qmd index 映射到 `qmdIndexWriterLane` 和 `batchCoordinator`：`scripts/graphrag/batch-epub-workflow.mjs:2301-2319`, `scripts/graphrag/batch-epub-workflow.mjs:3025-3056`；qmd index release 已 guarded：`scripts/graphrag/batch-epub-workflow.mjs:2997-3009`。但 runner 的 JSON/YAML checksum backfill/reconcile 分支未整体包在 per-target durable lock 内：`scripts/graphrag/batch-epub-workflow.mjs:4342-4411`, `scripts/graphrag/batch-epub-workflow.mjs:4463-4533`。`resume-book` qmd-index write stage 只使用 in-process semaphore，未调用 qmd index file lock：`scripts/graphrag/batch-epub-workflow.mjs:8544-8559`。qmd index lock wait timeout 仍抛普通 `Error`，未投射为 durable lock timeout：`scripts/graphrag/batch-epub-workflow.mjs:3121-3122`。 |
| I03_collision_resistant_temp_creation | PASS | runner tempId 包含 pid、Date.now、randomUUID：`scripts/graphrag/batch-epub-workflow.mjs:2196-2199`；durable JSON temp 和 sidecar 使用 `wx`：`scripts/graphrag/batch-epub-workflow.mjs:3827-3835`, `scripts/graphrag/batch-epub-workflow.mjs:3695-3712`；EEXIST 分类为 `durable_temp_create_collision`：`scripts/graphrag/batch-epub-workflow.mjs:3801-3817`。shared store 同样使用 randomUUID tempId 与 exclusive create：`src/job-state/durable-state-store.ts:1378-1379`, `src/job-state/durable-state-store.ts:294-310`, `src/job-state/durable-state-store.ts:862-868`, `src/job-state/durable-state-store.ts:1180-1199`。残余风险归入 I10：未见 forced temp id collision fault test。 |
| I04_owner_evidence_and_cleanup_safety | FAIL | runner cleanup 会读取 owner、target、generation、fencing、target checksum、owner alive 与 lease expiry，并保留 remote owner unproven temp：`scripts/graphrag/batch-epub-workflow.mjs:3957-4050`。但 shared store 的 cleanup 只把本机同 host 且 pid alive 视为 active，remote owner 会在 TTL 过期且 evidence 完整时被删除；未证明 owner-dead 或 lease-expired：`src/job-state/durable-state-store.ts:695-722`, `src/job-state/durable-state-store.ts:736-763`。shared store temp owner evidence 也未写 `expiresAt`：`src/job-state/durable-state-store.ts:1378-1408`。现有测试还断言 `ownerHost: "complete-owner-host"` 的 stale temp 被删除：`test/book-job-state.test.ts:593-628`。这低于 criteria 的 cleanup safety 要求。 |
| I05_lock_freshness_fencing_and_takeover | PASS | runner JSON lock owner 写入 generation、fencingTokenHash、heartbeatAt、expiresAt、operationId：`scripts/graphrag/batch-epub-workflow.mjs:4725-4748`；提交前后检查当前 lock owner：`scripts/graphrag/batch-epub-workflow.mjs:4669-4699`, `scripts/graphrag/batch-epub-workflow.mjs:4754-4756`, `scripts/graphrag/batch-epub-workflow.mjs:4830-4832`；release guarded：`scripts/graphrag/batch-epub-workflow.mjs:4702-4714`。stale lock recovery 要求 expiry、recovery fence 与 owner dead：`scripts/graphrag/batch-epub-workflow.mjs:4634-4662`。qmd index lock 也具备 recovery fence 与 guarded release：`scripts/graphrag/batch-epub-workflow.mjs:2960-3009`。残余风险：JSON/qmd file lock 没有持续 heartbeat refresh，长 critical section 仍有可用性风险。 |
| I06_atomic_replace_and_fsync_boundary | PASS | runner durable JSON replace 顺序包含 owner sidecar、temp write/fsync、pending meta、target rename、checksum temp write/fsync、checksum rename、committed meta、parent directory fsync：`scripts/graphrag/batch-epub-workflow.mjs:3821-3868`。shared store 同步/异步路径也按对应顺序执行：`src/job-state/durable-state-store.ts:275-319`, `src/job-state/durable-state-store.ts:329-374`。file fsync 与 directory fsync 失败分类为 local state integrity，并设置 `completedPublishRule: "forbidden"`：`scripts/graphrag/batch-epub-workflow.mjs:2562-2578`, `scripts/graphrag/batch-epub-workflow.mjs:2594-2603`, `src/job-state/durable-state-store.ts:1108-1158`, `src/job-state/durable-state-store.ts:1160-1177`。残余风险：I10 中缺 directory fsync fault injection 覆盖。 |
| I07_checksum_generation_crash_window_recovery | FAIL | checksum backfill 仍主要由 checksum/meta locator 证明。runner 的 `checksumCommitEvidenceMatches()` 只验证 checksum 与 target locator/basename：`scripts/graphrag/batch-epub-workflow.mjs:3732-3737`；`target_new_checksum_old` 与 `target_new_checksum_missing` 可直接 backfill：`scripts/graphrag/batch-epub-workflow.mjs:4390-4411`, `scripts/graphrag/batch-epub-workflow.mjs:4511-4533`；`backfillDurableChecksum()` 新建 operation evidence，但没有验证旧 commit 的 generation/owner/fencing evidence：`scripts/graphrag/batch-epub-workflow.mjs:4248-4266`。shared store 同样只按 checksum/meta 分支恢复：`src/job-state/durable-state-store.ts:405-440`, `src/job-state/durable-state-store.ts:468-503`, `src/job-state/durable-state-store.ts:1238-1246`。 |
| I08_rename_enoent_failure_classification | PASS | runner `renameWithDurableEvidence()` 将 ENOENT 分类为 `durable_temp_rename_enoent`，携带 target、tempId、operationId、failedSyscall、errno、renameCause、fencing/owner evidence 和 `completedPublishRule: "forbidden"`：`scripts/graphrag/batch-epub-workflow.mjs:3758-3780`, `scripts/graphrag/batch-epub-workflow.mjs:2196-2245`。checkpoint、event、recovery summary 覆盖 stop-until-fixed：`test/cli.test.ts:3190-3321`。shared store 也保留 ENOENT durable class：`src/job-state/durable-state-store.ts:986-1008`, `src/job-state/durable-state-store.ts:1014-1036`。残余风险：shared store evidence 不如 runner 完整，依赖 I01 的边界修复收敛。 |
| I09_resume_preflight_and_runner_recovery | FAIL | `before_resume_book` 与 `before_claim` 调用点存在：`scripts/graphrag/batch-epub-workflow.mjs:8504`, `scripts/graphrag/batch-epub-workflow.mjs:9102`。preflight 已扫描 run manifest/items/provider slots/subprocesses/book leases，并对 primary JSON 做 reconcile：`scripts/graphrag/batch-epub-workflow.mjs:4142-4214`。但扫描目标仍不含 qmd index SQLite / `.lock`、book-scoped YAML、settings.yaml、graph capability catalog、DSPy policy、LanceDB row-count sidecars 等生产 durable targets；`runner_start` 还显式跳过 temp：`scripts/graphrag/batch-epub-workflow.mjs:9919`。preflight 对 provider slot、book lease、subprocess registry 主要是 JSON integrity scan，未完整执行 live/stale/orphan 语义判断。 |
| I10_regression_tests_and_observability | FAIL | observability schema 已覆盖 localFailureClass、targetLocator、lane、targetMappingOwner、tempId、operationId、lockOwnerEvidence、checksumRecoveryDecision、fsyncTarget、fsyncErrno、fencingTokenHash 等字段：`src/contracts/batch-run.ts:134-186`, `src/contracts/batch-run.ts:226-255`, `src/contracts/batch-run.ts:360-397`, `src/contracts/batch-run.ts:399-440`。已有测试覆盖 same-ms temp、active/stale temp、pending meta、rename ENOENT、qmd index lock、provider slot stale release：`test/book-job-state.test.ts:420-457`, `test/cli.test.ts:2719-2955`, `test/cli.test.ts:3043-3110`, `test/cli.test.ts:3190-3321`, `test/cli.test.ts:4491-4538`, `test/cli.test.ts:4010`。但未见 forced temp id collision、directory fsync fault injection、partial checksum sidecar、resume-book orphan temp 的直接测试或注入钩子；现有 test hooks 仅覆盖 lock wait、temp stale、rename ENOENT、runner-start preflight skip：`scripts/graphrag/batch-epub-workflow.mjs:157-178`。 |

## 阻塞问题

### 1. Durable boundary 仍不是可执行的单一边界

证据：

- runner 的 adapter contract 是静态元数据，未导入 shared store：
  `scripts/graphrag/batch-epub-workflow.mjs:194-208`。
- runner 与 shared store 各自实现 durable write/reconcile/lock：
  `scripts/graphrag/batch-epub-workflow.mjs:3821-3868`,
  `scripts/graphrag/batch-epub-workflow.mjs:4342-4582`,
  `src/job-state/durable-state-store.ts:275-510`。
- shared store 与 runner cleanup 语义不同，见阻塞问题 3。

建议修复：

- 抽取一个实际 shared durable module，runner 通过 adapter 调用同一实现。
- 若保留 runner adapter，增加 executable conformance tests（可执行等价测试），覆盖
  temp cleanup、lock recovery、checksum backfill、rename ENOENT、fsync failure。
- adapter contract 不应只作为 evidence 字段存在，应约束代码路径。

### 2. Lane/lock enforcement 仍有未覆盖路径

证据：

- qmd index lock owner 已具备 lane/generation/fencing/operationId：
  `scripts/graphrag/batch-epub-workflow.mjs:3025-3056`。
- 但 runner JSON/YAML checksum backfill 分支不在完整 per-target lock 内：
  `scripts/graphrag/batch-epub-workflow.mjs:4342-4411`,
  `scripts/graphrag/batch-epub-workflow.mjs:4463-4533`。
- `resume-book` 的 qmd index write stage 只进入 `qmdIndexWriterLane`，未进入
  qmd index file lock：
  `scripts/graphrag/batch-epub-workflow.mjs:8544-8559`。
- qmd index lock wait timeout 仍为普通 Error：
  `scripts/graphrag/batch-epub-workflow.mjs:3121-3122`。

建议修复：

- 将 checksum reconcile/backfill/quarantine 全部放入 per-target durable lock。
- 对所有可能写 qmd index 的 stage，包括 resume-book 子进程路径，使用同一 qmd
  index durable file lock。
- qmd index lock timeout 应投射为 `local_state_lock_timeout` /
  `durable_state_lock_timeout`，并记录 current owner evidence。

### 3. Shared store stale temp cleanup 可删除 remote active temp

证据：

- shared store 只把同 host 且 pid alive 判定为 active：
  `src/job-state/durable-state-store.ts:716-719`。
- remote owner host 不会被证明死亡，也没有 lease-expired 检查，但仍可删除：
  `src/job-state/durable-state-store.ts:720-722`。
- shared store operation evidence 没有写 `expiresAt`：
  `src/job-state/durable-state-store.ts:1378-1408`。
- 当前测试断言 remote-looking complete owner temp 被删除：
  `test/book-job-state.test.ts:593-628`。

建议修复：

- shared store cleanup 应与 runner 对齐：remote owner 未过期时保留，并记录
  `remote_owner_unproven` 或等价诊断。
- temp owner evidence 写入 recoverable lease expiry 或 session expiry。
- 删除 temp 前必须证明 owner dead、lease expired，或 fencing/session 已失效。

### 4. Checksum/generation recovery 仍缺 owner/generation proof

证据：

- runner `checksumCommitEvidenceMatches()` 只检查 checksum 与 locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3732-3737`。
- `target_new_checksum_old`、`target_new_checksum_missing` 直接 backfill：
  `scripts/graphrag/batch-epub-workflow.mjs:4390-4411`,
  `scripts/graphrag/batch-epub-workflow.mjs:4511-4533`。
- shared store 也在相同 crash window 下直接 backfill：
  `src/job-state/durable-state-store.ts:408-440`,
  `src/job-state/durable-state-store.ts:471-503`。

建议修复：

- checksum meta 必须作为 commit record，包含 generation、operationId、owner、
  leaseGeneration、fencingTokenHash、targetChecksumBefore/after。
- backfill 前验证 target 内容与 commit record 的 generation/owner/fencing 一致。
- 证据缺失或 partial sidecar 时 quarantine 或 stop_until_fixed，而不是自动 backfill。

### 5. Resume/claim preflight 覆盖面不足

证据：

- preflight target 仅为 manifest dirname、items、provider-slots、subprocesses、
  book-leases：
  `scripts/graphrag/batch-epub-workflow.mjs:4198-4205`。
- 未扫描 qmd index SQLite lock、book-scoped YAML、settings.yaml、graph capability
  catalog、DSPy、LanceDB sidecars。
- `runner_start` 使用 `{ includeTemps: false }`：
  `scripts/graphrag/batch-epub-workflow.mjs:9919`。

建议修复：

- preflight 入口复用 durable target registry（目标注册表），覆盖所有生产 durable
  YAML/JSON/SQLite target。
- 在 `before_claim` 与 `before_resume_book` 中执行 checksum/generation verifier、
  qmd index lock verifier、provider slot verifier、subprocess registry verifier、
  book lease verifier。
- 对 unknown/live temp、不可判定 lock owner、不可收敛 checksum、异常 lease/registry
  状态统一写 `durable_preflight_blocked` 并 stop_until_fixed。

### 6. Fixed regression matrix 仍未补齐

证据：

- 现有 hooks 未包含 forced temp id collision、directory fsync fault、partial
  checksum sidecar、resume-book orphan temp：
  `scripts/graphrag/batch-epub-workflow.mjs:157-178`。
- 现有测试覆盖了多项正向修复，但没有上述固定 fault injection 场景的名称或断言：
  `test/cli.test.ts:2574-3321`,
  `test/cli.test.ts:4491-4538`,
  `test/book-job-state.test.ts:420-630`。

建议修复：

- 增加 deterministic temp id override 或 collision injection hook，并断言
  `durable_temp_create_collision`。
- 增加 directory fsync failure hook，断言 checkpoint/event/status/recovery summary
  均为 stop_until_fixed。
- 增加 partial checksum sidecar、missing generation/owner commit record、resume-book
  orphan temp preflight blocked 测试。

## PASS 项剩余非阻塞风险

- I03：实现层满足 temp entropy 与 exclusive create；但缺 forced collision 测试，
  已在 I10 中阻塞。
- I05：lock fencing 与 guarded release 已满足完整性要求；长 critical section
  无 heartbeat refresh，仍可能造成可用性问题。
- I06：fsync 分类路径存在；缺平台级 directory fsync fault injection。
- I08：runner ENOENT evidence 完整；shared store evidence 字段较少，应随 I01
  收敛到同一 projection。

## 本轮使用的验证输入

采用用户提供的本轮验证结果作为执行验证输入，未重新启动真实 runner：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types`
- CLI durable 聚焦组：9 passed
- book-state durable 聚焦组：4 passed，graph capability pattern 仍 skipped
- `book-concurrency 2 runs multiple books through the worker pool`
- `durable provider slots gate capacity across concurrent workers`
- `all batch qmd commands acquire the qmd index file lock`
- `terminal completion events share the checkpoint finalization fence`
- `parallel non-transient failure quiesces sibling workers`
- `provider slot stale release cannot delete the current durable slot`
- 进程检查：仅匹配检查命令本身，无旧 runner/vitest 残留

## 实际查看的文件

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r4.md`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/job-state/durable-state-store.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`

## 实际执行的命令

- `pwd && ls -la audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a`
- `sed -n '1,240p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
- `sed -n '1,260p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r4.md`
- `rg -n "durable|Durable|checksum|generation|operationId|fencing|qmd index|QmdIndex|withQmdIndex|preflight|before_claim|before_resume_book|forced temp|temp id|fsync|orphan|partial checksum|target_new_checksum|pending_commit|committed|adapter|targetMapping|lane" scripts/graphrag/batch-epub-workflow.mjs`
- `rg -n "durable|Durable|checksum|generation|operationId|fencing|preflight|temp|lock|adapter|targetMapping|lane|committed|pending" src/job-state/durable-state-store.ts`
- `rg -n "durable|Durable|checksum|generation|operationId|fencing|preflight|temp|lock|ENOENT|fsync|collision|orphan|partial|pending|qmd index|provider slot|book lease|before_resume|before_claim" test/cli.test.ts test/book-job-state.test.ts src/contracts/batch-run.ts`
- `rg -n "durableAdapterContract|runner-equivalent|shared-durable-state-store|targetGenerationFence|guardedLockRelease|preflightReconcile" test/cli.test.ts test/book-job-state.test.ts scripts/graphrag/batch-epub-workflow.mjs src/job-state/durable-state-store.ts`
- `rg -n "test\\(\\\".*(durable|checksum|temp|lock|fsync|collision|orphan|preflight|provider slot|qmd index|rename|ENOENT|sidecar|pending).*\\\"" test/cli.test.ts test/book-job-state.test.ts`
- `rg -n "QMD_GRAPHRAG_TEST_|TEST_.*(FSYNC|TEMP|COLLISION|CHECKSUM|PREflight|RENAME|LOCK)|test.*fsync|fsync.*test|inject|forced|force" scripts/graphrag/batch-epub-workflow.mjs test/cli.test.ts test/book-job-state.test.ts src/job-state/durable-state-store.ts`
- `rg -n "import .*durable-state-store|durable-state-store|writeJsonFileDurable|writeYamlFileDurable|readJsonFileDurable|readYamlFileDurable" scripts/graphrag/batch-epub-workflow.mjs src/job-state/durable-state-store.ts test/cli.test.ts test/book-job-state.test.ts`
- `rg -n "qmd_index_file_lock|qmd index file lock|qmdIndex|sqlite-lock|qmdIndexWriterLane|qmd_index" scripts/graphrag/batch-epub-workflow.mjs test/cli.test.ts src/contracts/batch-run.ts`
- 多次 `nl -ba ... | sed -n '...'` 定位上述证据行。
- `test -e audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md; echo $?`
- `git status --short -- audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a scripts/graphrag/batch-epub-workflow.mjs src/job-state/durable-state-store.ts src/contracts/batch-run.ts test/cli.test.ts test/book-job-state.test.ts`
- `sed -n '1,80p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md`
- `tail -n 80 audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md`
- `wc -l audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md`
- `ls -l audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md`
- `git status --short --untracked-files=all -- audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md`
- `git check-ignore -v audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r5.md || true`
