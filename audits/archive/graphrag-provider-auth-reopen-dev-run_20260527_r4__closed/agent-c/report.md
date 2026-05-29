# GraphRAG Provider Auth Reopen 审计报告

## 结论

PASS

当前实现从测试与契约角度足以恢复真实处理图书，并已有回归覆盖防止
running 总量不动、0 completed 状态误判。审计未读取、打印、摘要或暴露
任何真实 `.env` secret 值；证据只使用 present、missing、source、
fingerprint、redacted 语义。

## 测试证据

- PASS: `env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}"
  NODE_OPTIONS="${NODE_OPTIONS:-}" CI=true node ./node_modules/vitest/vitest.mjs
  run test/integrations/contracts.test.ts --testNamePattern
  "batch|GraphRAG contracts|provider request fingerprint" --testTimeout 120000
  --reporter=dot`
  结果：1 个 test file passed，11 个 tests passed，59 个 skipped。
- PASS: `env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}"
  NODE_OPTIONS="${NODE_OPTIONS:-}" CI=true node ./node_modules/vitest/vitest.mjs
  run test/cli.test.ts --testNamePattern
  "provider auth|migrate-only preserves completed|stale GraphRAG producer|GraphRAG
  query check|incomplete command check|orphaned running|fresh remote running|stale
  remote running|runtime provider auth" --testTimeout 180000 --reporter=dot`
  结果：1 个 test file passed，25 个 tests passed，179 个 skipped。
- PASS: `env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}"
  NODE_OPTIONS="${NODE_OPTIONS:-}" npm run test:types`
  结果：TypeScript build typecheck passed。

## 审计结果

### 1. 类型契约完整性

Status: PASS

文件/行号证据：`src/contracts/batch-run.ts:38` 定义 build status 并包含
`stale`；`src/contracts/batch-run.ts:57` 定义 command check 失败分类与
provider status 字段；`src/contracts/batch-run.ts:77` 至
`src/contracts/batch-run.ts:123` 定义 checkpoint source identity、runner
lease、build/query status 与 commandChecks；`src/contracts/batch-run.ts:132`
至 `src/contracts/batch-run.ts:162` 强制 running lease 与非 transient
retryExhausted 不变量；`src/contracts/batch-run.ts:216` 至
`src/contracts/batch-run.ts:298` 覆盖 recovery summary 的 provider auth、
dotenv source、fingerprint 与 legacy missing 字段。

测试证据：`test/integrations/contracts.test.ts:1422` 至
`test/integrations/contracts.test.ts:1490` 验证 legacy checkpoint hydration；
`test/integrations/contracts.test.ts:1641` 至
`test/integrations/contracts.test.ts:1680` 验证 batch manifest、checkpoint、
event log、recovery summary 的 data bus schema。目标契约测试 11 passed；
`npm run test:types` passed。

风险：脚本内存在本地 schema 镜像，例如
`scripts/graphrag/batch-epub-workflow.mjs:575` 至
`scripts/graphrag/batch-epub-workflow.mjs:601`，后续需防止契约漂移。

Must-fix：无。

### 2. 状态计数守恒

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:3605` 至
`scripts/graphrag/batch-epub-workflow.mjs:3622` 从 checkpoint 集合重算
manifest 计数；`scripts/graphrag/batch-epub-workflow.mjs:3642` 至
`scripts/graphrag/batch-epub-workflow.mjs:3658` 用失败、全量完成、
pending/running 空集合和 provider wait limit 判定 run status；
`scripts/graphrag/batch-epub-workflow.mjs:5057` 至
`scripts/graphrag/batch-epub-workflow.mjs:5060` 对 0 EPUB 直接失败，
避免 0 completed 误判完成；`scripts/graphrag/batch-epub-workflow.mjs:5061`
至 `scripts/graphrag/batch-epub-workflow.mjs:5070` status-json 输出前先
load checkpoint 并 updateManifest。

测试证据：`test/cli.test.ts:5703` 至 `test/cli.test.ts:5875` 覆盖
orphaned running 恢复为 pending；`test/cli.test.ts:8116` 至
`test/cli.test.ts:8227` 覆盖 fresh remote running 不被抢占；
`test/cli.test.ts:8230` 至 `test/cli.test.ts:8345` 覆盖 stale remote
running status-json 只读；`test/cli.test.ts:8459` 至
`test/cli.test.ts:8583` 覆盖 normal run 恢复 stale remote running。CLI
目标测试 25 passed。

风险：跨主机 runner lease 依赖 heartbeat 时间；需要运维时钟基本同步。

Must-fix：无。

### 3. Provider Auth Reopen 门禁

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:781` 至
`scripts/graphrag/batch-epub-workflow.mjs:795` 识别 401、403 与 auth 失败
文本；`scripts/graphrag/batch-epub-workflow.mjs:1005` 至
`scripts/graphrag/batch-epub-workflow.mjs:1078` 要求 failed、
retryable=false、stop_until_fixed、context ready、fingerprint 变化或 legacy
missing、未达 attempt limit、未重复 reopen；`scripts/...:1162` 至
`scripts/...:1250` reopen 后改为 pending、清空失败状态和 commandChecks、
记录 normalCommandChecksRequired；`scripts/...:1253` 至
`scripts/...:1319` 在 lock 内二次判定 eligibility。

