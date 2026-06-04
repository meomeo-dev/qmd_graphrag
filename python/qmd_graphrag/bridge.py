#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GRAPHRAG_REPO = REPO_ROOT / "vendor" / "graphrag"
REQUIRED_LANCEDB_TABLES = (
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
)
QUERY_READY_ARTIFACT_KINDS = {
    "graphrag_community_reports_parquet",
    "lancedb_index",
}
GRAPH_EXTRACT_CORE_ARTIFACT_KINDS = {
    "graphrag_documents_parquet",
    "graphrag_text_units_parquet",
    "graphrag_entities_parquet",
    "graphrag_relationships_parquet",
    "graphrag_communities_parquet",
    "graphrag_context_json",
    "graphrag_stats_json",
}
QUERY_READY_PRODUCER_REQUIRED_KINDS = {
    "graph_extract": GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
    "community_report": {"graphrag_community_reports_parquet"},
    "embed": {"lancedb_index"},
}
QUERY_READY_PRODUCER_STAGES = (
    "graph_extract",
    "community_report",
    "embed",
)
QUERY_READY_LINEAGE_ARTIFACT_KINDS = (
    GRAPH_EXTRACT_CORE_ARTIFACT_KINDS | QUERY_READY_ARTIFACT_KINDS
)
PRODUCER_STAGE_BY_ARTIFACT_KIND = {
    "source_epub": "ingest",
    "normalized_markdown": "normalize",
    "graphrag_documents_parquet": "graph_extract",
    "graphrag_text_units_parquet": "graph_extract",
    "graphrag_entities_parquet": "graph_extract",
    "graphrag_relationships_parquet": "graph_extract",
    "graphrag_communities_parquet": "graph_extract",
    "graphrag_context_json": "graph_extract",
    "graphrag_stats_json": "graph_extract",
    "graphrag_community_reports_parquet": "community_report",
    "lancedb_index": "embed",
    "query_snapshot": "query_ready",
}
WINDOWS_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
URI_LIKE_PREFIX = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
LOGGER = logging.getLogger(__name__)
_GRAPHRAG_TEXT_CONTEXT_COMPAT_PATCHED = False

if str(REPO_ROOT / "python") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "python"))

from qmd_graphrag.query_runtime_metrics import (  # noqa: E402
    QueryRuntimeMetricsRecorder,
    query_log_offset,
)


def _emit_error(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def _normalize_vault_relative_path(path: str) -> str | None:
    normalized = path.replace("\\", "/")
    if (
        not path
        or "\0" in path
        or normalized == "~"
        or normalized.startswith("~/")
        or re.match(r"^~[^/]*(?:/|$)", normalized) is not None
        or Path(path).is_absolute()
        or WINDOWS_DRIVE_PREFIX.match(path) is not None
        or WINDOWS_DRIVE_PREFIX.match(normalized) is not None
        or URI_LIKE_PREFIX.match(path) is not None
        or URI_LIKE_PREFIX.match(normalized) is not None
    ):
        return None
    parts = [part for part in normalized.split("/") if part and part != "."]
    if not parts or any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty request payload")
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("request payload must be a JSON object")
    return obj


def _resolve_repo_path(repo_path: str | None, default_path: Path) -> Path:
    root = Path(repo_path).resolve() if repo_path else default_path.resolve()
    if not root.exists():
        raise FileNotFoundError(f"missing repository path: {root}")
    return root


def _add_monorepo_package_paths(root: Path) -> None:
    packages_dir = root / "packages"
    if not packages_dir.exists():
        sys.path.insert(0, str(root))
        return

    for child in packages_dir.iterdir():
        if child.is_dir():
            sys.path.insert(0, str(child))


def _serialize_json(value: Any) -> Any:
    try:
        import pandas as pd  # type: ignore
    except Exception:  # noqa: BLE001
        pd = None

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _serialize_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_serialize_json(item) for item in value]
    if pd is not None and isinstance(value, pd.DataFrame):
        return value.to_dict(orient="records")
    return str(value)


def _dataframe_records(frame: Any) -> list[dict[str, Any]]:
    if frame is None:
        return []
    if hasattr(frame, "to_dict"):
        records = frame.to_dict(orient="records")
        return [item for item in records if isinstance(item, dict)]
    if isinstance(frame, list):
        return [item for item in frame if isinstance(item, dict)]
    return []


def _summarize_result(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:400]


def _install_graphrag_text_unit_context_compat_patch() -> None:
    """Patch GraphRAG text context joins that lack community-local degree."""
    global _GRAPHRAG_TEXT_CONTEXT_COMPAT_PATCHED
    if _GRAPHRAG_TEXT_CONTEXT_COMPAT_PATCHED:
        return

    try:
        import pandas as pd  # type: ignore
        import graphrag.data_model.schemas as schemas  # type: ignore
        import graphrag.index.workflows.create_community_reports_text as workflow  # type: ignore
        from graphrag.index.operations.summarize_communities.text_unit_context import (  # type: ignore
            context_builder,
        )
    except (ImportError, ModuleNotFoundError):
        LOGGER.debug("GraphRAG text-unit context patch modules are unavailable")
        return

    original_build_local_context = context_builder.build_local_context
    if getattr(original_build_local_context, "_qmd_graphrag_compat_patch", False):
        _GRAPHRAG_TEXT_CONTEXT_COMPAT_PATCHED = True
        return

    def build_local_context_with_compat(
        community_membership_df: pd.DataFrame,
        text_units_df: pd.DataFrame,
        node_df: pd.DataFrame,
        tokenizer: Any,
        max_context_tokens: int = 16000,
    ) -> pd.DataFrame:
        original_error: TypeError | None = None
        try:
            return original_build_local_context(
                community_membership_df.copy(deep=True),
                text_units_df.copy(deep=True),
                node_df.copy(deep=True),
                tokenizer,
                max_context_tokens,
            )
        except TypeError as error:
            if "'float' object is not subscriptable" not in str(error):
                raise
            original_error = error

        prepped_text_units_df = context_builder.prep_text_units(
            text_units_df.copy(deep=True),
            node_df.copy(deep=True),
        )
        prepped_text_units_df = prepped_text_units_df.rename(
            columns={
                schemas.ID: schemas.TEXT_UNIT_IDS,
                schemas.COMMUNITY_ID: schemas.COMMUNITY_ID,
            },
        )

        context_df = community_membership_df.loc[
            :,
            [schemas.COMMUNITY_ID, schemas.COMMUNITY_LEVEL, schemas.TEXT_UNIT_IDS],
        ]
        context_df = context_df.explode(schemas.TEXT_UNIT_IDS)
        context_df = context_df.merge(
            prepped_text_units_df,
            on=[schemas.TEXT_UNIT_IDS, schemas.COMMUNITY_ID],
            how="left",
        )

        valid_details = context_df[schemas.ALL_DETAILS].apply(
            lambda value: isinstance(value, dict),
        )
        unresolved_df = context_df.loc[~valid_details]
        if unresolved_df.empty:
            raise original_error

        text_unit_lookup = text_units_df.copy()
        text_unit_lookup["_qmd_text_unit_id"] = (
            text_unit_lookup[schemas.ID].astype(str)
        )
        text_unit_lookup = text_unit_lookup.set_index("_qmd_text_unit_id", drop=False)
        unresolved_text_ids = unresolved_df[schemas.TEXT_UNIT_IDS].astype(str)
        missing_text_ids = sorted(
            set(unresolved_text_ids) - set(text_unit_lookup.index.astype(str)),
        )
        if missing_text_ids:
            raise RuntimeError(
                "GraphRAG community text-unit context references missing text "
                "units: " + ",".join(missing_text_ids[:20]),
            ) from original_error

        affected_communities = sorted(
            {
                str(item)
                for item in unresolved_df[schemas.COMMUNITY_ID].dropna().tolist()
            },
        )
        LOGGER.warning(
            "qmd_graphrag filled %d GraphRAG community/text-unit context "
            "rows with entity_degree=0 across %d communities",
            len(unresolved_df.index),
            len(affected_communities),
        )
        LOGGER.info(
            "qmd_graphrag GraphRAG context compatibility communities: %s",
            ",".join(affected_communities[:50]),
        )

        all_communities = context_df[
            [schemas.COMMUNITY_ID, schemas.COMMUNITY_LEVEL]
        ].drop_duplicates()
        context_df = context_df.copy()

        def fill_missing_details(row: Any) -> dict[str, Any]:
            details = row[schemas.ALL_DETAILS]
            if isinstance(details, dict):
                return details
            text_unit_id = str(row[schemas.TEXT_UNIT_IDS])
            text_unit = text_unit_lookup.loc[text_unit_id]
            return {
                schemas.SHORT_ID: text_unit[schemas.SHORT_ID],
                schemas.TEXT: text_unit[schemas.TEXT],
                schemas.ENTITY_DEGREE: 0,
            }

        context_df[schemas.ALL_DETAILS] = context_df.apply(
            fill_missing_details,
            axis=1,
        )

        context_df[schemas.ALL_CONTEXT] = context_df.apply(
            lambda row: {
                "id": row[schemas.ALL_DETAILS][schemas.SHORT_ID],
                "text": row[schemas.ALL_DETAILS][schemas.TEXT],
                "entity_degree": row[schemas.ALL_DETAILS][schemas.ENTITY_DEGREE],
            },
            axis=1,
        )

        context_df = (
            context_df
            .groupby([schemas.COMMUNITY_ID, schemas.COMMUNITY_LEVEL])
            .agg({schemas.ALL_CONTEXT: list})
            .reset_index()
        )
        missing_communities = all_communities.merge(
            context_df[[schemas.COMMUNITY_ID, schemas.COMMUNITY_LEVEL]],
            on=[schemas.COMMUNITY_ID, schemas.COMMUNITY_LEVEL],
            how="left",
            indicator=True,
        )
        missing_communities = missing_communities[
            missing_communities["_merge"] == "left_only"
        ]
        if not missing_communities.empty:
            raise RuntimeError(
                "GraphRAG text-unit context has communities with no resolvable "
                "text-unit rows after compatibility fill: "
                f"{len(missing_communities.index)}",
            ) from original_error

        context_df[schemas.CONTEXT_STRING] = context_df[schemas.ALL_CONTEXT].apply(
            lambda value: context_builder.sort_context(value, tokenizer),
        )
        context_df[schemas.CONTEXT_SIZE] = context_df[schemas.CONTEXT_STRING].apply(
            lambda value: tokenizer.num_tokens(value),
        )
        context_df[schemas.CONTEXT_EXCEED_FLAG] = context_df[
            schemas.CONTEXT_SIZE
        ].apply(lambda value: value > max_context_tokens)

        return context_df

    build_local_context_with_compat._qmd_graphrag_compat_patch = True  # type: ignore[attr-defined]
    build_local_context_with_compat._qmd_graphrag_original = (  # type: ignore[attr-defined]
        original_build_local_context
    )
    context_builder.build_local_context = build_local_context_with_compat
    workflow.build_local_context = build_local_context_with_compat
    _GRAPHRAG_TEXT_CONTEXT_COMPAT_PATCHED = True


