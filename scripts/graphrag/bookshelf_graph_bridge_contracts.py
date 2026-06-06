import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


STOPWORDS = {
    "about",
    "after",
    "also",
    "and",
    "book",
    "books",
    "from",
    "into",
    "that",
    "the",
    "their",
    "this",
    "through",
    "with",
}

PARQUET_COLUMNS = {
    "semantic_units.parquet": [
        "semanticUnitId",
        "level",
        "ownerId",
        "sourceKind",
        "sourceBookId",
        "sourceBookshelfId",
        "sourceCommunityReportId",
        "title",
        "summary",
        "rank",
        "tokenEstimate",
        "embeddingId",
        "generation",
        "evidenceMapIds",
    ],
    "semantic_edges.parquet": [
        "semanticEdgeId",
        "level",
        "ownerId",
        "sourceSemanticUnitId",
        "targetSemanticUnitId",
        "relationType",
        "weight",
        "direction",
        "sourceEntityTitles",
        "sourceRelationshipIds",
        "evidenceMapIds",
        "generation",
    ],
    "communities.parquet": [
        "id",
        "human_readable_id",
        "community",
        "level",
        "parent",
        "children",
        "title",
        "semanticUnitIds",
        "generation",
    ],
    "community_reports.parquet": [
        "id",
        "human_readable_id",
        "community",
        "level",
        "parent",
        "children",
        "title",
        "summary",
        "full_content",
        "rank",
        "findings",
        "evidenceMapIds",
        "generation",
    ],
    "evidence_map.parquet": [
        "evidenceMapId",
        "ownerLevel",
        "ownerId",
        "upperArtifactKind",
        "upperArtifactId",
        "targetLevel",
        "targetBookId",
        "targetBookshelfId",
        "targetSourceId",
        "targetDocumentId",
        "targetContentHash",
        "targetCommunityReportId",
        "targetTextUnitId",
        "targetArtifactDigest",
        "rank",
        "generation",
    ],
}

ALLOWED_RELATION_TYPES = [
    "shared_entity",
    "source_relationship",
    "co_clustered_topic",
    "parent_child_community",
    "bookshelf_membership",
    "library_membership",
]


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}


def clean_text(value: Any, fallback: str, limit: int) -> str:
    if value is None:
        text = fallback
    elif isinstance(value, float) and math.isnan(value):
        text = fallback
    else:
        text = str(value)
    text = re.sub(r"\s+", " ", text).strip()
    return (text or fallback)[:limit]


def as_rank(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except Exception:
        return 0.0


def tokens_for(value: str) -> set[str]:
    return {
        item
        for item in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", value.lower())
        if item not in STOPWORDS
    }