测试证据：`test/cli.test.ts:6228` 至 `test/cli.test.ts:6447` 覆盖 legacy
auth checkpoint reopen 一次并 rerun 完整闭环；`test/cli.test.ts:7130` 至
`test/cli.test.ts:7204` 覆盖 attempt limit；`test/cli.test.ts:7207` 至
`test/cli.test.ts:7277` 覆盖 current fingerprint 已 reopen；`test/cli.test.ts:7280`
至 `test/cli.test.ts:7347` 覆盖 fingerprint unchanged；`test/cli.test.ts:7350`
至 `test/cli.test.ts:7458` 覆盖 refailure 清理 stale reopen eligibility。CLI
目标测试 25 passed。

风险：新 provider 错误文案仍需按真实样本扩展分类器。

Must-fix：无。

### 4. Secret 最小暴露

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:797` 至
`scripts/graphrag/batch-epub-workflow.mjs:800` 只生成 fingerprint；
`scripts/...:876` 至 `scripts/...:945` provider auth context 只输出
presence、source、missing、shadowed names、dotenv fingerprints 和 present
flags；`scripts/...:1608` 至 `scripts/...:1620` 对错误摘要 redaction；
`scripts/...:1637` 至 `scripts/...:1654` 注册 exact env/dotenv redaction；
`scripts/...:1796` 至 `scripts/...:1803` event 写入前 redacted。

测试证据：`test/cli.test.ts:6444` 至 `test/cli.test.ts:6447`、
`test/cli.test.ts:6523` 至 `test/cli.test.ts:6525`、
`test/cli.test.ts:6854` 至 `test/cli.test.ts:6864` 验证状态和 summary 不含
secret 原文；`test/cli.test.ts:10223` 至 `test/cli.test.ts:10260` 覆盖
preflight exact value redaction；`test/cli.test.ts:10262` 起覆盖 URL
credential redaction。CLI 目标测试 25 passed。

风险：本审计未读取真实 `.env`；结论基于 redaction 路径和测试 fixture。

Must-fix：无。

### 5. Dotenv 优先级与 Shadow 诊断

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:842` 至
`scripts/graphrag/batch-epub-workflow.mjs:873` 区分 missing、
dotenv_not_loaded、process_env_shadows_dotenv、graph_vault 覆盖 root dotenv
等 source；`scripts/...:876` 至 `scripts/...:945` 生成 readinessStatus；
`scripts/...:1781` 至 `scripts/...:1794` 先加载 project dotenv，再加载
graph_vault `.env`，且不覆盖初始 shell env。

测试证据：`test/cli.test.ts:6449` 至 `test/cli.test.ts:6526` 覆盖 shell
shadow；`test/cli.test.ts:6528` 至 `test/cli.test.ts:6600` 覆盖 endpoint
shadow；`test/cli.test.ts:6758` 至 `test/cli.test.ts:6865` 覆盖 graph_vault
dotenv precedence；`test/cli.test.ts:6867` 至 `test/cli.test.ts:7009` 覆盖
missing key/endpoint；`test/cli.test.ts:7012` 至 `test/cli.test.ts:7060`
覆盖 `--skip-dotenv`；`test/cli.test.ts:7062` 至 `test/cli.test.ts:7127`
覆盖 unreadable provider config。CLI 目标测试 25 passed。

风险：当前默认要求 OpenAI base URL；若未来支持无需 base URL 的模式，需同步
调整契约和测试。

Must-fix：无。

### 6. 迁移模式只做 Hydration

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:2157` 至
`scripts/graphrag/batch-epub-workflow.mjs:2168` 在 migrateOnly 下只写 hydrated
checkpoint 和 build status snapshot；`scripts/...:5067` 至 `scripts/...:5075`
normal path 才迁移 producer manifest，migrate-only 进入状态迁移分支；
`scripts/...:5073` 至 `scripts/...:5093` migrate-only 写 summary 与
`batch_state_migrated` 后 return。

测试证据：`test/cli.test.ts:2610` 起覆盖 migrate-only 回填 legacy failure
events；`test/cli.test.ts:2809` 起覆盖绝对 GraphRAG output manifest locator
迁移；`test/cli.test.ts:8596` 至 `test/cli.test.ts:8725` 覆盖 migrate-only
保留缺少真实 GraphRAG evidence 的 completed item。CLI 目标测试 25 passed。

风险：migrate-only 会写迁移产物，不是 dry-run。

Must-fix：无。

### 7. GraphRAG 真实证据门禁

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:2760` 至
`scripts/graphrag/batch-epub-workflow.mjs:2795` 验证 artifact realpath、
content hash、parquet、JSON、LanceDB；`scripts/...:2839` 至 `scripts/...:2858`
限定 query_ready artifact 来源；`scripts/...:2861` 至 `scripts/...:2950`
校验 producerRunId、stage/provider fingerprint、corpus hash 和 book-scoped
path；`scripts/...:2952` 至 `scripts/...:3062` 校验 checkpoint 与 required
artifact；`scripts/...:3064` 至 `scripts/...:3178` 对 job、producer manifest、
stage producer run 与 fingerprint 做最终门禁。

