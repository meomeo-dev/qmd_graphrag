# GraphRAG Settings Projection Re-Audit 2 - Agent C

Result: FAIL

## Finding

### High: invalid source config typing remains heuristic and incomplete

`scripts/graphrag/batch-epub-workflow.mjs:803` still derives settings projection
rejection metadata from a small set of error-text substrings. It recognizes
`managed projection`, `responses api`, `graphrag.concurrent_requests`, and
`failed to parse`, but it does not type every projection-writer invalid source
failure as `rejected_invalid_source`.

One concrete invalid source case is an unsupported Jina embedding profile in
`.qmd/index.yml`. `src/graphrag/settings-projection.ts:88` reads
`providers.jina.embedding_profile`, `src/graphrag/settings-projection.ts:89`
indexes `JINA_EMBEDDING_PROFILES`, and later projection construction dereferences
the profile fields. With an unrecognized profile value, the actual projection
writer error is `Cannot read properties of undefined (reading 'queryTask')`.
That text is not matched by `settingsProjectionRejectionMetadataFromText`, so
the batch runner records an ordinary command failure with no
`settingsProjectionDecision: rejected_invalid_source`, no settings projection
locators, and no settings projection reason.

Actual YAML parse failures are now classified through the `failed to parse`
substring, but `scripts/graphrag/batch-epub-workflow.mjs:774` computes the
source fingerprint by reparsing the same YAML and returns `undefined` on parse
failure. Because the metadata object is passed through `withoutUndefined`, the
`settingsProjectionSourceFingerprint` field is omitted for syntactically invalid
`.qmd/index.yml` even though the required rejection observability surface lists
that field.

The new regression at `test/cli.test.ts:4682` covers only a fake stderr path for
an OpenAI endpoint validation message wrapped as `Failed to parse ...`. It does
not execute the real resume/config/projection path and does not cover other
invalid source values such as an unsupported Jina profile. Review focus items 1,
2, and 4 therefore remain partially failed for invalid-source rejection
observability and test coverage.

## Verified Fixed

- `scripts/graphrag/batch-epub-workflow.mjs:147` now allows settings projection
  fields in repair metadata, preventing schema parsing from stripping them.
- `scripts/graphrag/batch-epub-workflow.mjs:3692` merges persisted repair
  settings projection metadata into reopened checkpoint metadata.
- `scripts/graphrag/batch-epub-workflow.mjs:3813` emits the reopened repair
  event with the same repair metadata, and
  `scripts/graphrag/batch-epub-workflow.mjs:2996` projects it into recovery
  summary items.
- `scripts/graphrag/batch-epub-workflow.mjs:4749` adds `activeCommand` to the
  final `item_failed` event metadata for non-provider command failures.
- `src/graphrag/settings-projection.ts:230` and
  `src/graphrag/settings-projection.ts:239` route both async and sync public
  writers through the guarded ensure functions; the fail-closed behavior is
  implemented at `src/graphrag/settings-projection.ts:348` and
  `src/graphrag/settings-projection.ts:395`.
- `test/graphrag-book-state.test.ts:1993` covers async writer rejection of
  user-owned settings, and `test/graphrag-book-state.test.ts:2011` now covers
  the sync writer rejection.
- `test/cli.test.ts:4535` checks user-owned rejection metadata in checkpoint,
  events, and summary, including `activeCommand` and source fingerprint.
- `test/cli.test.ts:4000` and `test/cli.test.ts:4195` cover persisted repair
  metadata projection into checkpoint and recovery summary.

## Residual Risk

This review was limited to the fixed baseline and the `dev-agent-c/reaudit-1.md`
findings. I did not run the test suite because the task allows writing only this
report file, while the focused tests create temporary files under `.tmp-tests/`.
I used static review plus one read-only projection-construction check to confirm
the unsupported Jina profile error text.
