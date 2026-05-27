# 实施审计基准原则

1. Parallel runner 当前必须保持未启用状态（disabled by default）。任何
   多 runner 安全并发能力在完整实现和测试前不得被文档或 CLI 表述为可用能力。
2. 多 runner 资源竞争设计必须显式覆盖 item lease、book lease、provider
   semaphore、catalog writer lane、qmd index writer lane、fencing token 和事件聚合
   （event aggregation）。
3. item lease 必须保护 batch item 的 claim、heartbeat、retry、orphan recovery 和
   stop_until_fixed 观测，不得允许两个 runner 同时写同一 item checkpoint。
4. book lease 必须保护同一本书的 GraphRAG producer stage，确保同一 bookId 任一时刻
   最多一个活跃 producer runner。
5. provider semaphore 必须按 provider 和用途隔离。Jina embedding/rerank 等待不得阻塞
   OpenAI/ChatGPT/qmd query lane 或其他可运行图书。
6. catalog writer lane 必须串行化 graph_vault catalog、artifact manifest、capability
   catalog 和 batch manifest 写入，避免并行写覆盖与半写状态。
7. qmd index writer lane 必须串行化 qmd index/corpus/document identity projection 写入，
   并与 catalog writer lane 建立明确顺序和失败回滚边界。
8. fencing token 必须随 lease 写入并随每次持久化校验。过期 runner 即使进程仍存活，也不得
   覆盖新 owner 的 checkpoint、manifest 或 catalog。
9. event aggregation 必须保证多 runner 事件按 runId、itemId、bookId、stage、lease token
   可重建；聚合视图不得成为状态事实源。
10. boost/runbook 必须支持压缩后恢复（compacted resume）：能从 runId、失败 item、stage、
    failureKind、recoveryDecision、producer lineage 和下一步命令恢复操作上下文。
