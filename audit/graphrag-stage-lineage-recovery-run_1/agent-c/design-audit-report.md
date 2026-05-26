# Design Audit Report

Result: failed

## Summary

The core recovery direction is sound, but the design must explicitly define all
readiness dimensions, manifest lineage repair, query-ready gating, fail-closed
invalid artifact handling, and resumePlan observability.

## Required Tests

- Artifact id refresh recovery without rerunning high-cost stages.
- Running and failed newer attempts do not shadow older succeeded runs.
- Successful newer run supersedes only after full readiness validation.
- Wrong producer, fingerprint, provider, corpus hash, book scope, empty file,
  and corrupt artifact all fail closed.
- Manifest repair keeps all per-stage producer run ids.
- Query-ready remains blocked when embed is missing.
