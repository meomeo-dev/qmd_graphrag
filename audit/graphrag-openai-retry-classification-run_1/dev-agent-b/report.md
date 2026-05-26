# OpenAI Retry-Guidance Failure Classification Audit

## Conclusion

Pass.

The patch satisfies all 10 fixed baseline criteria. The change is narrow: it
adds one provider retry-guidance phrase to the shared failure classifier,
adds a direct classifier regression test, and documents the intended recovery
contract. No mandatory fixes are required.

## Criteria Results

1. Pass. The observed OpenAI wording is now classified as `transient` with
   `retryable=true`, so it does not remain `unknown`.
2. Pass. Existing tested batch expectations still derive retryable transient
   failures through `retry_same_run_id`.
3. Pass. No separate recovery ledger or alternate state source is introduced.
4. Pass. The classifier remains a pure string-to-result function with no side
   effects or nondeterministic inputs.
5. Pass. Numeric provider status code checks still run before textual
   provider-transient matching, preserving 4xx permanent and 429/5xx transient
   precedence.
6. Pass. The regression test calls `classifyFailure` directly and does not
   depend on live provider calls.
7. Pass. The added matching phrase requires the specific processing-error and
   retry-guidance wording. It does not classify arbitrary help-center text or
   request-ID text by itself.
8. Pass. Existing partial-output and network transient tokens remain present
   and covered by direct classifier assertions.
9. Pass. Existing local artifact gate classification remains permanent when
   no independent provider-transient signal is present.
10. Pass. The code remains small and localized; future provider phrases can be
    added in the classifier token list without touching unrelated runtime
    paths.

## Evidence

- `scripts/graphrag/batch-failure-classifier.mjs`: status code classification
  precedes text matching; the new provider retry-guidance phrase is confined to
  the provider transient token list.
- `test/cli.test.ts`: the new regression test exercises `classifyFailure`
  directly with GraphRAG workflow text containing the OpenAI retry wording.
- `test/cli.test.ts`: existing assertions still cover 4xx permanence, 429/5xx
  transience, partial-output, network transients, and local artifact gates.
- `docs/architecture/graphrag-provider-retry-classification.md`: the documented
  scope is narrow and preserves status-code precedence and non-provider failure
  behavior.

## Required Fixes

None.