def _write_text_if_missing(path: Path, content: str) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", errors="strict")


def _ensure_graphrag_prompt_assets(root_dir: Path) -> None:
    from graphrag.prompts.index.community_report import COMMUNITY_REPORT_PROMPT
    from graphrag.prompts.index.community_report_text_units import (
        COMMUNITY_REPORT_TEXT_PROMPT,
    )
    from graphrag.prompts.index.extract_claims import EXTRACT_CLAIMS_PROMPT
    from graphrag.prompts.index.extract_graph import GRAPH_EXTRACTION_PROMPT
    from graphrag.prompts.index.summarize_descriptions import SUMMARIZE_PROMPT
    from graphrag.prompts.query.basic_search_system_prompt import (
        BASIC_SEARCH_SYSTEM_PROMPT,
    )
    from graphrag.prompts.query.drift_search_system_prompt import (
        DRIFT_LOCAL_SYSTEM_PROMPT,
        DRIFT_REDUCE_PROMPT,
    )
    from graphrag.prompts.query.global_search_knowledge_system_prompt import (
        GENERAL_KNOWLEDGE_INSTRUCTION,
    )
    from graphrag.prompts.query.global_search_map_system_prompt import (
        MAP_SYSTEM_PROMPT,
    )
    from graphrag.prompts.query.global_search_reduce_system_prompt import (
        REDUCE_SYSTEM_PROMPT,
    )
    from graphrag.prompts.query.local_search_system_prompt import (
        LOCAL_SEARCH_SYSTEM_PROMPT,
    )
    from graphrag.prompts.query.question_gen_system_prompt import (
        QUESTION_SYSTEM_PROMPT,
    )

    prompts_dir = root_dir / "prompts"
    prompts = {
        "extract_graph.txt": GRAPH_EXTRACTION_PROMPT,
        "summarize_descriptions.txt": SUMMARIZE_PROMPT,
        "extract_claims.txt": EXTRACT_CLAIMS_PROMPT,
        "community_report_graph.txt": COMMUNITY_REPORT_PROMPT,
        "community_report_text.txt": COMMUNITY_REPORT_TEXT_PROMPT,
        "drift_search_system_prompt.txt": DRIFT_LOCAL_SYSTEM_PROMPT,
        "drift_search_reduce_prompt.txt": DRIFT_REDUCE_PROMPT,
        "drift_reduce_prompt.txt": DRIFT_REDUCE_PROMPT,
        "global_search_map_system_prompt.txt": MAP_SYSTEM_PROMPT,
        "global_search_reduce_system_prompt.txt": REDUCE_SYSTEM_PROMPT,
        "global_search_knowledge_system_prompt.txt": GENERAL_KNOWLEDGE_INSTRUCTION,
        "local_search_system_prompt.txt": LOCAL_SEARCH_SYSTEM_PROMPT,
        "basic_search_system_prompt.txt": BASIC_SEARCH_SYSTEM_PROMPT,
        "question_gen_system_prompt.txt": QUESTION_SYSTEM_PROMPT,
    }

    for name, content in prompts.items():
        _write_text_if_missing(prompts_dir / name, content)


def _scoped_storage_overrides(
    *,
    input_dir: str | None = None,
    output_dir: str | None = None,
    report_dir: str | None = None,
) -> dict[str, Any]:
    overrides: dict[str, Any] = {}
    if input_dir:
        overrides["input"] = {
            "type": "text",
            "file_pattern": ".*\\.(md|markdown|txt)",
        }
        overrides["input_storage"] = {
            "type": "file",
            "base_dir": str(Path(input_dir).resolve()),
        }
    if output_dir:
        resolved_output = Path(output_dir).resolve()
        resolved_report = Path(report_dir).resolve() if report_dir else (
            resolved_output / "reports"
        )
        overrides["output_storage"] = {
            "type": "file",
            "base_dir": str(resolved_output),
        }
        overrides["reporting"] = {
            "type": "file",
            "base_dir": str(resolved_report),
        }
        overrides["cache"] = {
            "type": "json",
            "storage": {
                "type": "file",
                "base_dir": str(resolved_output / "cache"),
            },
        }
        overrides["vector_store"] = {
            "type": "lancedb",
            "db_uri": str(resolved_output / "lancedb"),
        }
    return overrides


def _path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _safe_runtime_segment(value: str) -> str:
    segment = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return segment[:120] or "unknown"


def _default_query_report_dir(root_dir: Path, scoped_book_ids: list[str]) -> Path:
    if len(scoped_book_ids) == 1:
        return (
            root_dir
            / ".local"
            / "book-runtime"
            / _safe_runtime_segment(scoped_book_ids[0])
            / "graphrag-query"
            / "reports"
        )
    scope_digest = hashlib.sha256(
        ",".join(sorted(scoped_book_ids)).encode("utf-8")
    ).hexdigest()[:16]
    return root_dir / ".local" / "query-runtime" / scope_digest / "reports"


def _resolve_query_report_dir(
    root_dir: Path,
    report_dir: str | None,
    scoped_book_ids: list[str],
) -> Path:
    requested = Path(report_dir) if report_dir else None
    resolved = (
        requested.resolve()
        if requested is not None and requested.is_absolute()
        else (root_dir / requested).resolve()
        if requested is not None
        else _default_query_report_dir(root_dir, scoped_book_ids).resolve()
    )
    if _path_is_relative_to(resolved, (root_dir / "books").resolve()):
        raise ValueError(
            "GraphRAG query reportDir must not be inside graph_vault/books"
        )
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def _register_qmd_completion_providers() -> None:
    try:
        from graphrag_llm.completion import register_completion

        from qmd_graphrag.graphrag_responses_completion import (
            OpenAIResponsesCompletion,
        )
    except ModuleNotFoundError as error:
        if error.name != "graphrag_llm":
            raise
        LOGGER.debug("GraphRAG completion provider registration unavailable: %s", error)
        return

    register_completion(
        completion_type="openai_responses",
        completion_initializer=OpenAIResponsesCompletion,
        scope="singleton",
    )


def _value_id_set(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, float):
        try:
            import math

            if math.isnan(value):
                return set()
        except Exception:  # noqa: BLE001
            pass
    if isinstance(value, (list, tuple, set)):
        return {str(item) for item in value if item is not None}
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return set()
        if text.startswith("[") and text.endswith("]"):
            try:
                parsed = json.loads(text)
                return _value_id_set(parsed)
            except Exception:  # noqa: BLE001
                return {text}
        return {text}
    if hasattr(value, "tolist"):
        try:
            return _value_id_set(value.tolist())
        except Exception:  # noqa: BLE001
            pass
    return {str(value)}


def _series_intersects(series: Any, ids: set[str]) -> Any:
    return series.apply(lambda value: bool(_value_id_set(value).intersection(ids)))


def _load_document_identity_map(root_dir: Path) -> dict[str, dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    identity_path = root_dir / "catalog" / "document-identity-map.yaml"
    if not identity_path.exists():
        return {}
    catalog = yaml.safe_load(identity_path.read_text(encoding="utf-8")) or {}
    return {
        str(item.get("documentId")): item
        for item in catalog.get("items", [])
        if isinstance(item, dict) and item.get("documentId")
    }


def _load_document_identity_map_by_book(root_dir: Path) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("canonicalBookId")): item
        for item in _load_document_identity_map(root_dir).values()
        if item.get("canonicalBookId")
    }


