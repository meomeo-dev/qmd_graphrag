# GraphRAG Parallel Runner Production Design Findings

Audit target:
`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

## C01. Single Coordinator Authority

Status: WARN

The design states a single coordinator per `runId`, records lock identity and
heartbeat fields, rejects unexpired locks, and only allows recovery after
coordinator heartbeat failure. It also lists multiple writers for the same
`runId` as unsupported.

Evidence:

- `productionContract.runnerTopology.coordinator.processCountPerRunId: 1`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:27-33`).
- Unsupported topology forbids multiple `batch-epub-workflow` writers for the
  same `runId` (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:45-48`).
- `single_coordinator_per_run` requires run-lock identity, heartbeat, expiry,
  and takeover only for expired locks without a live process
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:50-57`).
- Coordinator crash recovery waits for lock expiry and rebuilds from durable
  state (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:267-271`).

Concern:

The design does not name the atomic lock primitive or persistence backend
required to acquire, refresh, and transfer the run lock. The rule is clear, but
production readers still need an explicit atomic-create, compare-and-swap, or
equivalent contract so two coordinators cannot both observe a takeover window.

Required change level: should fix.

## C02. Item Lease and Fencing Correctness

Status: WARN

The design gives item leases the right fields and requires atomic claim plus
fencing checks before checkpoint writes.

Evidence:

- `one_item_one_worker` requires `runnerSessionId`, `workerId`,
  `fencingToken`, heartbeat, expiry, atomic compare-and-swap claim, and
  checkpoint fencing validation
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:58-64`).
- The scheduler excludes `running_with_live_lease` from claim eligibility
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:167-179`).
- Worker heartbeat and completion sequencing require lease freshness and
  durable final state before release
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:180-192`).

Concern:

Fencing is explicitly attached to checkpoint writes, but the document also
requires stale workers to stop all persistent writes. Catalog updates, qmd index
writes, event writes, and book-scoped artifact commits should be covered by the
same fencing rule or by a named coordinator-mediated commit protocol.

Required change level: should fix.

## C03. Book-Scoped Writer Exclusivity

Status: PASS

The design directly covers duplicate-book contention and prevents two workers
from mutating the same book-scoped outputs.

Evidence:

- `one_book_one_writer` states that a `bookId` can have only one worker writing
  book-scoped artifacts and requires a book lease independent from the item
  lease (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:65-70`).
- The scheduler leaves duplicate-book candidates queued while another live
  worker owns the book lease
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:177-179`).
- Acceptance criteria require no duplicate live worker or live GraphRAG
  producer for the same book
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:361-365`).

Residual risk:

The criterion is satisfied at the design level. Implementation must still prove
that `bookId` derivation is deterministic before lease acquisition.

## C04. Serialized Durable Writes

Status: FAIL

The design identifies the correct shared-write surfaces and requires serialized
global writes, but the lane contract is internally inconsistent and does not
fully define atomic durable write behavior.

Evidence:

- `serialized_global_writes` requires `catalogWriterLane`,
  `qmdIndexWriterLane`, `eventWriterLane`, and `manifestWriterLane`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:78-84`).
- `resourceControls.writerLanes` defines `catalogWriterLane`,
  `qmdIndexWriterLane`, `eventWriterLane`, and `checkpointWriterLane`, but not
  `manifestWriterLane`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:133-157`).
- `catalogWriterLane` also lists
  `graph_vault/catalog/batch-runs/**/manifest.json` as protected
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:134-142`), which
  conflicts with the separate `manifestWriterLane` named in the invariant.
- Completion requires final checkpoint, `item_completed` event, and manifest
  refresh to be durable before lease release
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:187-189`).

Concern:

The manifest ownership mismatch can produce two incompatible implementations:
one where catalog writes own the manifest and another where a separate manifest
lane owns it. The design also does not specify atomic file replacement,
`fsync`/durability expectations, event append framing, or whether lane ordering
is checkpoint-before-event-before-manifest for all terminal transitions.

Required change level: must fix.

## C05. Provider and Local Resource Backpressure

Status: PASS

The design establishes global semaphores for OpenAI and Jina, separates local
CPU capacity, requires provider-specific retry classification, and explicitly
requires other books to keep progressing while one provider is blocked.

Evidence:

- OpenAI requests across all workers share one semaphore and classify 429, 5xx,
  timeout, Responses output-none, and network interruption through one recovery
  path (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:99-113`).
