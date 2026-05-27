# 固定实施审计基准原则

1. Producer lineage recovery gate 必须以当前 checkpoint 为事实源；旧的
   succeeded run record 不能覆盖当前 running、pending 或 failed producer
   checkpoint。
2. GraphRAG producer artifact 必须按 bookId、stage、producerRunId、artifact kind、
   stage fingerprint、provider fingerprint 和 corpus content hash 共同校验。
3. query_ready 必须 fail-closed，只有 graph_extract、community_report 和 embed
   三个 producer checkpoint 均为 succeeded 且 artifact 证据完整时才能完成。
4. query_ready 失败不得发布 graph_query capability，也不得把当前非成功 producer
   checkpoint 产生的 capability 暴露给 query route。
5. `query_ready requires completed graph_extract, community_report and embed stages`
   必须被分类为本地 artifact gate 或 producer lineage recovery 问题，不能停留在
   unknown permanent failure。
6. local artifact gate repair 只能修复可证明的本地投影或 lineage 缺口；需要真实
   GraphRAG 重建时必须 fail-closed 并指明 rebuild stage。
7. blocked repair 必须写入可观测事件或 recovery summary metadata，包含 blocked
   reason、active command、failed stage、reused producer run ids 和 repair decision。
8. 并行 runner 必须延后抢占 fresh running item；只有 ownership 缺失、heartbeat
   stale 或 pid 已死亡时，才可转为 retry_same_run_id recovery。
9. 状态投影必须区分 running producer、stale producer lineage、missing artifact、
   partial output 和 provider transient，不得合并成模糊 stop_until_fixed。
10. 测试必须固定真实失败形态，覆盖当前 running/failed producer 与旧 succeeded
    producer artifact 并存时的 resume、status-json 和 repair 行为。