测试证据：`test/cli.test.ts:8844` 起覆盖 portable book-scoped GraphRAG
producer evidence；`test/cli.test.ts:9150` 起验证 query check failed 不得保持
completed；`test/cli.test.ts:9777` 起验证 stale producer lineage；`test/integrations/contracts.test.ts:1342`
起验证 high-cost artifacts 必须带 stage/provider fingerprints。目标测试均
passed。

风险：未执行真实高成本 EPUB GraphRAG provider 调用；测试验证的是 gate 与
contract 不变量。

Must-fix：无。

### 8. Stale Lineage 可诊断

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:2890` 与
`scripts/graphrag/batch-epub-workflow.mjs:2896` 记录 producer run mismatch；
`scripts/...:3007` 至 `scripts/...:3022` 返回 stage/provider fingerprint
mismatch reason；`scripts/...:3106` 至 `scripts/...:3119` 将相关证据问题投影
为 `stale`；`scripts/...:3151` 至 `scripts/...:3167` 对 producer manifest
stage missing、run mismatch、fingerprint mismatch 给出具体 reason；
`scripts/...:3690` 至 `scripts/...:3712` summary 输出 graphBuildStatus 与
graphQueryStatus。

测试证据：`test/cli.test.ts:9777` 至 `test/cli.test.ts:10050` 验证 stale
producer lineage 在 status-json 中投影为 pending item，graphBuildStatus 为
stale，reason 指向 community_report producer run mismatch，且 status-json
不写盘。CLI 目标测试 25 passed。

风险：status-json 是只读投影；实际降级需 normal run 持久化。

Must-fix：无。

### 9. Completed Downgrade 闭环

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:3318` 至
`scripts/graphrag/batch-epub-workflow.mjs:3353` 要求 command checks 完整、
唯一、无 unexpected、无 failed；`scripts/...:3398` 至 `scripts/...:3416`
要求 command checks、QMD build、GraphRAG build、GraphRAG query 全成功才保留
completed；`scripts/...:3417` 至 `scripts/...:3465` 否则降级 pending 并记录
reopenReason、commandCheckStatus 和 build/query status；`scripts/...:2157`
至 `scripts/...:2175` 非 migrateOnly 才执行 completed downgrade。

测试证据：`test/cli.test.ts:8596` 至 `test/cli.test.ts:8725` 覆盖 migrate-only
不降级；`test/cli.test.ts:9150` 至 `test/cli.test.ts:9429` 覆盖 GraphRAG
query failed 降级；`test/cli.test.ts:9432` 至 `test/cli.test.ts:9691` 覆盖
command check incomplete 降级；`test/cli.test.ts:9694` 至
`test/cli.test.ts:9775` 覆盖 non-transient failed check 降级。CLI 目标测试
25 passed。

风险：status-json 降级不写盘，需 normal run 完成实际修复。

Must-fix：无。

### 10. CLI Query/Command Completion Gates

Status: PASS

文件/行号证据：`scripts/graphrag/batch-epub-workflow.mjs:186` 至
`scripts/graphrag/batch-epub-workflow.mjs:214` 定义 27 个 required checks；
`scripts/...:215` 至 `scripts/...:223` 分离 GraphRAG query checks；
`scripts/...:3222` 至 `scripts/...:3271` QMD native evidence 不含 graph-query
checks；`scripts/...:3273` 至 `scripts/...:3316` GraphRAG query evidence 单独
要求 auto 与 graphrag query；`scripts/...:4659` 至 `scripts/...:4678` 对
expected count、unique、missing、unexpected、failed 硬失败；`scripts/...:4680`
至 `scripts/...:4716` 执行完整 CLI checks；`scripts/...:4725` 至
`scripts/...:4788` 三类 gate 全成功才写 completed。

测试证据：`test/cli.test.ts:1042` 至 `test/cli.test.ts:1073` 的 fixture
command names 与生产列表对齐；`test/cli.test.ts:6228` 至
`test/cli.test.ts:6447` 验证 provider auth reopen 后 commandChecks 名称等于
required list；`test/cli.test.ts:9150` 至 `test/cli.test.ts:9429` 验证
GraphRAG query failed 阻止 completed；`test/cli.test.ts:9432` 至
`test/cli.test.ts:9691` 验证 incomplete command set 阻止 completed。CLI 目标
测试 25 passed。

风险：fake qmd runner 覆盖状态机 gate，不验证真实 qmd 子命令语义；真实子命令
语义由其他 CLI 集成测试承担。

Must-fix：无。

## 汇总风险

- 未执行真实高成本 EPUB GraphRAG provider 调用；本结论限定为测试与契约审计。
- 大型 batch workflow 脚本仍有 schema 双维护风险，后续变更需继续用契约测试
  和 CLI 状态机测试防止漂移。

## Must-fix

无。
