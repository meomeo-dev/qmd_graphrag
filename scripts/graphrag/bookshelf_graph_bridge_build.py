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
from bookshelf_graph_bridge_io import (
    add_evidence,
    build_embeddings,
    read_rows,
    source_identity,
    write_parquet,
)


def selected_reports(path: Path, max_reports: int) -> list[dict[str, Any]]:
    rows = read_rows(path)
    indexed = list(enumerate(rows))
    indexed.sort(key=lambda item: (as_rank(item[1].get("rank")), -item[0]), reverse=True)
    return [row for _, row in indexed[:max_reports]]


def append_semantic_units(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    bookshelf_id = payload["bookshelfId"]
    generation = payload["generation"]
    max_reports = int(payload.get("maxReportsPerBook", 8))
    for member in payload["members"]:
        source = source_identity(member)
        report_digest = member["artifactDigests"]["communityReports"]
        for report in selected_reports(Path(member["communityReportsPath"]), max_reports):
            report_id = str(report.get("id") or stable_hash(report))
            title = clean_text(
                report.get("title"),
                f"{member['title']} community {len(semantic_units) + 1}",
                240,
            )
            summary = clean_text(
                report.get("summary") or report.get("full_content"),
                title,
                1800,
            )
            unit_id = "bsu-" + stable_hash({
                "bookshelfId": bookshelf_id,
                "generation": generation,
                "bookId": member["bookId"],
                "reportId": report_id,
            })[:32]
            evidence_id = "ev-" + stable_hash({"unitId": unit_id, "reportId": report_id})[:32]
            rank = as_rank(report.get("rank"))
            embedding_id = "emb-" + stable_hash(unit_id)[:32]
            add_evidence(
                evidence_rows,
                evidence_id=evidence_id,
                owner_id=bookshelf_id,
                generation=generation,
                upper_kind="semantic_unit",
                upper_id=unit_id,
                member=member,
                source=source,
                report_id=report_id,
                text_unit_id=source["textUnitId"],
                artifact_digest=report_digest,
                rank=rank,
            )
            semantic_units.append({
                "semanticUnitId": unit_id,
                "level": "bookshelf",
                "ownerId": bookshelf_id,
                "sourceKind": "book_community_report",
                "sourceBookId": member["bookId"],
                "sourceBookshelfId": "",
                "sourceCommunityReportId": report_id,
                "title": title,
                "summary": summary,
                "rank": rank,
                "tokenEstimate": max(1, len((title + " " + summary).split())),
                "embeddingId": embedding_id,
                "generation": generation,
                "evidenceMapIds": [evidence_id],
            })
            unit_meta[unit_id] = {
                "member": member,
                "source": source,
                "reportId": report_id,
                "artifactDigest": report_digest,
                "tokens": tokens_for(title + " " + summary),
                "rank": rank,
                "textUnitId": source["textUnitId"],
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
            str(item["sourceBookId"]),
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
            str(item["sourceBookId"]),
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
    edges: list[dict[str, Any]] = []
    max_edges = int(payload.get("maxEdges", 96))
    bookshelf_id = payload["bookshelfId"]
    generation = payload["generation"]
    for left_index, left in enumerate(semantic_units):
        for right in semantic_units[left_index + 1:]:
            if len(edges) >= max_edges:
                break
            left_meta = unit_meta[left["semanticUnitId"]]
            right_meta = unit_meta[right["semanticUnitId"]]
            overlap = sorted(left_meta["tokens"].intersection(right_meta["tokens"]))[:8]
            same_book = left["sourceBookId"] == right["sourceBookId"]
            if not same_book and len(overlap) < 2:
                continue
            relation = "bookshelf_membership" if same_book else "co_clustered_topic"
            edge_id = "bse-" + stable_hash({
                "left": left["semanticUnitId"],
                "right": right["semanticUnitId"],
                "relation": relation,
            })[:32]
            evidence_id = "ev-" + stable_hash({"edgeId": edge_id})[:32]
            add_evidence(
                evidence_rows,
                evidence_id=evidence_id,
                owner_id=bookshelf_id,
                generation=generation,
                upper_kind="semantic_edge",
                upper_id=edge_id,
                member=left_meta["member"],
                source=left_meta["source"],
                report_id=left_meta["reportId"],
                text_unit_id=left_meta["textUnitId"],
                artifact_digest=left_meta["artifactDigest"],
                rank=(float(left["rank"]) + float(right["rank"])) / 2.0,
            )
            edges.append({
                "semanticEdgeId": edge_id,
                "level": "bookshelf",
                "ownerId": bookshelf_id,
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
    unit_groups: dict[str, list[dict[str, Any]]] = {}
    for unit in semantic_units:
        unit_groups.setdefault(unit["sourceBookId"], []).append(unit)
    for index, member in enumerate(payload["members"]):
        group = unit_groups.get(member["bookId"], [])
        if not group:
            continue
        append_member_community(
            payload, member, group, index, communities, reports, evidence_rows, unit_meta
        )
    if len(semantic_units) > 1:
        append_overview_community(
            payload, semantic_units, communities, reports, evidence_rows, unit_meta
        )
    return communities, reports


def append_member_community(
    payload: dict[str, Any],
    member: dict[str, Any],
    group: list[dict[str, Any]],
    index: int,
    communities: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    generation = payload["generation"]
    community_id = "bsc-" + stable_hash({
        "bookshelfId": payload["bookshelfId"],
        "generation": generation,
        "bookId": member["bookId"],
    })[:32]
    report_id = "bsr-" + stable_hash({"communityId": community_id})[:32]
    top = group[0]
    top_meta = unit_meta[top["semanticUnitId"]]
    evidence_ids = [add_evidence(
        evidence_rows,
        evidence_id="ev-" + stable_hash({"reportId": report_id})[:32],
        owner_id=payload["bookshelfId"],
        generation=generation,
        upper_kind="community_report",
        upper_id=report_id,
        member=top_meta["member"],
        source=top_meta["source"],
        report_id=top_meta["reportId"],
        text_unit_id=top_meta["textUnitId"],
        artifact_digest=top_meta["artifactDigest"],
        rank=float(top["rank"]),
    )]
    summary = " ".join([unit["summary"] for unit in group[:3]])
    communities.append({
        "id": community_id,
        "human_readable_id": index,
        "community": index,
        "level": 0,
        "parent": -1,
        "children": [],
        "title": f"{member['title']} shelf cluster",
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
        "title": f"{member['title']} shelf report",
        "summary": clean_text(summary, group[0]["title"], 2200),
        "full_content": clean_text(summary, group[0]["summary"], 3600),
        "rank": max(float(unit["rank"]) for unit in group),
        "findings": [{
            "summary": unit["title"],
            "explanation": unit["summary"][:600],
        } for unit in group[:6]],
        "evidenceMapIds": evidence_ids,
        "generation": generation,
    })


def append_overview_community(
    payload: dict[str, Any],
    semantic_units: list[dict[str, Any]],
    communities: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    unit_meta: dict[str, dict[str, Any]],
) -> None:
    bookshelf_id = payload["bookshelfId"]
    generation = payload["generation"]
    community_id = "bsc-" + stable_hash({
        "bookshelfId": bookshelf_id,
        "generation": generation,
        "kind": "overview",
    })[:32]
    report_id = "bsr-" + stable_hash({"communityId": community_id})[:32]
    evidence_ids = []
    for unit in semantic_units[: min(8, len(semantic_units))]:
        meta = unit_meta[unit["semanticUnitId"]]
        evidence_ids.append(add_evidence(
            evidence_rows,
            evidence_id="ev-" + stable_hash({
                "reportId": report_id,
                "unitId": unit["semanticUnitId"],
            })[:32],
            owner_id=bookshelf_id,
            generation=generation,
            upper_kind="community_report",
            upper_id=report_id,
            member=meta["member"],
            source=meta["source"],
            report_id=meta["reportId"],
            text_unit_id=meta["textUnitId"],
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
        "title": f"{bookshelf_id} overview",
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
        "title": f"{bookshelf_id} overview report",
        "summary": clean_text(summary, f"{bookshelf_id} overview", 2400),
        "full_content": clean_text(summary, f"{bookshelf_id} overview", 4200),
        "rank": max(float(unit["rank"]) for unit in semantic_units),
        "findings": [{
            "summary": unit["title"],
            "explanation": unit["summary"][:600],
        } for unit in semantic_units[:8]],
        "evidenceMapIds": evidence_ids,
        "generation": generation,
    })


def build(payload: dict[str, Any]) -> dict[str, Any]:
    output_root = Path(payload["outputRoot"])
    output_root.mkdir(parents=True, exist_ok=True)
    semantic_units: list[dict[str, Any]] = []
    evidence_rows: list[dict[str, Any]] = []
    unit_meta: dict[str, dict[str, Any]] = {}
    append_semantic_units(payload, semantic_units, evidence_rows, unit_meta)
    semantic_units = limit_semantic_units(
        payload,
        semantic_units,
        evidence_rows,
        unit_meta,
    )
    edges = build_edges(payload, semantic_units, evidence_rows, unit_meta)
    communities, reports = build_communities(
        payload, semantic_units, evidence_rows, unit_meta
    )
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
