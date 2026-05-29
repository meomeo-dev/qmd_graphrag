# r5 GraphRAG QMD Build Gate 开发审计基准

1. 独立 qmd 构建证据（independent qmd build evidence）
   `qmdBuildStatus` 必须从
   `books/<bookId>/qmd/qmd_build_manifest.json` 重新计算，不得信任
   checkpoint 中持久化的旧字段。

2. 固定命令检查集合（fixed command check set）
   `commandCheckStatus` 必须从固定 qmd CLI 子命令集合重新计算。缺失、
   重复、意外或失败检查均不得通过完成门。

3. 闭环完成门（closed-loop completion gate）
   只有 qmd build、GraphRAG build、GraphRAG query 和全部命令检查同时成功，
   单书 checkpoint 才能写入 `completed`。

4. 旧完成状态降级（legacy completed downgrade）
   `--migrate-only`、`--status-json` 和正式运行都不得信任旧 `completed`。
   闭环证据无效时必须 reopen，证据缺口不得被写成停止态 retry exhaustion。

5. checkpoint 身份保留（checkpoint identity preservation）
   已存在 checkpoint 的证据重算必须优先使用 checkpoint 实际 `bookId` 和
   `normalizedPath`，避免 catalog drift 造成误 pending、误 stale 或误成功。

6. GraphRAG 书级产物隔离（book-scoped GraphRAG artifacts）
   GraphRAG 产物和 producer manifest 必须限定在 `books/<bookId>/output`。
   共享输出、host absolute locator 和跨书产物必须 fail closed。

7. GraphRAG producer lineage 对齐（producer lineage alignment）
   GraphRAG build 成功必须要求 stage checkpoint、artifact `producerRunId`、
   stage fingerprint、provider fingerprint、内容身份和
   `qmd_output_manifest.json` producer lineage 一致。

8. provider transient 恢复投影（provider transient recovery projection）
   transient provider/network failure 必须保留同一 `runId` 恢复能力，保留
   retry/wait metadata，并在 summary 中清晰投影恢复状态。

9. 旧 provider auth 失败恢复（legacy provider auth recovery）
   provider auth stop 必须基于当前 readiness、presence、source 和 fingerprint
   投影 `--migrate-only` 与 `--status-json` 恢复状态；不得输出原始密钥值。

10. 契约、文档和回归一致性（contract, documentation, regression parity）
    runtime schema、操作文档和 focused regression 必须表达与实现相同的不变量。
