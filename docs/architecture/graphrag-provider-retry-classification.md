# GraphRAG Provider Retry Classification

## Problem

GraphRAG index stages can fail after a provider-side OpenAI error whose text
explicitly says the request can be retried. If the batch failure classifier
does not recognize this wording, the item is stored as `unknown`,
`retryable=false`, and `recoveryDecision=stop_until_fixed`.

That behavior violates the batch recovery contract. The upstream error is an
external provider instability, not a data compatibility failure, local artifact
gate failure, or permanent project state error.

## Required Behavior

OpenAI provider messages that contain both of these facts must classify as
transient:

- The provider reports that an error occurred while processing the request.
- The provider explicitly says the request can be retried.

The classifier must return:

```json
{
  "failureKind": "transient",
  "retryable": true
}
```

The existing batch runner then maps the item to `retry_same_run_id` and keeps
the same status-management path used for other provider transient failures.

## Scope

This design is intentionally narrow.

- It only changes failure classification.
- It does not change GraphRAG stage execution, artifact gates, cleanup,
  query-ready projection, or output rendering.
- It does not treat all OpenAI messages as transient.
- It does not override provider HTTP 4xx permanent classification.

## Invariants

- Explicit provider retry guidance is sufficient evidence for transient
  classification when no permanent status code is present.
- Data compatibility errors remain `data_compatibility`.
- Local artifact gate failures remain permanent unless an independent provider
  transient signal is present in the same failure text.
- Query-ready projection failures remain repairable local artifact gates.
- Status JSON hydration must be able to reclassify legacy `unknown` failures
  through the shared classifier.

## Verification

The regression test must include a GraphRAG index workflow error containing
the OpenAI retry wording and assert `failureKind=transient` and
`retryable=true`.

