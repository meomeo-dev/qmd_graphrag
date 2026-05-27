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

OpenAI Responses completed payloads with `output=None` are also transient only
when the Python adapter emits typed evidence:

```text
Responses API transient error kind=responses_output_none status_code=unknown
```

This covers malformed completed Responses payloads where no stream text,
explicit error, refusal, content-filter signal, or incomplete reason is present.
The adapter must not expose the OpenAI SDK `response.output_text` property
failure as a raw Python `TypeError`; it must translate the provider boundary
anomaly before GraphRAG wraps the workflow error.

## Scope

This design is intentionally narrow.

- It only changes failure classification.
- It does not change GraphRAG stage execution, artifact gates, cleanup,
  query-ready projection, or output rendering.
- It does not treat all OpenAI messages as transient.
- It does not override provider HTTP 4xx permanent classification.
- It does not classify bare `NoneType`, `TypeError`, `not iterable`, or
  `extract_graph` failures as transient.
- It does not convert real empty output, refusal, content filter,
  `max_output_tokens`, schema parse failures, or local artifact gates into
  provider recovery.

## Invariants

- Explicit provider retry guidance is sufficient evidence for transient
  classification when no permanent status code is present.
- Data compatibility errors remain `data_compatibility`.
- Local artifact gate failures remain permanent unless an independent provider
  transient signal is present in the same failure text.
- Query-ready projection failures remain repairable local artifact gates.
- Status JSON hydration must be able to reclassify legacy `unknown` failures
  through the shared classifier.
- Responses `responses_output_none` recovery requires typed adapter evidence.
  A GraphRAG workflow wrapper may contain that typed message and still classify
  as transient; a bare GraphRAG `NoneType` summary remains `unknown`.

## Verification

The regression test must include a GraphRAG index workflow error containing
the OpenAI retry wording and assert `failureKind=transient` and
`retryable=true`.

The regression suite must also include `responses_output_none` positive and
negative cases: typed adapter evidence is transient, while bare `NoneType` and
local GraphRAG `TypeError` samples are not.
