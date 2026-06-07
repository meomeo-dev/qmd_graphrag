from pathlib import Path
from typing import Any

from bookshelf_graph_bridge_contracts import (
    PARQUET_COLUMNS,
    as_rank,
    clean_text,
    stable_hash,
    tokens_for,
)
from bookshelf_graph_bridge_inspect import inspect
from bookshelf_graph_bridge_io import build_embeddings, read_rows, write_parquet


def _list_value(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item)]
    if value is None:
        return []
    return [str(value)] if str(value) else []


def _selected_reports(path: Path, max_reports: int) -> list[dict[str, Any]]:
    rows = read_rows(path)
    indexed = list(enumerate(rows))
    indexed.sort(
        key=lambda item: (as_rank(item[1].get("rank")), -item[0]),
        reverse=True,
    )
    return [row for _, row in indexed[:max_reports]]


def _evidence_by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("evidenceMapId")): row
        for row in rows
        if row.get("evidenceMapId") is not None
    }


def _evidence_for_report(
    report: dict[str, Any],
    evidence_rows: list[dict[str, Any]],
    by_id: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    evidence_ids = _list_value(report.get("evidenceMapIds"))
    for evidence_id in evidence_ids:
        if evidence_id in by_id:
            return by_id[evidence_id]
    report_id = str(report.get("id") or "")
    for row in evidence_rows:
        if str(row.get("upperArtifactId") or "") == report_id:
            return row
    return None


def _required_lower_lineage(
    lower: dict[str, Any] | None,
    *,
    report_id: str,
) -> dict[str, str]:
    if lower is None:
        raise ValueError(f"missing_lower_evidence:{report_id}")
    fields = {
        "targetBookId": lower.get("targetBookId"),
        "targetSourceId": lower.get("targetSourceId"),
        "targetDocumentId": lower.get("targetDocumentId"),
        "targetContentHash": lower.get("targetContentHash"),
        "targetCommunityReportId": lower.get("targetCommunityReportId"),
        "targetTextUnitId": lower.get("targetTextUnitId"),
        "targetArtifactDigest": lower.get("targetArtifactDigest"),
    }
    result: dict[str, str] = {}
    for field, value in fields.items():
        text = str(value or "")
        if not text or text.startswith("unknown-"):
            raise ValueError(f"invalid_lower_evidence:{report_id}:{field}")
        result[field] = text
    return result


def _add_library_evidence(
    evidence_rows: list[dict[str, Any]],
    *,
    evidence_id: str,
    library_id: str,
    generation: str,
    upper_kind: str,
    upper_id: str,
    bookshelf_id: str,
    lower: dict[str, Any],
    report_id: str,
    artifact_digest: str,
    rank: float,
) -> str:
    lineage = _required_lower_lineage(lower, report_id=report_id)
    evidence_rows.append({
        "evidenceMapId": evidence_id,
        "ownerLevel": "library",
        "ownerId": library_id,
        "upperArtifactKind": upper_kind,
        "upperArtifactId": upper_id,
        "targetLevel": "book",
        "targetBookId": lineage["targetBookId"],
        "targetBookshelfId": bookshelf_id,
        "targetSourceId": lineage["targetSourceId"],
        "targetDocumentId": lineage["targetDocumentId"],
        "targetContentHash": lineage["targetContentHash"],
        "targetCommunityReportId": lineage["targetCommunityReportId"],
        "targetTextUnitId": lineage["targetTextUnitId"],
        "targetArtifactDigest": lineage["targetArtifactDigest"],
        "rank": rank,
        "generation": generation,
    })
    return evidence_id


def append_semantic_units(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    library_id = payload["libraryId"]
    generation = payload["generation"]
    max_reports = int(payload.get("maxReportsPerShelf", 8))
    for member in payload["members"]:
        shelf_evidence_rows = read_rows(Path(member["evidenceMapPath"]))
        shelf_evidence_by_id = _evidence_by_id(shelf_evidence_rows)
        report_digest = member["artifactDigests"]["communityReports"]
        for report in _selected_reports(Path(member["communityReportsPath"]), max_reports):
            report_id = str(report.get("id") or stable_hash(report))
            title = clean_text(
                report.get("title"),
                f"{member['bookshelfId']} report {len(semantic_units) + 1}",
                240,
            )
            summary = clean_text(
                report.get("summary") or report.get("full_content"),
                title,
                1800,
            )
            unit_id = "lsu-" + stable_hash({
                "libraryId": library_id,
                "generation": generation,
                "bookshelfId": member["bookshelfId"],
                "reportId": report_id,
            })[:32]
            evidence_id = "lev-" + stable_hash({
                "unitId": unit_id,
                "reportId": report_id,
            })[:32]
            rank = as_rank(report.get("rank"))
            lower = _evidence_for_report(
                report,
                shelf_evidence_rows,
                shelf_evidence_by_id,
            )
            _add_library_evidence(
                evidence_rows,
                evidence_id=evidence_id,
                library_id=library_id,
                generation=generation,
                upper_kind="semantic_unit",
                upper_id=unit_id,
                bookshelf_id=member["bookshelfId"],
                lower=lower,
                report_id=report_id,
                artifact_digest=report_digest,
                rank=rank,
            )
            semantic_units.append({
                "semanticUnitId": unit_id,
                "level": "library",
                "ownerId": library_id,
                "sourceKind": "bookshelf_community_report",
                "sourceBookId": str(lower.get("targetBookId") or ""),
                "sourceBookshelfId": member["bookshelfId"],
                "sourceCommunityReportId": report_id,
                "title": title,
                "summary": summary,
                "rank": rank,
                "tokenEstimate": max(1, len((title + " " + summary).split())),
                "embeddingId": "emb-" + stable_hash(unit_id)[:32],
                "generation": generation,
                "evidenceMapIds": [evidence_id],
            })
            unit_meta[unit_id] = {
                "bookshelfId": member["bookshelfId"],
                "reportId": report_id,
                "artifactDigest": report_digest,
                "rank": rank,
                "tokens": tokens_for(title + " " + summary),
                "lower": lower,
            }


def limit_semantic_units(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    max_units = max(1, int(payload.get("maxSemanticUnits") or 32))
    selected = sorted(
        semantic_units,
        key=lambda item: (
            -float(item["rank"]),
            str(item["sourceBookshelfId"]),
            str(item["title"]),
            str(item["semanticUnitId"]),
        ),
    )[:max_units]
    selected_ids = {str(item["semanticUnitId"]) for item in selected}
    stale_ids = set(unit_meta.keys()).difference(selected_ids)
    for unit_id in stale_ids:
        unit_meta.pop(unit_id, None)
    evidence_rows[:] = [
        row for row in evidence_rows
        if (
            str(row.get("upperArtifactKind") or "") != "semantic_unit" or
            str(row.get("upperArtifactId") or "") in selected_ids
        )
    ]
    selected.sort(
        key=lambda item: (
            str(item["sourceBookshelfId"]),
            -float(item["rank"]),
            str(item["title"]),
            str(item["semanticUnitId"]),
        )
    )
    return selected


def build_edges(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    library_id = payload["libraryId"]
    generation = payload["generation"]
    max_edges = int(payload.get("maxEdges", 96))
    edges: list[dict[str, Any]] = []
    for left_index, left in enumerate(semantic_units):
        for right in semantic_units[left_index + 1:]:
            if len(edges) >= max_edges:
                break
            left_meta = unit_meta[left["semanticUnitId"]]
            right_meta = unit_meta[right["semanticUnitId"]]
            overlap = sorted(left_meta["tokens"].intersection(right_meta["tokens"]))[:8]
            same_shelf = left["sourceBookshelfId"] == right["sourceBookshelfId"]
            if not same_shelf and len(overlap) < 2:
                continue
            relation = "library_membership" if same_shelf else "co_clustered_topic"
            edge_id = "lse-" + stable_hash({
                "left": left["semanticUnitId"],
                "right": right["semanticUnitId"],
                "relation": relation,
            })[:32]
            evidence_id = "lev-" + stable_hash({"edgeId": edge_id})[:32]
            _add_library_evidence(
                evidence_rows,
                evidence_id=evidence_id,
                library_id=library_id,
                generation=generation,
                upper_kind="semantic_edge",
                upper_id=edge_id,
                bookshelf_id=left_meta["bookshelfId"],
                lower=left_meta["lower"],
                report_id=left_meta["reportId"],
                artifact_digest=left_meta["artifactDigest"],
                rank=(float(left["rank"]) + float(right["rank"])) / 2.0,
            )
            edges.append({
                "semanticEdgeId": edge_id,
                "level": "library",
                "ownerId": library_id,
                "sourceSemanticUnitId": left["semanticUnitId"],
                "targetSemanticUnitId": right["semanticUnitId"],
                "relationType": relation,
                "weight": 0.5 + min(len(overlap), 6) / 10.0,
                "direction": "undirected",
                "sourceEntityTitles": overlap,
                "sourceRelationshipIds": [],
                "evidenceMapIds": [evidence_id],
                "generation": generation,
            })
    return edges


def build_communities(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    communities: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    max_reports = max(1, int(payload.get("maxSemanticUnits") or 32))
    groups: dict[str, list[dict[str, Any]]] = {}
    for unit in semantic_units:
        groups.setdefault(unit["sourceBookshelfId"], []).append(unit)
    for index, member in enumerate(payload["members"]):
        group = groups.get(member["bookshelfId"], [])
        if not group:
            continue
        append_shelf_community(
            payload,
            member,
            group,
            index,
            communities,
            reports,
            evidence_rows,
            unit_meta,
        )
    if len(semantic_units) > 1 and len(reports) < max_reports:
        append_library_overview(
            payload,
            semantic_units,
            communities,
            reports,
            evidence_rows,
            unit_meta,
        )
    return communities, reports


def append_shelf_community(
    payload: dict[str, Any],
    member: dict[str, Any],
    group: list[dict[str, Any]],
    index: int,
    communities: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    library_id = payload["libraryId"]
    generation = payload["generation"]
    community_id = "lsc-" + stable_hash({
        "libraryId": library_id,
        "generation": generation,
        "bookshelfId": member["bookshelfId"],
    })[:32]
    report_id = "lsr-" + stable_hash({"communityId": community_id})[:32]
    top = group[0]
    top_meta = unit_meta[top["semanticUnitId"]]
    evidence_id = _add_library_evidence(
        evidence_rows,
        evidence_id="lev-" + stable_hash({"reportId": report_id})[:32],
        library_id=library_id,
        generation=generation,
        upper_kind="community_report",
        upper_id=report_id,
        bookshelf_id=member["bookshelfId"],
        lower=top_meta["lower"],
        report_id=top_meta["reportId"],
        artifact_digest=top_meta["artifactDigest"],
        rank=float(top["rank"]),
    )
    summary = " ".join([unit["summary"] for unit in group[:3]])
    communities.append({
        "id": community_id,
        "human_readable_id": index,
        "community": index,
        "level": 0,
        "parent": -1,
        "children": [],
        "title": f"{member['bookshelfId']} library cluster",
        "semanticUnitIds": [unit["semanticUnitId"] for unit in group],
        "generation": generation,
    })
    reports.append({
        "id": report_id,
        "human_readable_id": index,
        "community": index,
        "level": 0,
        "parent": -1,
        "children": [],
        "title": f"{member['bookshelfId']} library report",
        "summary": clean_text(summary, group[0]["title"], 2200),
        "full_content": clean_text(summary, group[0]["summary"], 3600),
        "rank": max(float(unit["rank"]) for unit in group),
        "findings": [{
            "summary": unit["title"],
            "explanation": unit["summary"][:600],
        } for unit in group[:6]],
        "evidenceMapIds": [evidence_id],
        "generation": generation,
    })


def append_library_overview(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    communities: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    library_id = payload["libraryId"]
    generation = payload["generation"]
    community_id = "lsc-" + stable_hash({
        "libraryId": library_id,
        "generation": generation,
        "kind": "overview",
    })[:32]
    report_id = "lsr-" + stable_hash({"communityId": community_id})[:32]
    evidence_ids = []
    for unit in semantic_units[: min(8, len(semantic_units))]:
        meta = unit_meta[unit["semanticUnitId"]]
        evidence_ids.append(_add_library_evidence(
            evidence_rows,
            evidence_id="lev-" + stable_hash({
                "reportId": report_id,
                "unitId": unit["semanticUnitId"],
            })[:32],
            library_id=library_id,
            generation=generation,
            upper_kind="community_report",
            upper_id=report_id,
            bookshelf_id=meta["bookshelfId"],
            lower=meta["lower"],
            report_id=meta["reportId"],
            artifact_digest=meta["artifactDigest"],
            rank=float(unit["rank"]),
        ))
    summary = " ".join([unit["summary"] for unit in semantic_units[:6]])
    communities.append({
        "id": community_id,
        "human_readable_id": len(communities),
        "community": len(communities),
        "level": 1,
        "parent": -1,
        "children": list(range(0, max(0, len(communities)))),
        "title": f"{library_id} overview",
        "semanticUnitIds": [unit["semanticUnitId"] for unit in semantic_units[:16]],
        "generation": generation,
    })
    reports.append({
        "id": report_id,
        "human_readable_id": len(reports),
        "community": len(reports),
        "level": 1,
        "parent": -1,
        "children": list(range(0, max(0, len(reports)))),
        "title": f"{library_id} overview report",
        "summary": clean_text(summary, f"{library_id} overview", 2400),
        "full_content": clean_text(summary, f"{library_id} overview", 4200),
        "rank": max(float(unit["rank"]) for unit in semantic_units),
        "findings": [{
            "summary": unit["title"],
            "explanation": unit["summary"][:600],
        } for unit in semantic_units[:8]],
        "evidenceMapIds": evidence_ids,
        "generation": generation,
    })


def build_library(payload: dict[str, Any]) -> dict[str, Any]:
    output_root = Path(payload["outputRoot"])
    output_root.mkdir(parents=True, exist_ok=True)
    semantic_units: list[dict[str, Any]] = []
    evidence_rows: list[dict[str, Any]] = []
    unit_meta: dict[str, dict[str, Any]] = {}
    try:
        append_semantic_units(payload, semantic_units, evidence_rows, unit_meta)
        semantic_units = limit_semantic_units(
            payload,
            semantic_units,
            evidence_rows,
            unit_meta,
        )
        edges = build_edges(payload, semantic_units, evidence_rows, unit_meta)
        communities, reports = build_communities(
            payload,
            semantic_units,
            evidence_rows,
            unit_meta,
        )
    except ValueError as error:
        return {
            "ok": False,
            "diagnostics": [str(error)],
            "artifacts": {},
        }
    for name, rows in [
        ("semantic_units.parquet", semantic_units),
        ("semantic_edges.parquet", edges),
        ("communities.parquet", communities),
        ("community_reports.parquet", reports),
        ("evidence_map.parquet", evidence_rows),
    ]:
        write_parquet(output_root / name, rows, PARQUET_COLUMNS[name])
    build_embeddings(output_root, semantic_units, payload["embeddingFingerprint"])
    return inspect({"outputRoot": str(output_root), "requiredColumns": PARQUET_COLUMNS})
