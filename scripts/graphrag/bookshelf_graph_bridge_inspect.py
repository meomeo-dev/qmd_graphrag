from pathlib import Path
import re
from typing import Any

import pyarrow.parquet as pq

from bookshelf_graph_bridge_contracts import (
    ALLOWED_RELATION_TYPES,
    PARQUET_COLUMNS,
    hash_file,
    read_json,
)


FORBIDDEN_FIELD_NAMES = {
    "providerRequestPayload",
    "providerResponsePayload",
    "rawPrompt",
    "rawCompletion",
    "apiKey",
    "credential",
    "absoluteLocalPath",
    "queryLogContent",
}

SENSITIVE_TEXT_PATTERNS = [
    (
        "provider_payload",
        re.compile(
            r"\bprovider(?:Request|Response)?Payload\b|\bprovider payload\b",
            re.I,
        ),
    ),
    ("raw_prompt", re.compile(r"\brawPrompt\b|\braw prompt\b", re.I)),
    ("raw_completion", re.compile(r"\brawCompletion\b|\braw completion\b", re.I)),
    (
        "credential",
        re.compile(
            r"\b(apiKey|credential|clientSecret|secretKey|secretAccessKey)\b"
            r"\s*[:=]",
            re.I,
        ),
    ),
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b", re.I)),
    ("api_token", re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b", re.I)),
    ("query_log", re.compile(r"\bquery\.log\b", re.I)),
    (
        "absolute_path",
        re.compile(
            r"(?<![A-Za-z0-9_./-])"
            r"(?:/(?:Users|home|Volumes|private|tmp|var/folders)/[^\s\"']+|"
            r"[A-Za-z]:[\\/][^\s\"']+)",
            re.I,
        ),
    ),
]


def _allowed_relation_types(payload: dict[str, Any]) -> set[str]:
    configured = payload.get("allowedRelationTypes") or ALLOWED_RELATION_TYPES
    return {str(item) for item in configured}


def _iter_values(value: Any):
    if value is None:
        return
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _iter_values(item)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            yield from _iter_values(item)
        return
    yield str(value)


def _sensitive_reason(value: str) -> str | None:
    for reason, pattern in SENSITIVE_TEXT_PATTERNS:
        if pattern.search(value):
            return reason
    return None


def _sensitive_diagnostics(name: str, table: Any) -> list[str]:
    diagnostics: list[str] = []
    forbidden_lower = {field.lower() for field in FORBIDDEN_FIELD_NAMES}
    for column_name in table.column_names:
        if column_name.lower() in forbidden_lower:
            diagnostics.append(
                f"sensitive_payload_detected:{name}:{column_name}:field_name"
            )
            continue
        column_values = table.column(column_name).to_pylist()
        for row in column_values:
            reason = next(
                (
                    found
                    for found in (
                        _sensitive_reason(value)
                        for value in _iter_values(row)
                    )
                    if found is not None
                ),
                None,
            )
            if reason is not None:
                diagnostics.append(
                    f"sensitive_payload_detected:{name}:{column_name}:{reason}"
                )
                break
    return diagnostics


def _evidence_lineage_diagnostics(name: str, table: Any) -> list[str]:
    if name != "evidence_map.parquet":
        return []
    required_fields = [
        "targetBookId",
        "targetSourceId",
        "targetDocumentId",
        "targetContentHash",
        "targetCommunityReportId",
        "targetTextUnitId",
        "targetArtifactDigest",
    ]
    rows = table.to_pylist()
    diagnostics: list[str] = []
    for field in required_fields:
        for row in rows:
            text = str(row.get(field) or "")
            if not text:
                diagnostics.append(
                    f"invalid_evidence_lineage:{name}:{field}:missing"
                )
                break
            if text.startswith("unknown-"):
                diagnostics.append(
                    f"invalid_evidence_lineage:{name}:{field}:unknown"
                )
                break
    return diagnostics


def inspect(payload: dict[str, Any]) -> dict[str, Any]:
    output_root = Path(payload["outputRoot"])
    required = payload.get("requiredColumns") or PARQUET_COLUMNS
    allowed_relation_types = _allowed_relation_types(payload)
    artifacts: dict[str, dict[str, Any]] = {}
    ok = True
    diagnostics: list[str] = []
    for name, columns in required.items():
        path = output_root / name
        try:
            table = pq.read_table(path)
            actual = table.column_names
            missing = [column for column in columns if column not in actual]
            if missing:
                ok = False
                diagnostics.append(f"missing_columns:{name}:{','.join(missing)}")
            if table.num_rows <= 0:
                ok = False
                diagnostics.append(f"empty_parquet:{name}")
            if name == "semantic_edges.parquet" and "relationType" in actual:
                relation_values = set(
                    table.column("relationType").to_pylist()
                )
                disallowed = sorted(
                    str(value)
                    for value in relation_values
                    if str(value) not in allowed_relation_types
                )
                if disallowed:
                    ok = False
                    diagnostics.append(
                        "disallowed_relation_type:"
                        f"{name}:{','.join(disallowed)}"
                    )
            sensitive = _sensitive_diagnostics(name, table)
            if sensitive:
                ok = False
                diagnostics.extend(sensitive)
            lineage = _evidence_lineage_diagnostics(name, table)
            if lineage:
                ok = False
                diagnostics.extend(lineage)
            artifacts[name] = {
                "path": name,
                "rowCount": table.num_rows,
                "columns": actual,
                "sha256": hash_file(path),
                "bytes": path.stat().st_size,
            }
        except Exception as error:
            ok = False
            diagnostics.append(f"invalid_parquet:{name}:{type(error).__name__}")

    vector_manifest = output_root / "semantic_unit_embeddings.lance" / "INDEX_MANIFEST.json"
    if not vector_manifest.exists():
        ok = False
        diagnostics.append("missing_embedding_index_manifest")
    else:
        parsed = read_json(vector_manifest)
        artifacts["semantic_unit_embeddings.lance"] = {
            "path": "semantic_unit_embeddings.lance",
            "rowCount": parsed.get("rowCount", 0),
            "kind": parsed.get("indexKind"),
            "fingerprint": parsed.get("fingerprint"),
        }
    return {"ok": ok, "diagnostics": diagnostics, "artifacts": artifacts}
