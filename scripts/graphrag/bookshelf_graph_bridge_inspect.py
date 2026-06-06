from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from bookshelf_graph_bridge_contracts import (
    ALLOWED_RELATION_TYPES,
    PARQUET_COLUMNS,
    hash_file,
    read_json,
)


def _allowed_relation_types(payload: dict[str, Any]) -> set[str]:
    configured = payload.get("allowedRelationTypes") or ALLOWED_RELATION_TYPES
    return {str(item) for item in configured}


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
