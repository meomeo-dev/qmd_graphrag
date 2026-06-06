from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow.parquet as pq

from bookshelf_graph_bridge_contracts import (
    clean_text,
    hash_file,
    read_json,
    stable_hash,
)


def read_rows(path: Path) -> list[dict[str, Any]]:
    table = pq.read_table(path)
    return table.to_pylist()


def first_text_unit(member: dict[str, Any], identity: dict[str, Any]) -> str:
    ids = identity.get("graphTextUnitIds")
    if isinstance(ids, list) and ids:
        return str(ids[0])
    try:
        rows = read_rows(Path(member["textUnitsPath"]))
    except Exception:
        rows = []
    if rows:
        return str(rows[0].get("id") or "")
    return ""


def source_identity(member: dict[str, Any]) -> dict[str, str]:
    identity = read_json(Path(member["identityPath"]))
    return {
        "sourceId": str(identity.get("sourceId") or f"sha256:{member['sourceHash']}"),
        "documentId": str(identity.get("documentId") or ""),
        "contentHash": str(identity.get("contentHash") or member.get("contentHash") or ""),
        "textUnitId": first_text_unit(member, identity),
    }


def write_parquet(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(rows, columns=columns)
    frame.to_parquet(path, index=False)


def build_embeddings(
    output_root: Path,
    units: list[dict[str, Any]],
    fingerprint: str,
) -> None:
    root = output_root / "semantic_unit_embeddings.lance"
    root.mkdir(parents=True, exist_ok=True)
    vectors = []
    for unit in units:
        seed = stable_hash({
            "semanticUnitId": unit["semanticUnitId"],
            "title": unit["title"],
            "summary": unit["summary"],
        })
        vector = [round(int(seed[index:index + 2], 16) / 255.0, 6)
                  for index in range(0, 32, 2)]
        vectors.append({
            "embeddingId": unit["embeddingId"],
            "semanticUnitId": unit["semanticUnitId"],
            "embedding": vector,
            "fingerprint": fingerprint,
        })
    pd.DataFrame(
        vectors,
        columns=["embeddingId", "semanticUnitId", "embedding", "fingerprint"],
    ).to_parquet(root / "vectors.parquet", index=False)
    (root / "INDEX_MANIFEST.json").write_text(
        clean_text_json({
            "schemaVersion": "1.0.0",
            "kind": "qmd_upper_semantic_unit_embedding_index",
            "indexKind": "deterministic_hash_vector_sidecar",
            "fingerprint": fingerprint,
            "rowCount": len(units),
            "vectorsPath": "vectors.parquet",
        }),
        "utf-8",
    )
    (root / "qmd_row_count.json").write_text(
        clean_text_json({"schemaVersion": "1.0.0", "rowCount": len(units)}),
        "utf-8",
    )


def clean_text_json(value: dict[str, Any]) -> str:
    import json

    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def add_evidence(
    evidence_rows: list[dict[str, Any]],
    *,
    evidence_id: str,
    owner_id: str,
    generation: str,
    upper_kind: str,
    upper_id: str,
    member: dict[str, Any],
    source: dict[str, str],
    report_id: str,
    text_unit_id: str,
    artifact_digest: str,
    rank: float,
) -> str:
    evidence_rows.append({
        "evidenceMapId": evidence_id,
        "ownerLevel": "bookshelf",
        "ownerId": owner_id,
        "upperArtifactKind": upper_kind,
        "upperArtifactId": upper_id,
        "targetLevel": "book",
        "targetBookId": member["bookId"],
        "targetBookshelfId": "",
        "targetSourceId": source["sourceId"],
        "targetDocumentId": source["documentId"],
        "targetContentHash": source["contentHash"],
        "targetCommunityReportId": report_id,
        "targetTextUnitId": text_unit_id,
        "targetArtifactDigest": artifact_digest,
        "rank": rank,
        "generation": generation,
    })
    return evidence_id


def artifact_digest(path: Path) -> str:
    return hash_file(path)
