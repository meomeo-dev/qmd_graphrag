# Dev Agent A Development Audit Baseline

## Scope

Audit the implementation for GraphRAG partial-output early stop, active-stage
watching, retry classification, and failed-attempt output isolation.

## Fixed Criteria

1. The watcher is enabled only for `graphrag_index` runtime calls that provide
   `stage`, `reportDir`, and `logStartOffset`; GraphRAG query, DSPy, qmd query,
   qmd search, and Jina paths must not start it.
2. The watcher scans only appended bytes from the captured offset in the
   current `reportDir/indexing-engine.log`; stale log history must not trigger
   early stop.
3. The partial-output patterns include `Community Report Extraction Error`,
   `error generating community report`, and `No report found for community`,
   and they require actionable warning/error-level log lines.
4. Early stop uses settle-once semantics: after detection the stored
   early-stop error wins, stdout is not parsed as success, and duplicate
   resolve/reject paths cannot race.
5. Termination targets only the current bridge child PID, uses bounded
   `SIGTERM` then `SIGKILL`, and does not use process-name matching,
   `killall`, or global process-group cleanup.
6. Watcher timers and handles are cleaned on success, child error, early-stop
   termination, and non-zero bridge exit; polling is bounded and not a busy
   loop.
7. The early-stop error begins with
   `GraphRAG stage report partial-output failure` and includes structured
   `stage`, `failureKind`, `logLocator`, offsets, and bounded evidence.
8. Evidence and locators are sanitized enough to avoid leaking absolute
   private paths, URL credentials, API keys, authorization tokens, provider
   payload bodies, or environment values.
9. The implementation includes fake long-running bridge tests proving current
   child termination and proving that pre-written valid stdout is not parsed
   after early stop.
10. Source and built execution share the same implementation path, and
    `npm run test:types` plus `npm run build` pass with the new signatures.
