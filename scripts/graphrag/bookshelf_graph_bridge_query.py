from pathlib import Path
from typing import Any

from bookshelf_graph_bridge_contracts import as_rank, clean_text, tokens_for
from bookshelf_graph_bridge_io import read_rows


def _list_value(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item)]
    if value is None:
        return []
    return [str(value)] if str(value) else []


def _score_report(report: dict[str, Any], query_tokens: set[str]) -> float:
    text = " ".join([
        str(report.get("title") or ""),
        str(report.get("summary") or ""),
        str(report.get("full_content") or ""),
    ])
    report_tokens = tokens_for(text)
    overlap = len(query_tokens.intersection(report_tokens))
    lexical = overlap / max(1, len(query_tokens))
    rank_bonus = min(max(as_rank(report.get("rank")), 0.0), 10.0) / 100.0
    return lexical + rank_bonus


def _selected_reports(
    reports: list[dict[str, Any]],
    query: str,
    max_reports: int,
) -> list[dict[str, Any]]:
    query_tokens = tokens_for(query)
    indexed = []
    for index, report in enumerate(reports):
        score = _score_report(report, query_tokens)
        indexed.append((score, as_rank(report.get("rank")), -index, report))
    indexed.sort(reverse=True)
    return [
        {**report, "_queryScore": score}
        for score, _, _, report in indexed[:max_reports]
    ]


def _evidence_by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("evidenceMapId")): row
        for row in rows
        if row.get("evidenceMapId") is not None
    }


def _evidence_rows_for_report(
    report: dict[str, Any],
    evidence_rows: list[dict[str, Any]],
    by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    evidence_ids = _list_value(report.get("evidenceMapIds"))
    rows = [by_id[item] for item in evidence_ids if item in by_id]
    if rows:
        return rows
    report_id = str(report.get("id") or "")
    return [
        row for row in evidence_rows
        if str(row.get("upperArtifactId") or "") == report_id
    ][:1]


def _answer_text(
    scope_kind: str,
    scope_id: str,
    selected: list[dict[str, Any]],
    estimated_tokens: int,
    max_input_tokens: int,
) -> str:
    lines = [
        (
            f"{scope_kind.title()} {scope_id} fixed-budget GraphRAG report search "
            f"selected {len(selected)} upper community reports "
            f"(estimatedInputTokens={estimated_tokens}, "
            f"maxInputTokens={max_input_tokens}, llmCalls=0)."
        )
    ]
    for index, report in enumerate(selected, start=1):
        title = clean_text(report.get("title"), f"report {index}", 180)
        summary = clean_text(
            report.get("summary") or report.get("full_content"),
            title,
            900,
        )
        lines.append(f"{index}. {title}: {summary}")
    return "\n".join(lines)


def query(payload: dict[str, Any]) -> dict[str, Any]:
    root = Path(payload["outputRoot"])
    query_text = str(payload.get("query") or "")
    max_reports = max(1, int(payload.get("maxReports") or 8))
    max_input_tokens = max(1, int(payload.get("maxInputTokens") or 64000))
    scope_kind = str(payload.get("scopeKind") or "bookshelf")
    scope_id = str(
        payload.get("scopeId") or
        payload.get("bookshelfId") or
        payload.get("libraryId") or
        ""
    )
    generation = str(payload.get("generation") or "")

    reports = read_rows(root / "community_reports.parquet")
    evidence_rows = read_rows(root / "evidence_map.parquet")
    selected = _selected_reports(reports, query_text, max_reports)
    estimated_tokens = sum(
        max(1, len(str(report.get("summary") or report.get("full_content") or "")
                   .split()))
        for report in selected
    )
    if estimated_tokens > max_input_tokens:
        return {
            "ok": False,
            "diagnostics": ["budget_exceeded_narrow_scope_required"],
            "reportCount": len(reports),
            "selectedReportCount": len(selected),
            "estimatedInputTokens": estimated_tokens,
            "maxInputTokens": max_input_tokens,
            "answerText": "",
            "evidence": [],
        }

    by_id = _evidence_by_id(evidence_rows)
    evidence = []
    for report in selected:
        report_id = str(report.get("id") or "")
        report_title = clean_text(report.get("title"), report_id, 240)
        report_summary = clean_text(
            report.get("summary") or report.get("full_content"),
            report_title,
            1000,
        )
        rows = _evidence_rows_for_report(report, evidence_rows, by_id)
        for row in rows:
            item = {
                "evidenceMapId": str(row.get("evidenceMapId") or ""),
                "upperCommunityReportId": report_id,
                "upperCommunityReportTitle": report_title,
                "quote": report_summary,
                "score": float(report.get("_queryScore") or 0.0),
                "targetBookId": str(row.get("targetBookId") or ""),
                "targetSourceId": str(row.get("targetSourceId") or ""),
                "targetDocumentId": str(row.get("targetDocumentId") or ""),
                "targetContentHash": str(row.get("targetContentHash") or ""),
                "targetCommunityReportId": str(
                    row.get("targetCommunityReportId") or ""
                ),
                "targetTextUnitId": str(row.get("targetTextUnitId") or ""),
                "targetArtifactDigest": str(row.get("targetArtifactDigest") or ""),
                "ownerId": str(row.get("ownerId") or scope_id),
                "generation": str(row.get("generation") or generation),
            }
            target_bookshelf_id = str(row.get("targetBookshelfId") or "")
            if target_bookshelf_id:
                item["targetBookshelfId"] = target_bookshelf_id
            evidence.append(item)

    return {
        "ok": bool(selected) and bool(evidence),
        "diagnostics": [] if selected and evidence else ["empty_bookshelf_query_result"],
        "reportCount": len(reports),
        "selectedReportCount": len(selected),
        "estimatedInputTokens": estimated_tokens,
        "maxInputTokens": max_input_tokens,
        "answerText": _answer_text(
            scope_kind,
            scope_id,
            selected,
            estimated_tokens,
            max_input_tokens,
        ),
        "evidence": evidence,
    }
