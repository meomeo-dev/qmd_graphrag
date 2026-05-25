# 开发审计基准 B：GraphRAG 证据门控与投影恢复

caseId: graphrag-query-ready-recovery-reopen

## 审计范围

审计 repair-only 是否只修复本地 GraphRAG 产物、checkpoint、document identity
和 capability projection，不重跑高成本 GraphRAG 阶段、不发起真实 LLM 查询。
重点文件：

- `scripts/graphrag/resume-book-workspace.mjs`
- `src/job-state/graphrag-book.ts`
- `src/job-state/repository.ts`
- `src/graphrag/capability-catalog.ts`
- `test/cli.test.ts`

## 固定基准

1. repair-only 必须识别 `query_ready` document identity 缺失和
   `graphCapabilityId(s)` not-ready 作为本地投影门控失败。
2. repair-only 必须调用现有 `syncGraphRagBookWorkspace` 以重建
   qmd corpus registration、document identity 和 artifact manifests。
3. repair-only 不得调用 `runtime.graphIndex` 或任何高成本 GraphRAG stage
   workflow；不得重跑 `graph_extract`、`community_report`、`embed`。
4. repair-only 不得调用 `runtime.graphQuery`，避免把网络/LLM 波动混入本地
   projection repair 判定。
5. producer manifest 恢复必须以当前 bookId、sourceHash、documentId、
   contentHash、stageFingerprints、providerFingerprint 匹配为前置门控。
6. 恢复 stage checkpoint 时只能使用当前 content hash、stage fingerprint、
   provider fingerprint 和 corpus content hash 匹配的 artifacts。
7. `graph_extract`、`community_report`、`embed` producer run ids 必须复用已有
   manifest/checkpoint 证据，不能生成新的高成本 producer run id。
8. 若 `query_ready` checkpoint 缺失或 stale，repair-only 只能在三类 producer
   stages 全部 validated 后补齐 query_ready projection。
9. graph capability 可用性必须通过 `loadGraphQueryCapabilities` 派生/显式
   合并后的 ready capability 验证，不能只看旧 explicit catalog。
10. 对 mixed-book output、stale sidecar、source/content mismatch、missing
    producer lineage、incomplete artifacts 必须 fail closed。
