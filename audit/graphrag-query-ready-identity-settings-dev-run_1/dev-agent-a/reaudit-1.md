Result: FAIL

## Findings

1. High: repair-only resume still does not recognize two observed local gate
   failure texts.

   `scripts/graphrag/batch-failure-classifier.mjs:165` to
   `scripts/graphrag/batch-failure-classifier.mjs:167` now classifies
   `GraphRAG document identity sidecar does not match query_ready` and
   `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`
   as local artifact gates for the outer batch runner. However,
   `scripts/graphrag/resume-book-workspace.mjs:225` to
   `scripts/graphrag/resume-book-workspace.mjs:253` maintains an independent
   `isLocalArtifactGateError()` list and still lacks both texts.

   The repair-only path depends on that local list before it can select the
   persisted failed stage checkpoint:
   `scripts/graphrag/resume-book-workspace.mjs:337` to
   `scripts/graphrag/resume-book-workspace.mjs:349` and
   `scripts/graphrag/resume-book-workspace.mjs:690` to
   `scripts/graphrag/resume-book-workspace.mjs:707`. For a real persisted
   stage checkpoint whose error is sidecar mismatch or managed settings
   projection failure, the batch runner can enter repair, but the repair
   subprocess returns `blocked` with `local artifact gate failure checkpoint not
   found`. That leaves the affected item pending/blocked instead of reopening
   it through the intended projection repair and normal CLI checks.

2. Medium: regression coverage still does not pin persisted repair for the two
   newly observed texts.

   `test/cli.test.ts:3944` to `test/cli.test.ts:3962` only parameterizes
   persisted query-ready reopen tests for missing document identity and missing
   graph capability. The sidecar mismatch text is only covered at
   `test/graphrag-book-state.test.ts:972` to `test/graphrag-book-state.test.ts:1046`
   as fail-closed workspace validation, not as batch repair/reopen behavior.
   The managed settings text is covered at `test/cli.test.ts:4477` to
   `test/cli.test.ts:4599` as fresh command failure observability, not as
   persisted `stop_until_fixed` repair-only recovery.

## Criteria Review

1. PASS. Stage ownership remains separated between `graph_extract`,
   `community_report`, `embed`, and `query_ready`.
2. PASS. `query_ready` validates producer run ids, fingerprints, provider
   fingerprint, corpus content hash, and book-scoped artifacts before
   completion.
3. FAIL. The successful repair path reopens to pending, but two observed
   persisted failure texts are still blocked inside the repair subprocess.
4. PASS. Producer run ids for high-cost stages are restored from checkpoints
   and producer manifests rather than rerunning those stages.
5. PASS. The intended repair surface is local projection state: managed
   settings, output producer manifest, checkpoints, document identity, and
   graph capability.
6. FAIL. The outer runtime classifier treats the new texts as local gates, but
   the repair-only runtime classifier does not.
7. PASS. Validation fails closed on source/content identity, document id,
   book id, normalized path, fingerprints, provider identity, and producer
   lineage mismatches.
8. PASS. Reopened items clear command checks and then require the normal CLI
   command-check set before completion.
9. PASS. Repair summaries now expose repair reason, projection, evidence
   locator, reused producer run ids, settings projection metadata, and
   `activeCommand` via top-level checkpoint/summary fields.
10. FAIL. Regression tests do not cover persisted repair/reopen for the
    sidecar mismatch and managed settings projection failure texts.

## Evidence

- `src/graphrag/settings-projection.ts:230` to
  `src/graphrag/settings-projection.ts:245` now routes public settings writers
  through guarded `ensureManagedGraphRagSettings()` paths.
- `src/graphrag/settings-projection.ts:315` to
  `src/graphrag/settings-projection.ts:359` allows creation or managed-marker
  rewrite and rejects user-owned settings.
- `src/job-state/graphrag-book.ts:798` to
  `src/job-state/graphrag-book.ts:827` rejects mismatched sidecars before
  adopting document identity.
- `src/job-state/graphrag-book.ts:1402` to
  `src/job-state/graphrag-book.ts:1505` enforces query-ready producer lineage
  and artifact gates.
- `src/job-state/graphrag-book.ts:1558` to
  `src/job-state/graphrag-book.ts:1573` repairs settings projection before
  stage fingerprints are derived.
- `scripts/graphrag/batch-epub-workflow.mjs:3619` to
  `scripts/graphrag/batch-epub-workflow.mjs:3777` reopens successful local
  gate repairs to pending and clears command checks.
- `scripts/graphrag/batch-epub-workflow.mjs:3815` to
  `scripts/graphrag/batch-epub-workflow.mjs:3851` defines the normal CLI check
  set required after repair.
- `scripts/graphrag/resume-book-workspace.mjs:225` to
  `scripts/graphrag/resume-book-workspace.mjs:253` is the remaining divergent
  classifier that lacks the two observed texts.

## Residual Risks

- 本次复审为静态审计，未运行测试，以遵守只写入本报告文件的限制。
- `resume-book-workspace.mjs` 与 `batch-failure-classifier.mjs` 仍有重复分类
  逻辑，后续容易再次漂移；建议共享同一 classifier。
- `activeCommand` 已作为顶层字段投影到 summary，但 repair metadata schema 仍会
  丢弃 `activeCommand` 候选字段；当前不阻断基准第 9 条，因为顶层字段已覆盖。
