# GraphRAG Parallel Runner Production Design Audit Criteria

These criteria are fixed for this audit series. Future review rounds must reuse
the same criterion identifiers and meanings so that status changes remain
comparable across revisions.

## C01. Single Coordinator Authority

The design must guarantee exactly one effective coordinator per `runId`. The
run lock must have durable identity, heartbeat, expiry, atomic acquisition, and
safe takeover rules. A stale coordinator must be unable to continue committing
shared state after losing authority.

## C02. Item Lease and Fencing Correctness

The design must guarantee that one `itemId` is owned by at most one live worker.
Item claim must be atomic, leases must carry fencing tokens, and every durable
item-state transition must validate current lease authority before commit.

## C03. Book-Scoped Writer Exclusivity

The design must guarantee that one `bookId` has at most one live writer even
when multiple queue items resolve to the same book. Book leases must be distinct
from item leases, and duplicate-book work must wait, skip, or requeue without
concurrent book-scoped mutation.

## C04. Serialized Durable Writes

The design must serialize all shared writes, including catalog files,
`.qmd/index.sqlite`, events, checkpoints, and manifests. The contract must define
which writer lane owns each path, how writes become atomic and durable, and how
lane ordering avoids partial or inconsistent state.

## C05. Provider and Local Resource Backpressure

The design must enforce global provider and local resource limits across all
workers. OpenAI, Jina, and local CPU work must use shared concurrency controls,
must avoid single-book starvation or monopoly, and must classify retryable versus
stop-until-fixed provider failures consistently.

## C06. GraphRAG Artifact Isolation and Lineage

The design must isolate GraphRAG work, output, reports, logs, and producer
records by book and stage. `query_ready` may only reference completed producer
runs for the same `bookId`, with lineage and artifact gates strong enough to
prevent cross-book or stale-run contamination.

## C07. Derived Manifest and Status Truth

The design must treat checkpoints and events as the source of truth for run
state. Manifest and status outputs must be derived from durable state, not from
unsynchronized worker memory, and must be fully rebuildable after process
restart.

## C08. Crash, Retry, and Resume Semantics

The design must define recovery behavior for worker crashes, coordinator
crashes, stale leases, transient provider failures, permanent provider failures,
and retry budget exhaustion. Recovery must preserve completed work, reject stale
writes, and allow safe re-entry without hidden in-memory assumptions.

## C09. Real Build Closure

The design must make real qmd and GraphRAG execution the default completion
path. A completed item must have qmd validation, GraphRAG stage gates, producer
lineage, artifact validation, and a successful book-level query capability
check. Dry-run, repair-only, or status-only modes must not synthesize completion.

## C10. Observability, Configuration, and Validation Coverage

The design must specify enough events, status fields, logs, configuration
precedence, secret handling, and tests to prove production behavior. Validation
must include sequential compatibility, true parallel progress, provider
backpressure, failure recovery, writer serialization, and real build evidence.