def _load_books_by_id(root_dir: Path) -> dict[str, dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    catalog_path = root_dir / "catalog" / "books.yaml"
    if not catalog_path.exists():
        return {}
    catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8")) or {}
    return {
        str(item.get("bookId")): item
        for item in catalog.get("items", [])
        if isinstance(item, dict) and item.get("bookId")
    }


def _load_checkpoints(root_dir: Path, book_id: str) -> list[dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    checkpoints_path = _book_state_yaml_path(root_dir, book_id, "checkpoints.yaml")
    if not checkpoints_path.exists():
        return []
    checkpoints = yaml.safe_load(checkpoints_path.read_text(encoding="utf-8")) or {}
    return [
        item
        for item in checkpoints.get("items", [])
        if isinstance(item, dict)
    ]


def _book_state_yaml_path(root_dir: Path, book_id: str, file_name: str) -> Path:
    book_root = root_dir / "books" / book_id
    current = book_root / "state" / file_name
    if current.exists():
        return current
    return book_root / file_name


def _expected_book_content_hash(book: dict[str, Any]) -> str:
    return str(book.get("normalizedContentHash") or book.get("sourceHash") or "")


def _metadata_string(metadata: Any, key: str) -> str | None:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(key)
    return value if isinstance(value, str) and value else None


def _checkpoint_timestamp(checkpoint: dict[str, Any]) -> str:
    return str(checkpoint.get("finishedAt") or checkpoint.get("startedAt") or "")


def _run_record_to_checkpoint_candidate(
    record: dict[str, Any],
    book: dict[str, Any],
) -> dict[str, Any] | None:
    stage = str(record.get("stage") or "")
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    stage_fingerprint = (
        _metadata_string(metadata, "stageFingerprint")
        or str(record.get("inputFingerprint") or "")
    )
    provider_fingerprint = (
        _metadata_string(metadata, "providerFingerprint")
        or str(book.get("providerFingerprint") or "")
    )
    candidate = {
        "schemaVersion": record.get("schemaVersion", SCHEMA_VERSION),
        "bookId": record.get("bookId"),
        "stage": stage,
        "status": record.get("status"),
        "attemptCount": record.get("attemptCount", 0),
        "runId": record.get("runId"),
        "startedAt": record.get("startedAt"),
        "finishedAt": record.get("finishedAt"),
        "inputFingerprint": record.get("inputFingerprint"),
        "contentHash": _expected_book_content_hash(book),
        "stageFingerprint": stage_fingerprint,
        "providerFingerprint": provider_fingerprint,
        "artifactIds": record.get("artifactIds") or [],
        "errorSummary": record.get("errorSummary"),
        "metadata": metadata,
    }
    if not candidate["bookId"] or not candidate["stage"]:
        return None
    return candidate


def _load_run_record_candidates(
    root_dir: Path,
    book: dict[str, Any],
) -> list[dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    book_id = str(book.get("bookId") or "")
    catalog_path = root_dir / "catalog" / "runs.yaml"
    if not book_id or not catalog_path.exists():
        return []
    catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8")) or {}
    candidates: list[dict[str, Any]] = []
    for item in catalog.get("items", []):
        if not isinstance(item, dict) or item.get("bookId") != book_id:
            continue
        run_id = str(item.get("runId") or "")
        if not run_id:
            continue
        run_path = root_dir / "books" / book_id / "runs" / f"{run_id}.yaml"
        if not run_path.exists():
            continue
        record = yaml.safe_load(run_path.read_text(encoding="utf-8")) or {}
        if not isinstance(record, dict):
            continue
        candidate = _run_record_to_checkpoint_candidate(record, book)
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def _load_checkpoint_candidates(
    root_dir: Path,
    book: dict[str, Any],
) -> list[dict[str, Any]]:
    book_id = str(book.get("bookId") or "")
    candidates = [
        *_load_checkpoints(root_dir, book_id),
        *_load_run_record_candidates(root_dir, book),
    ]
    return sorted(candidates, key=_checkpoint_timestamp, reverse=True)


def _checkpoint_matches_book(
    checkpoint: dict[str, Any],
    book: dict[str, Any],
    require_run_id: bool = True,
) -> bool:
    stage = str(checkpoint.get("stage") or "")
    stage_fingerprints = book.get("stageFingerprints") or {}
    metadata = checkpoint.get("metadata")
    run_id = checkpoint.get("runId")
    return (
        checkpoint.get("bookId") == book.get("bookId")
        and checkpoint.get("status") == "succeeded"
        and not (isinstance(metadata, dict) and metadata.get("bootstrap") is True)
        and (not require_run_id or isinstance(run_id, str) and bool(run_id))
        and checkpoint.get("contentHash") == _expected_book_content_hash(book)
        and checkpoint.get("stageFingerprint") == stage_fingerprints.get(stage)
        and checkpoint.get("providerFingerprint") == book.get("providerFingerprint")
    )


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _filter_artifact_ids_by_kinds(
    artifact_ids: list[str],
    artifacts_by_id: dict[str, dict[str, Any]],
    kinds: set[str],
) -> list[str]:
    return [
        artifact_id
        for artifact_id in artifact_ids
        if str((artifacts_by_id.get(artifact_id) or {}).get("kind") or "") in kinds
    ]


def _artifact_ids_for_producer_stage(
    artifacts_by_id: dict[str, dict[str, Any]],
    book_id: str,
    stage: str,
    producer_run_id: str | None,
    required_kinds: set[str],
    checkpoint_artifact_ids: list[str] | None = None,
) -> list[str]:
    if producer_run_id:
        selected = [
            artifact_id
            for artifact_id, artifact in artifacts_by_id.items()
            if artifact.get("bookId") == book_id
            and artifact.get("stage") == stage
            and artifact.get("producerRunId") == producer_run_id
            and str(artifact.get("kind") or "") in required_kinds
        ]
        if selected:
            return _unique_strings(selected)
    return _filter_artifact_ids_by_kinds(
        checkpoint_artifact_ids or [],
        artifacts_by_id,
        required_kinds,
    )


def _select_producer_checkpoint(
    root_dir: Path,
    book: dict[str, Any],
    artifacts_by_id: dict[str, dict[str, Any]],
    candidates: list[dict[str, Any]],
    stage: str,
) -> dict[str, Any] | None:
    book_id = str(book.get("bookId") or "")
    stage_fingerprints = book.get("stageFingerprints") or {}
    provider_fingerprint = str(book.get("providerFingerprint") or "")
    corpus_content_hash = _expected_book_content_hash(book)
    required_kinds = QUERY_READY_PRODUCER_REQUIRED_KINDS[stage]
    for checkpoint in candidates:
        if checkpoint.get("stage") != stage or not _checkpoint_matches_book(
            checkpoint,
            book,
        ):
            continue
        producer_run_id = str(checkpoint.get("runId") or "")
        artifact_ids = _artifact_ids_for_producer_stage(
            artifacts_by_id,
            book_id,
            stage,
            producer_run_id,
            required_kinds,
            [
                str(item)
                for item in checkpoint.get("artifactIds", [])
                if item is not None
            ],
        )
        if _validate_artifact_subset(
            root_dir,
            book_id,
            artifact_ids,
            artifacts_by_id,
            required_kinds,
            required_kinds,
            stage_fingerprints,
            provider_fingerprint,
            corpus_content_hash,
            {stage: producer_run_id},
        ):
            return checkpoint
    return None


def _query_ready_gate_artifact_ids(
    artifacts_by_id: dict[str, dict[str, Any]],
    book_id: str,
    expected_producer_run_ids: dict[str, str],
    checkpoint_artifact_ids: list[str],
) -> list[str]:
    return _unique_strings([
        *_artifact_ids_for_producer_stage(
            artifacts_by_id,
            book_id,
            "community_report",
            expected_producer_run_ids["community_report"],
            {"graphrag_community_reports_parquet"},
            checkpoint_artifact_ids,
        ),
        *_artifact_ids_for_producer_stage(
            artifacts_by_id,
            book_id,
            "embed",
            expected_producer_run_ids["embed"],
            {"lancedb_index"},
            checkpoint_artifact_ids,
        ),
    ])


def _select_query_ready_checkpoint(
    root_dir: Path,
    book: dict[str, Any],
    artifacts_by_id: dict[str, dict[str, Any]],
    candidates: list[dict[str, Any]],
    expected_producer_run_ids: dict[str, str],
) -> dict[str, Any] | None:
    book_id = str(book.get("bookId") or "")
    stage_fingerprints = book.get("stageFingerprints") or {}
    provider_fingerprint = str(book.get("providerFingerprint") or "")
    corpus_content_hash = _expected_book_content_hash(book)
    for checkpoint in candidates:
        if checkpoint.get("stage") != "query_ready" or not _checkpoint_matches_book(
            checkpoint,
            book,
            require_run_id=False,
        ):
            continue
        artifact_ids = _query_ready_gate_artifact_ids(
            artifacts_by_id,
            book_id,
            expected_producer_run_ids,
            [
                str(item)
                for item in checkpoint.get("artifactIds", [])
                if item is not None
            ],
        )
        if _validate_artifact_subset(
            root_dir,
            book_id,
            artifact_ids,
            artifacts_by_id,
            QUERY_READY_ARTIFACT_KINDS,
            QUERY_READY_ARTIFACT_KINDS,
            stage_fingerprints,
            provider_fingerprint,
            corpus_content_hash,
            expected_producer_run_ids,
        ):
            return checkpoint
    return None


def _project_query_ready_lineage(
    root_dir: Path,
    book_id: str,
) -> dict[str, Any] | None:
    book = _load_books_by_id(root_dir).get(book_id)
    if not isinstance(book, dict):
        return None
    if not isinstance(book.get("stageFingerprints"), dict):
        return None
    if not isinstance(book.get("providerFingerprint"), str):
        return None
    if not _book_state_yaml_path(root_dir, book_id, "checkpoints.yaml").exists():
        return None

    artifacts_by_id = _load_artifacts_by_id(root_dir, [book_id])
    candidates = _load_checkpoint_candidates(root_dir, book)
    checkpoint_by_stage: dict[str, dict[str, Any]] = {}
    expected_producer_run_ids: dict[str, str] = {}
    for stage in QUERY_READY_PRODUCER_STAGES:
        checkpoint = _select_producer_checkpoint(
            root_dir,
            book,
            artifacts_by_id,
            candidates,
            stage,
        )
        if checkpoint is None:
            return None
        checkpoint_by_stage[stage] = checkpoint
        expected_producer_run_ids[stage] = str(checkpoint.get("runId") or "")

    query_ready = _select_query_ready_checkpoint(
        root_dir,
        book,
        artifacts_by_id,
        candidates,
        expected_producer_run_ids,
    )
    if query_ready is None:
        return None
    checkpoint_by_stage["query_ready"] = query_ready

    artifact_ids: list[str] = []
    for stage in QUERY_READY_PRODUCER_STAGES:
        checkpoint = checkpoint_by_stage[stage]
        artifact_ids.extend(
            _artifact_ids_for_producer_stage(
                artifacts_by_id,
                book_id,
                stage,
                expected_producer_run_ids[stage],
                QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
                [
                    str(item)
                    for item in checkpoint.get("artifactIds", [])
                    if item is not None
                ],
            )
        )
    artifact_ids.extend(
        _query_ready_gate_artifact_ids(
            artifacts_by_id,
            book_id,
            expected_producer_run_ids,
            [
                str(item)
                for item in query_ready.get("artifactIds", [])
                if item is not None
            ],
        )
    )
    return {
        "book": book,
        "artifactsById": artifacts_by_id,
        "checkpointByStage": checkpoint_by_stage,
        "expectedProducerRunIds": expected_producer_run_ids,
        "artifactIds": _unique_strings(artifact_ids),
    }


def _derive_graph_query_capability(
    root_dir: Path,
    book: dict[str, Any],
    identity_by_book: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    book_id = str(book.get("bookId") or "")
    if not book_id:
        raise ValueError("book state is missing bookId")
    expected_source_hash = str(book.get("sourceHash") or "")
    expected_source_id = f"sha256:{expected_source_hash}" if expected_source_hash else ""
    expected_document_id = str(book.get("documentId") or "")
    expected_content_hash = str(
        book.get("normalizedContentHash") or book.get("sourceHash") or ""
    )
    identity = (identity_by_book or _load_document_identity_map_by_book(root_dir)).get(
        book_id,
    )
    if identity is None:
        document_identity = _load_document_identity_map(root_dir).get(expected_document_id)
        if document_identity is not None:
            identity = document_identity
        else:
            raise ValueError(f"book {book_id} is missing document identity")
    if identity is None:
        raise ValueError(f"book {book_id} is missing document identity")
    if identity.get("canonicalBookId") != book_id:
        raise ValueError(f"book {book_id} bookId mismatches identity")
    identity_metadata = identity.get("metadata") or {}
    if identity_metadata.get("qmdCorpusRegistered") is not True:
        raise ValueError(f"book {book_id} identity is not registered in qmd corpus")
    artifact_ids = _load_query_ready_lineage_artifact_ids(root_dir, book_id) or []
    source_id = identity.get("sourceId")
    source_hash = identity.get("sourceHash")
    document_id = identity.get("documentId")
    content_hash = identity.get("contentHash")
    graph_document_id = identity.get("graphDocumentId")
    graph_text_unit_ids = identity.get("graphTextUnitIds")
    if not source_id or not document_id or not content_hash:
        raise ValueError(f"book {book_id} is missing graph capability identity")
    if not expected_source_hash or source_hash != expected_source_hash:
        raise ValueError(f"book {book_id} identity sourceHash mismatch")
    if source_id != expected_source_id:
        raise ValueError(f"book {book_id} identity sourceId mismatch")
    if not expected_document_id or document_id != expected_document_id:
        raise ValueError(f"book {book_id} identity documentId mismatch")
    if not expected_content_hash or content_hash != expected_content_hash:
        raise ValueError(f"book {book_id} identity contentHash mismatch")
    if not isinstance(graph_document_id, str) or not graph_document_id:
        raise ValueError(f"book {book_id} is missing graphDocumentId")
    if not isinstance(graph_text_unit_ids, list) or not graph_text_unit_ids:
        raise ValueError(f"book {book_id} is missing graphTextUnitIds")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "capabilityId": f"{book_id}:graph_query",
        "kind": "graph_query",
        "bookId": book_id,
        "sourceId": str(source_id),
        "documentId": str(document_id),
        "contentHash": str(content_hash),
        "ready": True,
        "readinessSource": "validated_checkpoint_plus_validated_manifest",
        "artifactIds": artifact_ids,
        "createdAt": "1970-01-01T00:00:00.000Z",
        "metadata": {"projectionSource": "book_state"},
    }


def _load_book_scope(root_dir: Path, selected_book_ids: list[str]) -> list[dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    catalog_path = root_dir / "catalog" / "books.yaml"
    if not catalog_path.exists():
        raise FileNotFoundError(
            f"missing graph capability book catalog for scoped query: {catalog_path}"
        )

    catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8")) or {}
    identity_by_book = _load_document_identity_map_by_book(root_dir)
    books = _load_books_by_id(root_dir)
    scope: list[dict[str, Any]] = []
    missing: list[str] = []

    for book_id in selected_book_ids:
        book = books.get(book_id)
        if book is None:
            missing.append(book_id)
            continue
        identity = identity_by_book.get(book_id)
        if identity is None:
            raise ValueError(f"book {book_id} is missing document identity")
        if identity.get("canonicalBookId") != book_id:
            raise ValueError(f"book {book_id} identity canonicalBookId mismatch")
        identity_metadata = identity.get("metadata") or {}
        if identity_metadata.get("qmdCorpusRegistered") is not True:
            raise ValueError(
                f"book {book_id} identity is not registered in qmd corpus"
            )
        metadata = book.get("metadata") or {}
        normalized_path = identity.get("normalizedPath") or metadata.get("normalizedPath")
        if not isinstance(normalized_path, str) or not normalized_path:
            raise ValueError(
                f"book {book_id} is missing metadata.normalizedPath for scoped query"
            )
        source_id = identity.get("sourceId")
        qmd_document_id = identity.get("documentId")
        content_hash = identity.get("contentHash")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError(f"book {book_id} is missing sourceId for scoped query")
        if not isinstance(qmd_document_id, str) or not qmd_document_id:
            raise ValueError(f"book {book_id} is missing documentId for scoped query")
        if not isinstance(content_hash, str) or not content_hash:
            raise ValueError(f"book {book_id} is missing contentHash for scoped query")
        graph_document_id = identity.get("graphDocumentId")
        graph_text_unit_ids = identity.get("graphTextUnitIds") or []
        if not isinstance(graph_document_id, str) or not graph_document_id:
            raise ValueError(
                f"book {book_id} is missing graphDocumentId for scoped query"
            )
        if not isinstance(graph_text_unit_ids, list) or not graph_text_unit_ids:
            raise ValueError(
                f"book {book_id} is missing graphTextUnitIds for scoped query"
            )
        scope.append(
            {
                "bookId": book_id,
                "normalizedPath": normalized_path,
                "sourceId": source_id,
                "qmdDocumentId": qmd_document_id,
                "contentHash": content_hash,
                "graphDocumentId": graph_document_id,
                "graphTextUnitIds": graph_text_unit_ids,
            }
        )

    if missing:
        raise ValueError(
            "capabilityScope references unknown bookId(s): " + ", ".join(missing)
        )
    return scope


def _capability_scope_set(capability_scope: dict[str, Any], key: str) -> set[str]:
    return {
        str(item)
        for item in capability_scope.get(key) or []
        if item is not None and str(item)
    }


def _validate_capabilities_against_request_scope(
    root_dir: Path,
    capability_scope: dict[str, Any],
    capabilities: list[dict[str, Any]],
) -> None:
    requested_books = _capability_scope_set(capability_scope, "selectedBookIds")
    requested_capabilities = _capability_scope_set(capability_scope, "graphCapabilityIds")
    requested_sources = _capability_scope_set(capability_scope, "sourceIds")
    requested_documents = _capability_scope_set(capability_scope, "documentIds")
    requested_hashes = _capability_scope_set(capability_scope, "contentHashes")
    requested_artifacts = _capability_scope_set(capability_scope, "artifactIds")
    identity_map = _load_document_identity_map(root_dir)

    for capability in capabilities:
        capability_id = str(capability.get("capabilityId") or "")
        book_id = str(capability.get("bookId") or "")
        source_id = str(capability.get("sourceId") or "")
        document_id = str(capability.get("documentId") or "")
        content_hash = str(capability.get("contentHash") or "")
        artifact_ids = {str(item) for item in capability.get("artifactIds") or []}

        if capability_id not in requested_capabilities:
            raise ValueError(f"unrequested graphCapabilityId resolved: {capability_id}")
        if book_id not in requested_books:
            raise ValueError(f"graph capability resolves outside selectedBookIds: {book_id}")
        if requested_sources and source_id not in requested_sources:
            raise ValueError(f"graph capability sourceId outside requested scope: {source_id}")
        if requested_documents and document_id not in requested_documents:
            raise ValueError(
                f"graph capability documentId outside requested scope: {document_id}"
            )
        if requested_hashes and content_hash not in requested_hashes:
            raise ValueError(
                f"graph capability contentHash outside requested scope: {content_hash}"
            )
        if requested_artifacts and not artifact_ids.issubset(requested_artifacts):
            raise ValueError("graph capability artifactIds outside requested scope")

        identity = identity_map.get(document_id)
        if identity is None:
            raise ValueError(
                f"document identity missing for graph capability: {document_id}"
            )
        if str(identity.get("canonicalBookId") or "") != book_id:
            raise ValueError(f"graph capability bookId mismatches identity: {book_id}")
        identity_metadata = identity.get("metadata") or {}
        if identity_metadata.get("qmdCorpusRegistered") is not True:
            raise ValueError(
                f"document identity is not registered in qmd corpus: {document_id}"
            )
        if str(identity.get("sourceId") or "") != source_id:
            raise ValueError(f"graph capability sourceId mismatches identity: {source_id}")
        if str(identity.get("contentHash") or "") != content_hash:
            raise ValueError(
                f"graph capability contentHash mismatches identity: {content_hash}"
            )
        graph_document_id = identity.get("graphDocumentId")
        graph_text_unit_ids = identity.get("graphTextUnitIds")
        if not isinstance(graph_document_id, str) or not graph_document_id:
            raise ValueError(
                f"document identity missing graphDocumentId: {document_id}"
            )
        if not isinstance(graph_text_unit_ids, list) or not graph_text_unit_ids:
            raise ValueError(
                f"document identity missing graphTextUnitIds: {document_id}"
            )


def _capability_identity_failure(
    root_dir: Path,
    capability: dict[str, Any],
) -> str | None:
    book_id = str(capability.get("bookId") or "")
    source_id = str(capability.get("sourceId") or "")
    document_id = str(capability.get("documentId") or "")
    content_hash = str(capability.get("contentHash") or "")
    identity = _load_document_identity_map(root_dir).get(document_id)
    if identity is None:
        return f"document identity missing for graph capability: {document_id}"
    if str(identity.get("canonicalBookId") or "") != book_id:
        return f"graph capability bookId mismatches identity: {book_id}"
    identity_metadata = identity.get("metadata") or {}
    if identity_metadata.get("qmdCorpusRegistered") is not True:
        return f"document identity is not registered in qmd corpus: {document_id}"
    if str(identity.get("sourceId") or "") != source_id:
        return f"graph capability sourceId mismatches identity: {source_id}"
    if str(identity.get("contentHash") or "") != content_hash:
        return f"graph capability contentHash mismatches identity: {content_hash}"
    graph_document_id = identity.get("graphDocumentId")
    graph_text_unit_ids = identity.get("graphTextUnitIds")
    if not isinstance(graph_document_id, str) or not graph_document_id:
        return f"document identity missing graphDocumentId: {document_id}"
    if not isinstance(graph_text_unit_ids, list) or not graph_text_unit_ids:
        return f"document identity missing graphTextUnitIds: {document_id}"
    return None


def _validate_index_scope(root_dir: Path, index_scope: dict[str, Any] | None) -> None:
    if not index_scope:
        return

    book_id = str(index_scope.get("bookId") or "")
    source_id = str(index_scope.get("sourceId") or "")
    document_id = str(index_scope.get("documentId") or "")
    content_hash = str(index_scope.get("contentHash") or "")
    artifact_ids = {
        str(item)
        for item in index_scope.get("artifactIds") or []
        if item is not None and str(item)
    }

    if not book_id or not source_id or not document_id or not content_hash:
        raise ValueError("indexScope requires bookId, sourceId, documentId, and contentHash")

    identity = _load_document_identity_map(root_dir).get(document_id)
    if identity is None:
        raise ValueError(f"indexScope document identity is missing: {document_id}")
    if str(identity.get("canonicalBookId") or "") != book_id:
        raise ValueError(f"indexScope bookId mismatches document identity: {book_id}")
    if str(identity.get("sourceId") or "") != source_id:
        raise ValueError(f"indexScope sourceId mismatches document identity: {source_id}")
    if str(identity.get("contentHash") or "") != content_hash:
        raise ValueError(
            f"indexScope contentHash mismatches document identity: {content_hash}"
        )

    if artifact_ids:
        ready_artifact_ids = set(
            _load_query_ready_lineage_artifact_ids(root_dir, book_id) or []
        )
        if ready_artifact_ids and not artifact_ids.issubset(ready_artifact_ids):
            raise ValueError("indexScope artifactIds outside query-ready artifact scope")


def _load_graph_capabilities(
    root_dir: Path,
    graph_capability_ids: list[str],
) -> list[dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    requested_ids = {str(item) for item in graph_capability_ids if str(item)}
    capability_path = root_dir / "catalog" / "graph-capabilities.yaml"
    explicit_items: list[dict[str, Any]] = []
    derived_items: list[dict[str, Any]] = []
    derivation_errors: dict[str, Exception] = {}
    graph_query_requested_ids = {
        capability_id
        for capability_id in requested_ids
        if capability_id.endswith(":graph_query")
    }

    if capability_path.exists():
        catalog = yaml.safe_load(capability_path.read_text(encoding="utf-8")) or {}
        explicit_items = [
            item
            for item in catalog.get("items", [])
            if isinstance(item, dict)
        ]

    books = _load_books_by_id(root_dir)
    if not capability_path.exists() and not books:
        raise FileNotFoundError(
            f"missing graph capability catalog for scoped query: {capability_path}"
        )

    identity_by_book = _load_document_identity_map_by_book(root_dir)
    for capability_id in graph_query_requested_ids:
        book_id = capability_id.removesuffix(":graph_query")
        book = books.get(book_id)
        if book is None:
            derivation_errors[capability_id] = ValueError(
                "capabilityScope references unknown or not-ready graphCapabilityId(s): "
                + capability_id
            )
            continue
        try:
            derived_items.append(
                _derive_graph_query_capability(root_dir, book, identity_by_book)
            )
        except Exception as error:  # noqa: BLE001
            derivation_errors[capability_id] = error

    items_by_id = {
        str(item.get("capabilityId") or ""): item
        for item in explicit_items
        if str(item.get("capabilityId") or "") and
        str(item.get("capabilityId") or "") not in graph_query_requested_ids
    }
    if derivation_errors:
        raise next(iter(derivation_errors.values()))
    for item in derived_items:
        capability_id = str(item.get("capabilityId") or "")
        if capability_id:
            items_by_id[capability_id] = item
    items = list(items_by_id.values())

    capabilities = []
    for item in items:
        if str(item.get("capabilityId")) not in requested_ids:
            continue
        if item.get("ready") is not True:
            continue
        book_id = str(item.get("bookId") or "")
        artifact_ids = [str(value) for value in item.get("artifactIds") or []]
        lineage_artifact_ids = _load_query_ready_lineage_artifact_ids(
            root_dir,
            book_id,
        ) or []
        identity_failure = _capability_identity_failure(root_dir, item)
        if identity_failure is not None:
            raise ValueError(identity_failure)
        if (
            not book_id
            or not artifact_ids
            or not set(artifact_ids).issubset(set(lineage_artifact_ids))
            or not _validate_query_ready_artifacts(
            root_dir,
            book_id,
            lineage_artifact_ids,
            )
        ):
            continue
        item = {
            **item,
            "artifactIds": lineage_artifact_ids,
            "metadata": {
                **(item.get("metadata") or {}),
                "lineageProjectionSource": (
                    "validated_checkpoint_plus_validated_manifest"
                ),
            },
        }
        capabilities.append(item)
    resolved_ids = {str(item.get("capabilityId")) for item in capabilities}
    missing = sorted(requested_ids - resolved_ids)
    if missing:
        for capability_id in missing:
            if capability_id in derivation_errors:
                raise derivation_errors[capability_id]
        raise ValueError(
            "capabilityScope references unknown or not-ready graphCapabilityId(s): "
            + ", ".join(missing)
        )

    return capabilities


def _load_query_ready_artifact_ids(root_dir: Path, book_id: str) -> list[str] | None:
    projection = _project_query_ready_lineage(root_dir, book_id)
    if projection is None:
        return None
    return _query_ready_gate_artifact_ids(
        projection["artifactsById"],
        book_id,
        projection["expectedProducerRunIds"],
        [
            str(item)
            for item in projection["checkpointByStage"]["query_ready"].get(
                "artifactIds",
                [],
            )
            if item is not None
        ],
    ) or None


def _load_query_ready_lineage_artifact_ids(
    root_dir: Path,
    book_id: str,
) -> list[str] | None:
    projection = _project_query_ready_lineage(root_dir, book_id)
    if projection is None:
        return None
    return projection["artifactIds"] or None


def _validate_query_ready_artifacts(
    root_dir: Path,
    book_id: str,
    artifact_ids: list[str],
) -> bool:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    checkpoints_path = _book_state_yaml_path(root_dir, book_id, "checkpoints.yaml")
    artifacts_path = _book_state_yaml_path(root_dir, book_id, "artifacts.yaml")
    if not checkpoints_path.exists() or not artifacts_path.exists():
        return False

    book = _load_books_by_id(root_dir).get(book_id)
    if not isinstance(book, dict):
        return False
    stage_fingerprints = book.get("stageFingerprints")
    provider_fingerprint = book.get("providerFingerprint")
    corpus_content_hash = book.get("normalizedContentHash") or book.get("sourceHash")
    if not isinstance(stage_fingerprints, dict) or not isinstance(
        provider_fingerprint,
        str,
    ):
        return False
    if not isinstance(corpus_content_hash, str) or not corpus_content_hash:
        return False

    projection = _project_query_ready_lineage(root_dir, book_id)
    if projection is None:
        return False
    checkpoint_by_stage = projection["checkpointByStage"]
    expected_producer_run_ids = projection["expectedProducerRunIds"]
    if not all(isinstance(value, str) and value for value in expected_producer_run_ids.values()):
        return False
    for stage in ("graph_extract", "community_report", "embed", "query_ready"):
        checkpoint = checkpoint_by_stage.get(stage)
        if not isinstance(checkpoint, dict):
            return False
        if checkpoint.get("contentHash") != corpus_content_hash:
            return False
        if checkpoint.get("stageFingerprint") != stage_fingerprints.get(stage):
            return False
        if checkpoint.get("providerFingerprint") != provider_fingerprint:
            return False

    lineage_artifact_ids = set(projection["artifactIds"])
    if not artifact_ids or not set(artifact_ids).issubset(lineage_artifact_ids):
        return False

    by_id = projection["artifactsById"]
    selected = [by_id.get(artifact_id) for artifact_id in artifact_ids]
    if any(item is None for item in selected):
        return False

    for stage, required_kinds in QUERY_READY_PRODUCER_REQUIRED_KINDS.items():
        producer_checkpoint = checkpoint_by_stage.get(stage) or {}
        producer_artifact_ids = _artifact_ids_for_producer_stage(
            by_id,
            book_id,
            stage,
            str(producer_checkpoint.get("runId") or "") or None,
            required_kinds,
            [
                str(item)
                for item in producer_checkpoint.get("artifactIds", [])
                if item is not None
            ],
        )
        if not _validate_artifact_subset(
            root_dir,
            book_id,
            producer_artifact_ids,
            by_id,
            required_kinds,
            required_kinds,
            stage_fingerprints,
            provider_fingerprint,
            corpus_content_hash,
            {stage: str(producer_checkpoint.get("runId") or "")},
        ):
            return False

    query_ready_checkpoint = checkpoint_by_stage.get("query_ready") or {}
    query_ready_artifact_ids = _query_ready_gate_artifact_ids(
        by_id,
        book_id,
        expected_producer_run_ids,
        [
            str(item)
            for item in query_ready_checkpoint.get("artifactIds", [])
            if item is not None
        ],
    )
    if not _validate_artifact_subset(
        root_dir,
        book_id,
        query_ready_artifact_ids,
        by_id,
        QUERY_READY_ARTIFACT_KINDS,
        QUERY_READY_ARTIFACT_KINDS,
        stage_fingerprints,
        provider_fingerprint,
        corpus_content_hash,
        expected_producer_run_ids,
    ):
        return False

    return _validate_artifact_subset(
        root_dir,
        book_id,
        artifact_ids,
        by_id,
        QUERY_READY_LINEAGE_ARTIFACT_KINDS,
        QUERY_READY_LINEAGE_ARTIFACT_KINDS,
        stage_fingerprints,
        provider_fingerprint,
        corpus_content_hash,
        expected_producer_run_ids,
    )


def _validate_artifact_subset(
    root_dir: Path,
    book_id: str,
    artifact_ids: list[str],
    artifacts_by_id: dict[str, dict[str, Any]],
    required_kinds: set[str],
    allowed_kinds: set[str],
    stage_fingerprints: dict[str, Any],
    provider_fingerprint: str,
    corpus_content_hash: str,
    expected_producer_run_ids: dict[str, str],
) -> bool:
    if not artifact_ids:
        return False
    selected = [artifacts_by_id.get(artifact_id) for artifact_id in artifact_ids]
    if any(item is None for item in selected):
        return False

    kinds = set()
    for artifact in selected:
        assert artifact is not None
        if artifact.get("bookId") != book_id:
            return False
        kind = str(artifact.get("kind"))
        if kind not in allowed_kinds:
            return False
        expected_stage = PRODUCER_STAGE_BY_ARTIFACT_KIND.get(kind)
        if expected_stage is not None and artifact.get("stage") != expected_stage:
            return False
        expected_run_id = expected_producer_run_ids.get(str(artifact.get("stage")))
        if expected_run_id is not None and artifact.get("producerRunId") != expected_run_id:
            return False
        expected_stage_fingerprint = stage_fingerprints.get(str(artifact.get("stage")))
        if artifact.get("stageFingerprint") != expected_stage_fingerprint:
            return False
        if artifact.get("providerFingerprint") != provider_fingerprint:
            return False
        metadata = artifact.get("metadata")
        if not isinstance(metadata, dict):
            return False
        if metadata.get("corpusContentHash") != corpus_content_hash:
            return False
        kinds.add(str(artifact.get("kind")))
        path = artifact.get("path")
        if not isinstance(path, str):
            return False
        portable_path = _normalize_vault_relative_path(path)
        if portable_path is None:
            return False
        expected_prefixes = (
            f"books/{book_id}/graphrag/output/",
            f"books/{book_id}/output/",
        )
        if kind == "lancedb_index":
            if portable_path not in {
                f"books/{book_id}/graphrag/output/lancedb",
                f"books/{book_id}/output/lancedb",
            }:
                return False
        elif not portable_path.startswith(expected_prefixes):
            return False
        artifact_path = (root_dir / portable_path).resolve()
        try:
            artifact_path.relative_to(root_dir.resolve())
        except ValueError:
            return False
        if not artifact_path.exists():
            return False
        expected_hash = artifact.get("contentHash")
        if not isinstance(expected_hash, str) or not expected_hash:
            return False
        actual_hash = (
            _hash_lancedb_directory_contents(artifact_path)
            if kind == "lancedb_index"
            else _hash_directory_contents(artifact_path)
            if artifact_path.is_dir()
            else _hash_file(artifact_path)
        )
        if actual_hash != expected_hash:
            return False
        if kind.endswith("_parquet") and not _is_valid_parquet_file(artifact_path):
            return False
        if kind == "lancedb_index" and not _is_complete_lancedb_directory(
            artifact_path
        ):
            return False

    return required_kinds.issubset(kinds)


def _is_valid_parquet_file(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        size = path.stat().st_size
        if size < 12:
            return False
        with path.open("rb") as handle:
            header = handle.read(4)
            handle.seek(size - 4)
            footer = handle.read(4)
        if header != b"PAR1" or footer != b"PAR1":
            return False
        try:
            import pyarrow.parquet as pq  # type: ignore

            metadata = pq.ParquetFile(path).metadata
            return metadata is not None and metadata.num_rows > 0
        except Exception:  # noqa: BLE001
            return False
    except OSError:
        return False


def _load_artifacts_by_id(root_dir: Path, book_ids: list[str]) -> dict[str, dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    artifacts_by_id: dict[str, dict[str, Any]] = {}
    for book_id in book_ids:
        path = _book_state_yaml_path(root_dir, book_id, "artifacts.yaml")
        if not path.exists():
            continue
        payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for item in payload.get("items", []):
            if isinstance(item, dict) and item.get("artifactId"):
                artifacts_by_id[str(item["artifactId"])] = item
    return artifacts_by_id


def _artifact_id_for_kind(
    artifact_ids: list[str],
    artifacts_by_id: dict[str, dict[str, Any]],
    kinds: set[str],
) -> str:
    for artifact_id in artifact_ids:
        artifact = artifacts_by_id.get(artifact_id)
        if artifact is not None and str(artifact.get("kind")) in kinds:
            return artifact_id
    raise ValueError(
        "GraphRAG evidence has no scoped artifactId for required artifact kind"
    )


def _context_id_set(context_data: Any, preferred_keys: list[str]) -> set[str]:
    ids: set[str] = set()
    if isinstance(context_data, dict):
        for key in preferred_keys:
            for record in _dataframe_records(context_data.get(key)):
                for field in ("id", "text_unit_id", "source_id"):
                    value = record.get(field)
                    if value is not None and str(value):
                        ids.add(str(value))
    return ids


def _quote_for_text_unit(
    scoped_frames: dict[str, Any],
    graph_text_unit_id: str,
) -> str | None:
    text_units = scoped_frames.get("text_units")
    if text_units is None or "id" not in text_units.columns:
        return None
    matches = text_units.loc[text_units["id"].astype(str) == graph_text_unit_id]
    if matches.empty:
        return None
    for field in ("text", "chunk", "content"):
        if field in matches.columns:
            value = matches.iloc[0].get(field)
            if value is not None:
                text = str(value).strip()
                return text[:1200] if text else None
    return None


def _build_graphrag_evidence(
    root_dir: Path,
    method: str,
    context_data: Any,
    scoped_frames: dict[str, Any],
    evidence_scope: list[dict[str, Any]],
    scoped_capabilities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    capability_by_book = {
        str(capability.get("bookId")): capability
        for capability in scoped_capabilities
        if capability.get("bookId")
    }
    artifacts_by_id = _load_artifacts_by_id(root_dir, list(capability_by_book.keys()))
    contextual_text_unit_ids = _context_id_set(
        context_data,
        ["text_units", "sources", "source", "context_data"],
    )
    evidence: list[dict[str, Any]] = []
    used_keys: set[tuple[str, str]] = set()

    for item in evidence_scope:
        book_id = str(item["bookId"])
        capability = capability_by_book.get(book_id)
        if capability is None:
            raise ValueError(f"GraphRAG evidence has no capability for book: {book_id}")
        graph_text_unit_ids = [str(value) for value in item.get("graphTextUnitIds") or []]
        selected_text_unit_ids = [
            value for value in graph_text_unit_ids if value in contextual_text_unit_ids
        ] if contextual_text_unit_ids else graph_text_unit_ids
        if not selected_text_unit_ids:
            selected_text_unit_ids = graph_text_unit_ids

        artifact_ids = [str(value) for value in capability.get("artifactIds") or []]
        artifact_id = _artifact_id_for_kind(
            artifact_ids,
            artifacts_by_id,
            {"graphrag_community_reports_parquet", "graphrag_text_units_parquet"},
        )

        for graph_text_unit_id in selected_text_unit_ids:
            key = (str(capability["capabilityId"]), graph_text_unit_id)
            if key in used_keys:
                continue
            used_keys.add(key)
            evidence.append(
                {
                    "evidenceId": f"{capability['capabilityId']}:{graph_text_unit_id}",
                    "graphCapabilityId": str(capability["capabilityId"]),
                    "sourceId": str(item["sourceId"]),
                    "documentId": str(item["documentId"]),
                    "bookId": book_id,
                    "contentHash": str(item["contentHash"]),
                    "chunkId": None,
                    "graphTextUnitId": graph_text_unit_id,
                    "artifactId": artifact_id,
                    "locator": {"path": str(item["normalizedPath"])},
                    "quote": _quote_for_text_unit(scoped_frames, graph_text_unit_id),
                    "metadata": {
                        "method": method,
                        "capabilityId": str(capability["capabilityId"]),
                        "artifactIds": artifact_ids,
                        "scope": "graph_text_unit",
                        "normalizedPath": str(item["normalizedPath"]),
                    },
                }
            )
    if not evidence:
        raise ValueError("GraphRAG query produced no scoped evidence")
    return evidence


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_directory_contents(root_dir: Path) -> str:
    payload = [
        {
            "hash": _hash_file(path),
            "path": path.relative_to(root_dir).as_posix(),
        }
        for path in sorted(item for item in root_dir.rglob("*") if item.is_file())
    ]
    data = json.dumps(_stable_json(payload), separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _hash_lancedb_directory_contents(root_dir: Path) -> str:
    files: list[Path] = []
    for table_name in REQUIRED_LANCEDB_TABLES:
        table_dir = root_dir / table_name
        data_dir = table_dir / "data"
        files.extend(sorted(data_dir.glob("*.lance")))
        files.append(table_dir / "qmd_row_count.json")
    payload = [
        {
            "hash": _hash_file(path),
            "path": path.relative_to(root_dir).as_posix(),
        }
        for path in sorted(files)
    ]
    data = json.dumps(_stable_json(payload), separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _stable_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _stable_json(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_stable_json(item) for item in value]
    return value


def _is_complete_lancedb_directory(path: Path) -> bool:
    if not path.is_dir():
        return False
    for table_name in REQUIRED_LANCEDB_TABLES:
        table_dir = path / table_name
        data_dir = table_dir / "data"
        if not data_dir.is_dir():
            return False
        data_files = sorted(data_dir.glob("*.lance"))
        non_empty_data_files = [
            item for item in data_files if item.is_file() and item.stat().st_size > 0
        ]
        if not non_empty_data_files:
            return False
        if not _has_positive_lancedb_row_count(table_dir):
            return False
    return True


def _has_positive_lancedb_row_count(table_dir: Path) -> bool:
    sidecar_rows = _read_lancedb_row_count_sidecar(table_dir)
    return sidecar_rows is not None and sidecar_rows > 0


def _read_lancedb_row_count_sidecar(table_dir: Path) -> int | None:
    path = table_dir / "qmd_row_count.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if isinstance(payload, int):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("rowCount"), int):
        return int(payload["rowCount"])
    return None


def _resolve_capability_scoped_book_ids(
    root_dir: Path,
    selected_book_ids: list[str],
    graph_capability_ids: list[str],
) -> tuple[list[str], list[dict[str, Any]]]:
    selected_books = {str(item) for item in selected_book_ids if str(item)}
    capabilities = _load_graph_capabilities(root_dir, graph_capability_ids)
    scoped_book_ids = sorted({
        str(capability.get("bookId"))
        for capability in capabilities
        if capability.get("bookId")
    })
    if not scoped_book_ids:
        raise ValueError("capabilityScope did not resolve any graph capability bookId")

    out_of_scope = [book_id for book_id in scoped_book_ids if book_id not in selected_books]
    if out_of_scope:
        raise ValueError(
            "graphCapabilityIds resolve outside selectedBookIds: "
            + ", ".join(out_of_scope)
        )

    return scoped_book_ids, capabilities


def _filter_graphrag_frames_for_scope(
    root_dir: Path,
    dfs: dict[str, Any],
    selected_book_ids: list[str],
    capabilities: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    book_scope = _load_book_scope(root_dir, selected_book_ids)
    scope_by_book_id = {item["bookId"]: item for item in book_scope}
    for capability in capabilities or []:
        book_id = str(capability.get("bookId") or "")
        if book_id not in scope_by_book_id:
            continue
        scope_by_book_id[book_id].update({
            "sourceId": capability.get("sourceId")
                or scope_by_book_id[book_id].get("sourceId"),
            "qmdDocumentId": capability.get("documentId")
                or scope_by_book_id[book_id].get("qmdDocumentId"),
            "contentHash": capability.get("contentHash")
                or scope_by_book_id[book_id].get("contentHash"),
            "artifactIds": capability.get("artifactIds") or [],
        })
    requested_graph_document_ids = {str(item["graphDocumentId"]) for item in book_scope}
    documents = dfs.get("documents")
    if documents is None or "id" not in documents.columns:
        raise ValueError("GraphRAG scoped query requires documents output")

    filtered_documents = documents.loc[
        documents["id"].astype(str).isin(requested_graph_document_ids)
    ].copy()
    if filtered_documents.empty:
        raise ValueError(
            "capabilityScope did not match any GraphRAG document ids: "
            + ", ".join(sorted(requested_graph_document_ids))
        )

    document_ids = {str(item) for item in filtered_documents["id"].tolist()}
    selected_text_unit_ids: set[str] = set()
    for item in book_scope:
        selected_text_unit_ids.update(
            str(value)
            for value in item.get("graphTextUnitIds") or []
            if str(value)
        )
    if "text_unit_ids" in filtered_documents.columns:
        for value in filtered_documents["text_unit_ids"].tolist():
            selected_text_unit_ids.update(_value_id_set(value))

    scoped = {**dfs, "documents": filtered_documents}
    text_units = dfs.get("text_units")
    if text_units is not None:
        filtered_text_units = text_units.loc[
            text_units["document_id"].astype(str).isin(document_ids)
        ].copy()
        if filtered_text_units.empty:
            raise ValueError("capabilityScope did not match any GraphRAG text units")
        scoped["text_units"] = filtered_text_units
        selected_text_unit_ids.update(
            str(item) for item in filtered_text_units["id"].tolist()
        )

    if not selected_text_unit_ids:
        raise ValueError("capabilityScope has no resolvable GraphRAG text unit ids")

    selected_entity_ids: set[str] = set()
    entities = dfs.get("entities")
    if entities is not None:
        filtered_entities = entities.loc[
            _series_intersects(entities["text_unit_ids"], selected_text_unit_ids)
        ].copy()
        scoped["entities"] = filtered_entities
        selected_entity_ids.update(str(item) for item in filtered_entities["id"].tolist())

    selected_relationship_ids: set[str] = set()
    relationships = dfs.get("relationships")
    if relationships is not None:
        filtered_relationships = relationships.loc[
            _series_intersects(relationships["text_unit_ids"], selected_text_unit_ids)
        ].copy()
        scoped["relationships"] = filtered_relationships
        selected_relationship_ids.update(
            str(item) for item in filtered_relationships["id"].tolist()
        )

    selected_community_ids: set[str] = set()
    communities = dfs.get("communities")
    if communities is not None:
        community_mask = _series_intersects(
            communities["text_unit_ids"],
            selected_text_unit_ids,
        )
        if selected_entity_ids and "entity_ids" in communities.columns:
            community_mask = community_mask | _series_intersects(
                communities["entity_ids"],
                selected_entity_ids,
            )
        if selected_relationship_ids and "relationship_ids" in communities.columns:
            community_mask = community_mask | _series_intersects(
                communities["relationship_ids"],
                selected_relationship_ids,
            )
        filtered_communities = communities.loc[community_mask].copy()
        if filtered_communities.empty:
            raise ValueError("capabilityScope did not match any GraphRAG communities")
        scoped["communities"] = filtered_communities
        selected_community_ids.update(
            str(item) for item in filtered_communities["community"].tolist()
        )

    community_reports = dfs.get("community_reports")
    if community_reports is not None:
        if not selected_community_ids:
            raise ValueError(
                "capabilityScope cannot filter community reports without communities"
            )
        filtered_reports = community_reports.loc[
            community_reports["community"].astype(str).isin(selected_community_ids)
        ].copy()
        if filtered_reports.empty:
            raise ValueError(
                "capabilityScope did not match any GraphRAG community reports"
            )
        scoped["community_reports"] = filtered_reports

    if scoped.get("entities") is not None and scoped["entities"].empty:
        raise ValueError("capabilityScope did not match any GraphRAG entities")
    if scoped.get("relationships") is not None and scoped["relationships"].empty:
        raise ValueError("capabilityScope did not match any GraphRAG relationships")

    evidence_scope = []
    for item in book_scope:
        document_id = str(item["graphDocumentId"])
        if document_id not in document_ids:
            raise ValueError(
                f"book {item['bookId']} did not resolve to a GraphRAG document"
            )
        public_item = {
            key: value
            for key, value in item.items()
            if key != "graphTextUnitIds"
        }
        item_text_units = [
            str(value)
            for value in item.get("graphTextUnitIds") or []
            if str(value) in selected_text_unit_ids
        ]
        if not item_text_units:
            raise ValueError(
                f"book {item['bookId']} did not resolve to GraphRAG text units"
            )
        evidence_scope.append(
            {
                **public_item,
                "graphDocumentId": document_id,
                "documentId": item.get("qmdDocumentId") or document_id,
                "graphTextUnitIds": item_text_units,
            }
        )
    return scoped, evidence_scope


async def _run_graphrag_query(request: dict[str, Any]) -> dict[str, Any]:
    runtime_metrics = QueryRuntimeMetricsRecorder()

    with runtime_metrics.measure("bridge.resolve_runtime_environment"):
        environment = request.get("environment") or {}
        graphrag_repo = _resolve_repo_path(
            environment.get("graphragRepoPath"),
            DEFAULT_GRAPHRAG_REPO,
        )
        _add_monorepo_package_paths(graphrag_repo)
        _register_qmd_completion_providers()

    with runtime_metrics.measure("bridge.import_graphrag_runtime"):
        from graphrag.cli.query import (  # type: ignore
            _resolve_output_files,
        )
        from graphrag.config.load_config import load_config  # type: ignore
        import graphrag.api as api  # type: ignore

    with runtime_metrics.measure("bridge.parse_query_request"):
        root_dir = Path(request["rootDir"]).resolve()
        data_dir = request.get("dataDir")
        report_dir = request.get("reportDir")
        method = request["method"]
        query = request["query"]
        response_type = request["responseType"]
        capability_scope = request.get("capabilityScope") or {}
        selected_book_ids = capability_scope.get("selectedBookIds") or []
        graph_capability_ids = capability_scope.get("graphCapabilityIds") or []
        if not selected_book_ids or not graph_capability_ids:
            raise ValueError("graphrag query requires a non-empty capabilityScope")
        community_level = request.get("communityLevel")
        dynamic_community_selection = bool(
            request.get("dynamicCommunitySelection", False)
        )
        include_runtime_metrics = bool(request.get("includeRuntimeMetrics", False))
        verbose = bool(request.get("verbose", False))

    with runtime_metrics.measure("bridge.validate_capability_scope"):
        scoped_book_ids, scoped_capabilities = _resolve_capability_scoped_book_ids(
            root_dir,
            selected_book_ids,
            graph_capability_ids,
        )
        _validate_capabilities_against_request_scope(
            root_dir,
            capability_scope,
            scoped_capabilities,
        )

    with runtime_metrics.measure("bridge.prepare_query_runtime"):
        _ensure_graphrag_prompt_assets(root_dir)
        query_report_dir = _resolve_query_report_dir(
            root_dir,
            report_dir,
            scoped_book_ids,
        )
        cli_overrides = _scoped_storage_overrides(
            output_dir=data_dir,
            report_dir=str(query_report_dir),
        )
        query_log_path = query_report_dir / "query.log"
        query_log_start_offset = (
            query_log_offset(query_log_path)
            if include_runtime_metrics
            else None
        )

    with runtime_metrics.measure("graphrag.load_config"):
        config = load_config(root_dir=root_dir, cli_overrides=cli_overrides)
    evidence_scope: list[dict[str, Any]]

    if method == "global":
        with runtime_metrics.measure("graphrag.resolve_output_files"):
            dfs = _resolve_output_files(
                config=config,
                output_list=[
                    "documents",
                    "entities",
                    "communities",
                    "community_reports",
                ],
                optional_list=[],
            )
        with runtime_metrics.measure("graphrag.filter_capability_scope"):
            dfs, evidence_scope = _filter_graphrag_frames_for_scope(
                root_dir,
                dfs,
                scoped_book_ids,
                scoped_capabilities,
            )
        with runtime_metrics.measure("graphrag.search"):
            response, context_data = await api.global_search(
                config=config,
                entities=dfs["entities"],
                communities=dfs["communities"],
                community_reports=dfs["community_reports"],
                community_level=community_level,
                dynamic_community_selection=dynamic_community_selection,
                response_type=response_type,
                query=query,
                verbose=verbose,
            )
    elif method == "local":
        with runtime_metrics.measure("graphrag.resolve_output_files"):
            dfs = _resolve_output_files(
                config=config,
                output_list=[
                    "documents",
                    "communities",
                    "community_reports",
                    "text_units",
                    "relationships",
                    "entities",
                ],
                optional_list=["covariates"],
            )
        with runtime_metrics.measure("graphrag.filter_capability_scope"):
            dfs, evidence_scope = _filter_graphrag_frames_for_scope(
                root_dir,
                dfs,
                scoped_book_ids,
                scoped_capabilities,
            )
        with runtime_metrics.measure("graphrag.search"):
            response, context_data = await api.local_search(
                config=config,
                entities=dfs["entities"],
                communities=dfs["communities"],
                community_reports=dfs["community_reports"],
                text_units=dfs["text_units"],
                relationships=dfs["relationships"],
                covariates=dfs["covariates"],
                community_level=community_level or 2,
                response_type=response_type,
                query=query,
                verbose=verbose,
            )
    elif method == "drift":
        with runtime_metrics.measure("graphrag.resolve_output_files"):
            dfs = _resolve_output_files(
                config=config,
                output_list=[
                    "documents",
                    "communities",
                    "community_reports",
                    "text_units",
                    "relationships",
                    "entities",
                ],
                optional_list=[],
            )
        with runtime_metrics.measure("graphrag.filter_capability_scope"):
            dfs, evidence_scope = _filter_graphrag_frames_for_scope(
                root_dir,
                dfs,
                scoped_book_ids,
                scoped_capabilities,
            )
        with runtime_metrics.measure("graphrag.search"):
            response, context_data = await api.drift_search(
                config=config,
                entities=dfs["entities"],
                communities=dfs["communities"],
                community_reports=dfs["community_reports"],
                text_units=dfs["text_units"],
                relationships=dfs["relationships"],
                community_level=community_level or 2,
                response_type=response_type,
                query=query,
                verbose=verbose,
            )
    elif method == "basic":
        with runtime_metrics.measure("graphrag.resolve_output_files"):
            dfs = _resolve_output_files(
                config=config,
                output_list=["documents", "text_units"],
                optional_list=[],
            )
        with runtime_metrics.measure("graphrag.filter_capability_scope"):
            dfs, evidence_scope = _filter_graphrag_frames_for_scope(
                root_dir,
                dfs,
                scoped_book_ids,
                scoped_capabilities,
            )
        with runtime_metrics.measure("graphrag.search"):
            response, context_data = await api.basic_search(
                config=config,
                text_units=dfs["text_units"],
                response_type=response_type,
                query=query,
                verbose=verbose,
            )
    else:
        raise ValueError(f"unsupported graphrag query method: {method}")

    with runtime_metrics.measure("graphrag.build_evidence"):
        evidence = _build_graphrag_evidence(
            root_dir,
            method,
            context_data,
            dfs,
            evidence_scope,
            scoped_capabilities,
        )

    provider_detail = {
        "provider": "graphrag",
        "method": method,
    }
    if include_runtime_metrics:
        provider_detail["runtimeMetrics"] = runtime_metrics.report(
            query_log_path=query_log_path,
            query_log_start_offset=query_log_start_offset,
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "method": method,
        "responseText": str(response),
        "evidence": evidence,
        "providerDetail": provider_detail,
    }


async def _run_graphrag_index(request: dict[str, Any]) -> dict[str, Any]:
    environment = request.get("environment") or {}
    graphrag_repo = _resolve_repo_path(
        environment.get("graphragRepoPath"),
        DEFAULT_GRAPHRAG_REPO,
    )
    _add_monorepo_package_paths(graphrag_repo)
    _register_qmd_completion_providers()

    import graphrag.api as api  # type: ignore
    from graphrag.config.load_config import load_config  # type: ignore
    from graphrag.index.validate_config import validate_config_names  # type: ignore

    _install_graphrag_text_unit_context_compat_patch()

    root_dir = Path(request["rootDir"]).resolve()
    input_dir = request.get("inputDir")
    data_dir = request.get("dataDir")
    report_dir = request.get("reportDir")
    if not report_dir:
        raise ValueError("GraphRAG index request requires reportDir")
    method = request["method"]
    verbose = bool(request.get("verbose", False))
    skip_validation = bool(request.get("skipValidation", False))
    workflows = request.get("workflows")
    index_scope = request.get("indexScope")
    _validate_index_scope(
        root_dir,
        index_scope if isinstance(index_scope, dict) else None,
    )

    _ensure_graphrag_prompt_assets(root_dir)

    cli_overrides = _scoped_storage_overrides(
        input_dir=input_dir,
        output_dir=data_dir,
        report_dir=report_dir,
    )
    if workflows:
        cli_overrides["workflows"] = workflows

    config = load_config(root_dir=root_dir, cli_overrides=cli_overrides)
    if not skip_validation:
        validate_config_names(config)
    outputs = await api.build_index(
        config=config,
        method=method,
        is_update_run=method.endswith("-update"),
        verbose=verbose,
    )

    response_outputs = []
    for output in outputs:
        state = getattr(output, "state", None)
        if hasattr(state, "keys"):
            state_keys = [str(item) for item in state.keys()]
        else:
            state_keys = []

        response_output = {
            "workflow": str(output.workflow),
            "hasError": output.error is not None,
            "stateKeys": state_keys,
        }
        if output.error:
            response_output["errorMessage"] = str(output.error)

        result_summary = _summarize_result(output.result)
        if result_summary is not None:
            response_output["resultSummary"] = result_summary

        response_outputs.append(response_output)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "method": method,
        "outputs": response_outputs,
    }


def _run_dspy_optimize_query_prompt(request: dict[str, Any]) -> dict[str, Any]:
    environment = request.get("environment") or {}
    dspy_repo_path = environment.get("dspyRepoPath")

    script_path = REPO_ROOT / "finetune" / "experiments" / "gepa" / "dspy_gepa.py"
    if not script_path.exists():
        raise FileNotFoundError(f"missing DSPy optimization script: {script_path}")

    command = [
        environment.get("pythonBin") or sys.executable,
        str(script_path),
        "--input",
        request["trainsetPath"],
        "--model",
        request["model"],
    ]

    provider = request.get("provider") or {}
    if provider.get("apiKeyEnv"):
        command.extend(["--api-key-env", provider["apiKeyEnv"]])
    if provider.get("baseUrlEnv"):
        command.extend(["--base-url-env", provider["baseUrlEnv"]])
    if provider.get("endpoint"):
        command.extend(["--responses-endpoint", provider["endpoint"]])
    if provider.get("reasoningEffort"):
        command.extend(["--reasoning-effort", provider["reasoningEffort"]])
    if provider.get("stream") is not None:
        command.extend(["--responses-stream", str(provider["stream"]).lower()])

    if request.get("reflectionModel"):
        command.extend(["--reflection-model", request["reflectionModel"]])
    if request.get("maxTokens") is not None:
        command.extend(["--max-tokens", str(request["maxTokens"])])
    if request.get("reflectionMaxTokens") is not None:
        command.extend(
            ["--reflection-max-tokens", str(request["reflectionMaxTokens"])]
        )
    if request.get("auto"):
        command.extend(["--auto", request["auto"]])
    if request.get("maxFullEvals") is not None:
        command.extend(["--max-full-evals", str(request["maxFullEvals"])])
    if request.get("maxMetricCalls") is not None:
        command.extend(["--max-metric-calls", str(request["maxMetricCalls"])])
    if request.get("valsetPath"):
        command.extend(["--valset", request["valsetPath"]])
    if request.get("limit") is not None:
        command.extend(["--limit", str(request["limit"])])
    if request.get("valLimit") is not None:
        command.extend(["--val-limit", str(request["valLimit"])])
    if request.get("savePromptPath"):
        command.extend(["--save-prompt", request["savePromptPath"]])
    if request.get("emitPath"):
        command.extend(["--emit", request["emitPath"]])

    env = os.environ.copy()
    python_path_parts = [part for part in [dspy_repo_path, env.get("PYTHONPATH")] if part]
    if python_path_parts:
        env["PYTHONPATH"] = os.pathsep.join(python_path_parts)

    result = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "dspy optimization failed"
        raise RuntimeError(message)

    stdout_tail = [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip()
    ][-20:]

    return {
        "schemaVersion": SCHEMA_VERSION,
        "optimizer": request["optimizer"],
        "command": command,
        "savedPromptPath": request.get("savePromptPath"),
        "emitPath": request.get("emitPath"),
        "stdoutTail": stdout_tail,
    }


def main() -> int:
    if len(sys.argv) != 2:
        return _emit_error("usage: bridge.py <graphrag_query|graphrag_index|dspy_optimize_query_prompt>")

    command = sys.argv[1]

    try:
        request = _read_request()
        if command == "graphrag_query":
            response = asyncio.run(_run_graphrag_query(request))
        elif command == "graphrag_index":
            response = asyncio.run(_run_graphrag_index(request))
        elif command == "dspy_optimize_query_prompt":
            response = _run_dspy_optimize_query_prompt(request)
        else:
            return _emit_error(f"unsupported bridge command: {command}")
    except Exception as error:  # noqa: BLE001
        return _emit_error(str(error))

    json.dump(response, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
