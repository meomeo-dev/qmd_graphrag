#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import hashlib
import json
import os
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

if str(REPO_ROOT / "python") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "python"))


def _emit_error(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


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


def _register_qmd_completion_providers() -> None:
    from graphrag_llm.completion import register_completion

    from qmd_graphrag.graphrag_responses_completion import (
        OpenAIResponsesCompletion,
    )

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


def _derive_graph_query_capability(
    root_dir: Path,
    book: dict[str, Any],
    identity_by_book: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    book_id = str(book.get("bookId") or "")
    if not book_id:
        raise ValueError("book state is missing bookId")
    identity = (identity_by_book or _load_document_identity_map_by_book(root_dir)).get(
        book_id,
    )
    if identity is None:
        raise ValueError(f"book {book_id} is missing document identity")
    artifact_ids = _load_query_ready_artifact_ids(root_dir, book_id) or []
    source_id = identity.get("sourceId")
    document_id = identity.get("documentId")
    content_hash = identity.get("contentHash")
    graph_document_id = identity.get("graphDocumentId")
    graph_text_unit_ids = identity.get("graphTextUnitIds")
    if not source_id or not document_id or not content_hash:
        raise ValueError(f"book {book_id} is missing graph capability identity")
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
        if str(identity.get("sourceId") or "") != source_id:
            raise ValueError(f"graph capability sourceId mismatches identity: {source_id}")
        if str(identity.get("contentHash") or "") != content_hash:
            raise ValueError(
                f"graph capability contentHash mismatches identity: {content_hash}"
            )
        if not identity.get("graphDocumentId"):
            raise ValueError(
                f"document identity missing graphDocumentId: {document_id}"
            )
        if not identity.get("graphTextUnitIds"):
            raise ValueError(
                f"document identity missing graphTextUnitIds: {document_id}"
            )


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
        ready_artifact_ids = set(_load_query_ready_artifact_ids(root_dir, book_id) or [])
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
    items: list[dict[str, Any]] = []

    if capability_path.exists():
        catalog = yaml.safe_load(capability_path.read_text(encoding="utf-8")) or {}
        items = [
            item
            for item in catalog.get("items", [])
            if isinstance(item, dict)
        ]
    else:
        books = _load_books_by_id(root_dir)
        if not books:
            raise FileNotFoundError(
                f"missing graph capability catalog for scoped query: {capability_path}"
            )
        identity_by_book = _load_document_identity_map_by_book(root_dir)
        for book in books.values():
            items.append(
                _derive_graph_query_capability(root_dir, book, identity_by_book)
            )

    capabilities = []
    for item in items:
        if str(item.get("capabilityId")) not in requested_ids:
            continue
        if item.get("ready") is not True:
            continue
        book_id = str(item.get("bookId") or "")
        artifact_ids = [str(value) for value in item.get("artifactIds") or []]
        if not book_id or not _validate_query_ready_artifacts(
            root_dir,
            book_id,
            artifact_ids,
        ):
            continue
        item = {**item, "artifactIds": artifact_ids}
        capabilities.append(item)
    resolved_ids = {str(item.get("capabilityId")) for item in capabilities}
    missing = sorted(requested_ids - resolved_ids)
    if missing:
        raise ValueError(
            "capabilityScope references unknown or not-ready graphCapabilityId(s): "
            + ", ".join(missing)
        )

    return capabilities


def _load_query_ready_artifact_ids(root_dir: Path, book_id: str) -> list[str] | None:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    checkpoints_path = root_dir / "books" / book_id / "checkpoints.yaml"
    if not checkpoints_path.exists():
        return None

    checkpoints = yaml.safe_load(checkpoints_path.read_text(encoding="utf-8")) or {}
    for checkpoint in checkpoints.get("items", []):
        if not isinstance(checkpoint, dict):
            continue
        if (
            checkpoint.get("stage") == "query_ready"
            and checkpoint.get("status") == "succeeded"
        ):
            artifact_ids = [
                str(item)
                for item in checkpoint.get("artifactIds", [])
                if item is not None
            ]
            return artifact_ids or None
    return None


def _validate_query_ready_artifacts(
    root_dir: Path,
    book_id: str,
    artifact_ids: list[str],
) -> bool:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    checkpoints_path = root_dir / "books" / book_id / "checkpoints.yaml"
    artifacts_path = root_dir / "books" / book_id / "artifacts.yaml"
    if not checkpoints_path.exists() or not artifacts_path.exists():
        return False

    checkpoint_artifact_ids = set(_load_query_ready_artifact_ids(root_dir, book_id) or [])
    if not artifact_ids or not set(artifact_ids).issubset(checkpoint_artifact_ids):
        return False

    artifacts = yaml.safe_load(artifacts_path.read_text(encoding="utf-8")) or {}
    by_id = {
        str(item.get("artifactId")): item
        for item in artifacts.get("items", [])
        if isinstance(item, dict) and item.get("artifactId")
    }
    selected = [by_id.get(artifact_id) for artifact_id in artifact_ids]
    if any(item is None for item in selected):
        return False

    required_kinds = {"graphrag_community_reports_parquet", "lancedb_index"}
    kinds = set()
    for artifact in selected:
        assert artifact is not None
        if artifact.get("bookId") != book_id:
            return False
        kinds.add(str(artifact.get("kind")))
        path = artifact.get("path")
        if not isinstance(path, str):
            return False
        artifact_path = (root_dir / path).resolve()
        try:
            artifact_path.relative_to(root_dir.resolve())
        except ValueError:
            return False
        if not artifact_path.exists():
            return False
        expected_hash = artifact.get("contentHash")
        if not isinstance(expected_hash, str) or not expected_hash:
            return False
        kind = str(artifact.get("kind"))
        actual_hash = (
            _hash_lancedb_directory_contents(artifact_path)
            if kind == "lancedb_index"
            else _hash_directory_contents(artifact_path)
            if artifact_path.is_dir()
            else _hash_file(artifact_path)
        )
        if actual_hash != expected_hash:
            return False
        if kind.endswith("_parquet") and (
            not artifact_path.is_file() or artifact_path.stat().st_size == 0
        ):
            return False
        if kind == "lancedb_index" and not _is_complete_lancedb_directory(
            artifact_path
        ):
            return False

    return required_kinds.issubset(kinds)


def _load_artifacts_by_id(root_dir: Path, book_ids: list[str]) -> dict[str, dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError("PyYAML is required to enforce GraphRAG capability scope") from error

    artifacts_by_id: dict[str, dict[str, Any]] = {}
    for book_id in book_ids:
        path = root_dir / "books" / book_id / "artifacts.yaml"
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
    environment = request.get("environment") or {}
    graphrag_repo = _resolve_repo_path(
        environment.get("graphragRepoPath"),
        DEFAULT_GRAPHRAG_REPO,
    )
    _add_monorepo_package_paths(graphrag_repo)
    _register_qmd_completion_providers()

    from graphrag.cli.query import (  # type: ignore
        _resolve_output_files,
    )
    from graphrag.config.load_config import load_config  # type: ignore
    import graphrag.api as api  # type: ignore

    root_dir = Path(request["rootDir"]).resolve()
    data_dir = request.get("dataDir")
    method = request["method"]
    query = request["query"]
    response_type = request["responseType"]
    capability_scope = request.get("capabilityScope") or {}
    selected_book_ids = capability_scope.get("selectedBookIds") or []
    graph_capability_ids = capability_scope.get("graphCapabilityIds") or []
    if not selected_book_ids or not graph_capability_ids:
        raise ValueError("graphrag query requires a non-empty capabilityScope")
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
    community_level = request.get("communityLevel")
    dynamic_community_selection = bool(
        request.get("dynamicCommunitySelection", False)
    )
    verbose = bool(request.get("verbose", False))

    _ensure_graphrag_prompt_assets(root_dir)

    cli_overrides: dict[str, Any] = {}
    if data_dir:
        cli_overrides["output_storage"] = {"base_dir": str(Path(data_dir).resolve())}

    config = load_config(root_dir=root_dir, cli_overrides=cli_overrides)
    evidence_scope: list[dict[str, Any]]

    if method == "global":
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
        dfs, evidence_scope = _filter_graphrag_frames_for_scope(
            root_dir,
            dfs,
            scoped_book_ids,
            scoped_capabilities,
        )
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
        dfs, evidence_scope = _filter_graphrag_frames_for_scope(
            root_dir,
            dfs,
            scoped_book_ids,
            scoped_capabilities,
        )
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
        dfs, evidence_scope = _filter_graphrag_frames_for_scope(
            root_dir,
            dfs,
            scoped_book_ids,
            scoped_capabilities,
        )
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
        dfs = _resolve_output_files(
            config=config,
            output_list=["documents", "text_units"],
            optional_list=[],
        )
        dfs, evidence_scope = _filter_graphrag_frames_for_scope(
            root_dir,
            dfs,
            scoped_book_ids,
            scoped_capabilities,
        )
        response, context_data = await api.basic_search(
            config=config,
            text_units=dfs["text_units"],
            response_type=response_type,
            query=query,
            verbose=verbose,
        )
    else:
        raise ValueError(f"unsupported graphrag query method: {method}")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "method": method,
        "responseText": str(response),
        "evidence": _build_graphrag_evidence(
            root_dir,
            method,
            context_data,
            dfs,
            evidence_scope,
            scoped_capabilities,
        ),
        "providerDetail": {
            "provider": "graphrag",
            "method": method,
        },
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

    root_dir = Path(request["rootDir"]).resolve()
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

    cli_overrides: dict[str, Any] = {}
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