- Jina requests across all workers share one semaphore, and a single book must
  not monopolize all Jina capacity
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:113-123`).
- Local CPU concurrency has a separate limit for extraction, parquet
  validation, LanceDB, and local scans
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:124-132`).
- Integration validation requires progress under OpenAI waits, Jina waits, and
  transient provider failures
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:347-355`).

Residual risk:

The criterion is satisfied at the design level. Implementation must ensure that
subprocess-based qmd and GraphRAG calls acquire the same semaphores, not only
in-process API clients.

## C06. GraphRAG Artifact Isolation and Lineage

Status: PASS

The design strongly separates book-scoped GraphRAG outputs and ties query
readiness to same-book producer lineage and artifact validation.

Evidence:

- Scope includes book-scoped GraphRAG isolation and excludes shared
  `graph_vault/output` as a production output directory
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:17-25`).
- `graph_artifact_isolation` requires independent work, output, and report
  directories, unique stage run IDs, and same-book completed producer runs for
  `query_ready`
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:71-77`).
- Stage evidence requires producer records, parquet validation, same-book
  lineage, vector validation, capability projection, and successful qmd
  GraphRAG query
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:208-227`).
- Artifact repair cannot accept missing producer lineage and may reuse artifacts
  only with matching fingerprints, run records, and required parquet files
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:254-260`).

Residual risk:

The criterion is satisfied at the design level. Implementation should retain
producer run IDs in every status and event record that affects `query_ready`.

## C07. Derived Manifest and Status Truth

Status: PASS

The design makes durable checkpoints and events authoritative for the run
manifest and restart status.

Evidence:

- `derived_run_manifest` states that completed, pending, running, failed, and
  skipped counts are not authoritative in worker memory
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:85-90`).
- The coordinator responsibility includes manifest derivation and recovery
  strategy (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:27-33`).
- Coordinator crash recovery scans checkpoints and events to rebuild the
  manifest (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:267-271`).
- Acceptance criteria require restart recovery without relying on interrupted
  in-memory counters
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:368-369`).

Residual risk:

The criterion is satisfied at the design level. The lane ownership issue in C04
must still be corrected so derived manifests have one durable writer contract.

## C08. Crash, Retry, and Resume Semantics

Status: FAIL

The design covers the main recovery states, but it is incomplete for production
crash safety because it does not define how in-flight external commands are
cancelled, fenced, or quarantined after worker or coordinator loss.

Evidence:

- Transient provider failures become retryable, record `nextRetryAt`, release
  leases after durable state, and allow other books to progress
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:229-242`).
- Permanent provider failures become `failed_stop_until_fixed`, stop the
  coordinator after a durable event, and preserve recoverable state
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:243-253`).
- Worker crash recovery waits for lease expiry, makes stale running items
  claimable, and rejects stale worker writes through fencing tokens
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:261-266`).
- Coordinator crash recovery waits for run-lock expiry and rebuilds from disk
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:267-271`).

Concern:

The runner invokes qmd and GraphRAG subcommands, which can continue mutating
book-scoped directories or `.qmd/index.sqlite` after a worker task, process
group, or coordinator fails unless the design defines cancellation, process
group ownership, artifact quarantine, and commit-time fencing. Retry budget
exhaustion is also recorded but not mapped to a terminal state. These gaps
affect the core production recovery invariant, not only observability.

Required change level: must fix.

## C09. Real Build Closure

Status: PASS

The design rejects simulated completion and requires real qmd, GraphRAG,
artifact, lineage, and query evidence before an item can be completed.

Evidence:

- Scope excludes bypassing qmd or GraphRAG real builds through simulated
  completion (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:21-25`).
- `real_build_by_default` requires full qmd and GraphRAG execution, qmd
  validation records, stage gates, producer lineage, `query_ready`, and no
  completion from missing artifacts outside explicit non-build modes
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:91-97`).
- `completed` state requires qmd, GraphRAG, `query_ready`, and all validation
  subcommands (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:194-201`).
- Production dry-run cannot be used as completed evidence
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:356-359`).

Residual risk:

The criterion is satisfied at the design level. Acceptance should later be
backed by at least one real multi-book build transcript or machine-readable run
record.

## C10. Observability, Configuration, and Validation Coverage

Status: WARN

The design has a strong observability and validation skeleton, including event
names, status JSON fields, log requirements, secret handling, CLI options, and
unit/integration/production dry-run expectations.

Evidence:

- Required events cover coordinator, worker, command, retry, lease, manifest,
  incomplete, and complete lifecycle events
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:273-290`).
- Status fields expose coordinator, concurrency, item counts, retries, active
  workers, and active provider slots
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:291-305`).
- Logs must be per-book and retain GraphRAG provider logs while status JSON
  avoids secrets (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:306-309`).
- CLI, dotenv precedence, secret handling, unit tests, integration tests, and
  real-build validation requirements are specified
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:311-359`).

Concern:

The validation matrix does not explicitly require crash or orphan-subprocess
tests for the C08 failure modes, nor does it require a real two-book production
acceptance run that demonstrates simultaneous running items and completed qmd
plus GraphRAG closure from durable evidence.

Required change level: should fix.
