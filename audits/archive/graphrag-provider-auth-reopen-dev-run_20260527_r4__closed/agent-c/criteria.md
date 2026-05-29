# GraphRAG 恢复审计基准

## 1. 类型契约完整性

批处理 manifest、item checkpoint、event log 和 recovery summary 必须由
稳定 schema 校验。契约必须覆盖状态计数、runner lease、命令检查、
GraphRAG build/query 证据、provider auth reopen 诊断字段，以及
secret 安全表达字段。

## 2. 状态计数守恒

manifest 的 `pending`、`running`、`completed`、`skipped`、`failed`
计数必须从当前 item checkpoint 集合重新计算。状态汇总不得依赖陈旧
manifest 计数，不得把 0 completed 误判为完成，也不得让 running 总量
在 orphan 或 stale runner 场景下卡死。

## 3. Provider Auth Reopen 门禁

401、403、invalid key、unauthorized、forbidden、authentication 等不可恢复
provider auth 失败只能在当前 provider auth 上下文 ready 且 fingerprint
相对失败上下文变化或 legacy 缺失时 reopen。reopen 必须清空失败状态、
保留审计元数据、限制重复 reopen，并要求完整闭环命令检查。

## 4. Secret 最小暴露

审计、状态、事件、summary、错误和日志只能输出 present、missing、
source、fingerprint、redacted 等语义。不得持久化、打印或摘要 `.env`
secret 原文；root `.env` 与 graph_vault `.env` 的值只能以 fingerprint
和来源关系表达。

## 5. Dotenv 优先级与 Shadow 诊断

graph_vault `.env` 是恢复运行的优先 provider auth 来源，但 shell 中已
存在的同名变量不得被静默覆盖。系统必须诊断 process env shadow、
graph_vault 覆盖 root dotenv、dotenv 未加载、缺少 required key/endpoint
等状态，并阻止不安全 reopen。

## 6. 迁移模式只做 Hydration

`--migrate-only` 只允许补齐类型字段、迁移旧事件和可移植 locator，
不得执行真实图书处理、不得 reopen completed item、不得把缺少真实
GraphRAG 证据的 completed 状态降级。

## 7. GraphRAG 真实证据门禁

恢复真实处理图书前后，GraphRAG build evidence 必须验证 book-scoped
artifact、producer run lineage、stage fingerprint、provider fingerprint、
content hash、query_ready 依赖 artifact，以及 parquet/LanceDB/JSON
可读性。shared 或 bootstrap evidence 不得冒充真实完成。

## 8. Stale Lineage 可诊断

任何 GraphRAG lineage、producer run、stage fingerprint、provider
fingerprint、content hash 或 artifact mismatch 必须投影为 `stale` 或
明确失败原因，并暴露到 recovery summary。诊断必须指向具体 stage 或
artifact gate 原因，不能只给泛化失败。

## 9. Completed Downgrade 闭环

非迁移运行中，completed item 只有在完整命令检查、QMD build、GraphRAG
build 和 GraphRAG query check 全部成功时才能保持 completed。任一缺失、
失败或 stale 证据必须降级为 pending，并保留可恢复或 must-fix 语义。

## 10. CLI Query/Command Completion Gates

真实完成必须通过完整 CLI command check 集，包括 QMD native checks、
`qmd query --mode auto --json` 和 `qmd query --graphrag --graph-book-id
... --json`。命令集合必须数量正确、名称唯一、无 unexpected、无 failed；
GraphRAG query gate 不得被 QMD native gate 替代。
