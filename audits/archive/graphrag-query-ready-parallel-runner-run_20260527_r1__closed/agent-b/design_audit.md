# 设计审计 B

## 固定审计基准

1. 同一 `runId` 不能允许多个 writer 无租约地写同一 item。
2. 同一 `bookId` 必须只有一个 writer 拥有执行权。
3. `.qmd/index.sqlite` 写入必须串行化。
4. `graph_vault/catalog/*.yaml` 写入必须有互斥或单 writer lane。
5. `graph_vault/catalog/graph-capabilities.yaml` 发布必须有 fencing。
6. `books/<bookId>/output/qmd_output_manifest.json` 不能被并发 stage 覆盖。
7. provider 并发必须按 OpenAI/Jina/GraphRAG stage 分别限流。
8. batch manifest 和 event log 写入必须支持并发追加或由单协调器集中写入。
9. stale writer 必须被 fencing token 拒绝。
10. 并行化不能改变每本书的闭环完成判定。

## 审计结论

不通过。当前系统不安全支持多个独立 runner 同时处理同一个 batch run。
批处理脚本是顺序调度器，只对单 item checkpoint 做了基础 lock；共享 catalog、
qmd index、capability catalog 和 provider budget 没有完整并发控制。

用户提出的资源闲置问题成立：Jina 或 GraphRAG 等待期间，OpenAI/qmd 资源可能
空闲。但不能直接启动多个 writer 规避，因为会产生 catalog 和 book output 竞争。

## 必须修正

- 本轮不得启用多进程 multi-runner。
- 并行设计应先落为文档和约束：item lease、book lease、catalog writer lane、
  qmd index writer lane、provider semaphores、event/manifest 聚合、fencing token。
- 可后续优先实现单进程 worker pool，因为它更容易共享锁、队列和 provider budget。
