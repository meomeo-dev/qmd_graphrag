# r5 GraphRAG qmd Build Gate 开发审计基准

## 1. 完成状态闭环原则

`completed` 只能由完整闭环证据产生。单个 item 必须同时满足 qmd build
manifest、GraphRAG build、GraphRAG query，以及固定 CLI command checks 全部
成功，才允许保持或写入 `completed`。

## 2. 独立 qmd build 证据原则

`qmdBuildStatus` 必须从当前书的
`books/<bookId>/qmd/qmd_build_manifest.json` 重新计算。不得把历史
checkpoint 字段、CLI command checks，或导入的 completed seed 当作 qmd build
事实源。

## 3. 固定 command check 集合原则

CLI command checks 必须使用稳定固定集合。集合大小、名称、唯一性和每项
`passed` 状态都必须校验；缺失、重复、未知名称或失败项均不得通过完成门。

## 4. GraphRAG producer lineage 原则

GraphRAG build 证据必须来自当前书的 succeeded stage checkpoint、artifact
manifest 和 producer manifest。stage runId、stage fingerprint、provider
fingerprint、content hash 和 artifact producer 必须一致。

## 5. book-scoped artifact 隔离原则

GraphRAG output 必须限定在 `books/<bookId>/output`。共享 output、host absolute
`outputDir`、跨书 artifact、realpath 越界或路径不匹配均不得发布 graph
capability 或支持 completed。

## 6. 旧 completed 重开原则

加载旧 `completed` checkpoint 时必须重新计算闭环证据。任一证据缺失、陈旧或
失败时，checkpoint 必须降级为 `pending`，保留可恢复失败分类，并记录重开事件
或在只读模式中投影等价状态。

## 7. migrate-only 审计迁移原则

`--migrate-only` 只允许做 schema/manifest/checkpoint 迁移和可验证的路径规范化，
不得执行 EPUB、GraphRAG、provider、Jina 或 qmd CLI 子命令。缺少闭环证据的
旧 completed 必须在迁移中重开，不能沿用旧完成计数。

## 8. status-json 只读投影原则

`--status-json` 必须只输出状态投影。它可以在内存中投影 stale completed、
provider auth reopen、orphan running 等恢复决策，但不得写 manifest、
checkpoint、event log、log 文件或迁移 producer manifest。

## 9. provider auth 恢复安全原则

provider auth stop checkpoint 只在当前 provider context ready、fingerprint
已变化、未超过重开上限且未重复使用当前 fingerprint 时重开。输出只能包含
present/missing/source/fingerprint/redacted 级别信息，不得暴露密钥值。

## 10. 恢复语义保持原则

transient provider/network failure 应保留同一 runId 的恢复语义，包括
`retry_same_run_id`、bounded wait、`nextRetryAt` 和可恢复 pending 状态。
非 transient 或本地证据缺失不得被误标为 completed，也不得错误设置为终止态来
阻断补跑。
