# GraphRAG Parallel Runner Implementation Audit Criteria

1. Single coordinator ownership is durable.
   The run must persist a coordinator lock with runner session, process identity,
   heartbeat, expiry, and takeover rules. A second coordinator must not claim
   work before expiry and liveness reconciliation.

2. Item and book ownership use lease fencing.
   Every item and book-scoped writer must hold a durable lease with worker id,
   heartbeat, expiry, generation, and fencing token. All checkpoint, event,
   catalog, manifest, qmd index, and book artifact commits must verify the
   current fencing token.

3. Provider concurrency is enforced at the child-process boundary.
   Provider-using qmd and GraphRAG subprocesses must be started only after a
   coordinator-granted provider slot lease is recorded. Slot acquisition,
   release, generation, wait time, and recovery from leaked slots must be
   observable in events and status output.

4. Durable writes are crash recoverable.
   Checkpoint, manifest, catalog, lock, and book state writes must use same-dir
   temp files, file fsync, atomic rename, parent fsync, and generation or checksum
   validation. Leftover temp files and invalid targets must be reconciled on
   restart.

5. Event logs are authoritative audit trails.
   Each event line must contain stable event id and sequence fields, be appended
   atomically with newline and flush/fsync, and recover partial tails and duplicate
   ids deterministically.

6. Manifest and status are derived caches.
   completed, pending, running, skipped, and failed counts must be recomputed from
   durable checkpoints plus reconciled event evidence. Manifest mismatches must be
   rebuilt instead of trusted.

7. Terminal completion is evidence gated.
   A completed item must require qmd validation checks, GraphRAG stage gates,
   producer lineage, query_ready evidence, and current item/book/provider leases
   before the completed checkpoint and item_completed event are persisted.

8. Failure classification leads to stable terminal or retry states.
   Provider auth and other non-transient failures must persist stop_until_fixed.
   Transient provider failures must persist nextRetryAt, retry budget, and
   recovery decision; exhausted retry budgets must reach a deterministic excluded
   state instead of cycling as runnable pending work.

9. Crash and restart recovery handles live subprocess risk.
   Restart must detect expired running work, scan or record subprocess registry
   state, cancel or quarantine orphan process groups, and prevent stale workers
   from committing after takeover.

10. Tests exercise state and recovery behavior, not only token presence.
    Tests must cover concurrent claims, duplicate book ids, provider slot limits,
    status count derivation, manifest mismatch rebuild, partial JSONL recovery,
    stale worker commit rejection, SQLite busy handling, retry exhaustion, and
    coordinator crash/restart sequences.
