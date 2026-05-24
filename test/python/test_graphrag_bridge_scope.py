from __future__ import annotations

import asyncio
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path
import sys
import hashlib
import json

import pandas as pd
import yaml
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))

from qmd_graphrag.bridge import _filter_graphrag_frames_for_scope
from qmd_graphrag.bridge import _build_graphrag_evidence
from qmd_graphrag.bridge import (
    _hash_lancedb_directory_contents as _bridge_hash_lancedb_directory_contents,
)
from qmd_graphrag.bridge import _is_complete_lancedb_directory
from qmd_graphrag.bridge import _resolve_capability_scoped_book_ids
from qmd_graphrag.bridge import _run_graphrag_index
from qmd_graphrag.bridge import _validate_index_scope
from qmd_graphrag.bridge import _validate_capabilities_against_request_scope
import qmd_graphrag.bridge as bridge_module


def _write_books(root: Path) -> None:
    catalog = root / "catalog"
    catalog.mkdir(parents=True)
    (catalog / "books.yaml").write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "1.0.0",
                "items": [
                    {
                        "bookId": "book-1",
                        "sourceHash": "source-1",
                        "normalizedContentHash": "content-1",
                        "metadata": {"normalizedPath": "input/book-one.md"},
                    },
                    {
                        "bookId": "book-2",
                        "sourceHash": "source-2",
                        "normalizedContentHash": "content-2",
                        "metadata": {"normalizedPath": "input/book-two.md"},
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    (catalog / "graph-capabilities.yaml").write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "1.0.0",
                "items": [
                    {
                        "schemaVersion": "1.0.0",
                        "capabilityId": "book-1:graph_query",
                        "kind": "graph_query",
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "ready": True,
                        "readinessSource": "validated_checkpoint_plus_validated_manifest",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                        "createdAt": "2026-05-21T00:00:00.000Z",
                    },
                    {
                        "schemaVersion": "1.0.0",
                        "capabilityId": "book-2:graph_query",
                        "kind": "graph_query",
                        "bookId": "book-2",
                        "sourceId": "sha256:source-2",
                        "documentId": "doc-2",
                        "contentHash": "content-2",
                        "ready": True,
                        "readinessSource": "validated_checkpoint_plus_validated_manifest",
                        "artifactIds": ["artifact-2", "artifact-2-lancedb"],
                        "createdAt": "2026-05-21T00:00:00.000Z",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    (catalog / "document-identity-map.yaml").write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "1.0.0",
                "items": [
                    {
                        "schemaVersion": "1.0.0",
                        "sourceId": "sha256:source-1",
                        "sourceHash": "source-1",
                        "canonicalBookId": "book-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "normalizationPolicyVersion": "test-v1",
                        "chunkIds": [],
                        "graphDocumentId": "doc-1",
                        "graphTextUnitIds": ["tu-1"],
                    },
                    {
                        "schemaVersion": "1.0.0",
                        "sourceId": "sha256:source-2",
                        "sourceHash": "source-2",
                        "canonicalBookId": "book-2",
                        "documentId": "doc-2",
                        "contentHash": "content-2",
                        "normalizationPolicyVersion": "test-v1",
                        "chunkIds": [],
                        "graphDocumentId": "doc-2",
                        "graphTextUnitIds": ["tu-2"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    _write_query_ready_state(root, "book-1", "artifact-1")
    _write_query_ready_state(root, "book-2", "artifact-2")


def _write_query_ready_state(root: Path, book_id: str, artifact_prefix: str) -> None:
    book_dir = root / "books" / book_id
    output_dir = book_dir / "output"
    lancedb_dir = output_dir / "lancedb"
    _write_complete_lancedb_fixture(lancedb_dir)
    reports_path = output_dir / "community_reports.parquet"
    reports_path.write_text("reports", encoding="utf-8")
    report_hash = _hash_file(reports_path)
    lancedb_hash = _bridge_hash_lancedb_directory_contents(lancedb_dir)
    artifact_ids = [artifact_prefix, f"{artifact_prefix}-lancedb"]
    (book_dir / "checkpoints.yaml").write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "1.0.0",
                "items": [
                    {
                        "schemaVersion": "1.0.0",
                        "bookId": book_id,
                        "stage": "query_ready",
                        "status": "succeeded",
                        "attemptCount": 1,
                        "inputFingerprint": "fp",
                        "artifactIds": artifact_ids,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (book_dir / "artifacts.yaml").write_text(
        yaml.safe_dump(
            {
                "schemaVersion": "1.0.0",
                "items": [
                    {
                        "schemaVersion": "1.0.0",
                        "artifactId": artifact_prefix,
                        "bookId": book_id,
                        "stage": "community_report",
                        "kind": "graphrag_community_reports_parquet",
                        "path": f"books/{book_id}/output/community_reports.parquet",
                        "contentHash": report_hash,
                        "producerRunId": "run-1",
                        "createdAt": "2026-05-21T00:00:00.000Z",
                    },
                    {
                        "schemaVersion": "1.0.0",
                        "artifactId": f"{artifact_prefix}-lancedb",
                        "bookId": book_id,
                        "stage": "embed",
                        "kind": "lancedb_index",
                        "path": f"books/{book_id}/output/lancedb",
                        "contentHash": lancedb_hash,
                        "producerRunId": "run-1",
                        "createdAt": "2026-05-21T00:00:00.000Z",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def _write_complete_lancedb_fixture(root: Path) -> None:
    for table_name in [
        "entity_description.lance",
        "community_full_content.lance",
        "text_unit_text.lance",
    ]:
        table_dir = root / table_name
        data_dir = table_dir / "data"
        versions_dir = table_dir / "_versions"
        data_dir.mkdir(parents=True)
        versions_dir.mkdir(parents=True)
        (data_dir / "part-1.lance").write_text("rows", encoding="utf-8")
        (versions_dir / "1.manifest").write_text("part-1.lance", encoding="utf-8")
        (table_dir / "qmd_row_count.json").write_text(
            json.dumps({"schemaVersion": "1.0.0", "rowCount": 1}),
            encoding="utf-8",
        )


def _hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _hash_directory_contents(root: Path) -> str:
    payload = [
        {
            "hash": _hash_file(path),
            "path": path.relative_to(root).as_posix(),
        }
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    ]
    return hashlib.sha256(
        json.dumps(_stable_json(payload), separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _stable_json(value):
    if isinstance(value, dict):
        return {key: _stable_json(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_stable_json(item) for item in value]
    return value


def _frames() -> dict[str, pd.DataFrame]:
    return {
        "documents": pd.DataFrame(
            [
                {"id": "doc-1", "title": "book-one.md", "text_unit_ids": ["tu-1"]},
                {"id": "doc-2", "title": "book-two.md", "text_unit_ids": ["tu-2"]},
            ]
        ),
        "text_units": pd.DataFrame(
            [
                {"id": "tu-1", "document_id": "doc-1", "text": "one"},
                {"id": "tu-2", "document_id": "doc-2", "text": "two"},
            ]
        ),
        "entities": pd.DataFrame(
            [
                {"id": "ent-1", "text_unit_ids": ["tu-1"]},
                {"id": "ent-2", "text_unit_ids": ["tu-2"]},
            ]
        ),
        "relationships": pd.DataFrame(
            [
                {"id": "rel-1", "text_unit_ids": ["tu-1"]},
                {"id": "rel-2", "text_unit_ids": ["tu-2"]},
            ]
        ),
        "communities": pd.DataFrame(
            [
                {
                    "community": 1,
                    "text_unit_ids": ["tu-1"],
                    "entity_ids": ["ent-1"],
                    "relationship_ids": ["rel-1"],
                },
                {
                    "community": 2,
                    "text_unit_ids": ["tu-2"],
                    "entity_ids": ["ent-2"],
                    "relationship_ids": ["rel-2"],
                },
            ]
        ),
        "community_reports": pd.DataFrame(
            [
                {"id": "report-1", "community": 1},
                {"id": "report-2", "community": 2},
            ]
        ),
    }


class GraphRagBridgeScopeTest(unittest.TestCase):
    def test_graphrag_index_applies_workflows_and_skip_validation(self) -> None:
        calls: dict[str, object] = {}

        def fake_load_config(*, root_dir: Path, cli_overrides: dict[str, object]):
            calls["root_dir"] = root_dir
            calls["cli_overrides"] = cli_overrides
            return {"root_dir": root_dir, "cli_overrides": cli_overrides}

        def fake_validate_config_names(config: object) -> None:
            calls["validated"] = config

        async def fake_build_index(**kwargs: object):
            calls["build_index"] = kwargs
            output = types.SimpleNamespace(
                workflow="load_input_documents",
                error=None,
                state={"documents": object()},
                result={"ok": True},
            )
            return [output]

        modules = {
            "graphrag": types.ModuleType("graphrag"),
            "graphrag.api": types.SimpleNamespace(build_index=fake_build_index),
            "graphrag.config": types.ModuleType("graphrag.config"),
            "graphrag.config.load_config": types.SimpleNamespace(
                load_config=fake_load_config,
            ),
            "graphrag.index": types.ModuleType("graphrag.index"),
            "graphrag.index.validate_config": types.SimpleNamespace(
                validate_config_names=fake_validate_config_names,
            ),
        }
        modules["graphrag"].api = modules["graphrag.api"]

        with tempfile.TemporaryDirectory(prefix="qmd-bridge-index-") as tmp:
            root = Path(tmp)
            with (
                patch.dict(sys.modules, modules),
                patch.object(bridge_module, "_ensure_graphrag_prompt_assets"),
            ):
                response = asyncio.run(
                    _run_graphrag_index(
                        {
                            "rootDir": str(root),
                            "inputDir": str(root / "books" / "book-1" / "input"),
                            "dataDir": str(root / "books" / "book-1" / "output"),
                            "method": "standard",
                            "skipValidation": True,
                            "workflows": ["load_input_documents"],
                        }
                    )
                )

        self.assertEqual(
            calls["cli_overrides"],
            {
                "input_storage": {
                    "type": "file",
                    "base_dir": str((root / "books" / "book-1" / "input").resolve()),
                },
                "input": {
                    "type": "text",
                    "file_pattern": ".*\\.(md|markdown|txt)",
                },
                "output_storage": {
                    "type": "file",
                    "base_dir": str((root / "books" / "book-1" / "output").resolve()),
                },
                "reporting": {
                    "type": "file",
                    "base_dir": str(
                        (root / "books" / "book-1" / "output" / "reports").resolve()
                    ),
                },
                "cache": {
                    "type": "json",
                    "storage": {
                        "type": "file",
                        "base_dir": str(
                            (root / "books" / "book-1" / "output" / "cache").resolve()
                        ),
                    },
                },
                "vector_store": {
                    "type": "lancedb",
                    "db_uri": str(
                        (root / "books" / "book-1" / "output" / "lancedb").resolve()
                    ),
                },
                "workflows": ["load_input_documents"],
            },
        )
        self.assertNotIn("validated", calls)
        self.assertEqual(calls["build_index"]["method"], "standard")
        self.assertFalse(calls["build_index"]["is_update_run"])
        self.assertEqual(response["outputs"][0]["workflow"], "load_input_documents")

    def test_lancedb_completion_requires_qmd_row_count_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-lancedb-") as tmp:
            root = Path(tmp) / "lancedb"
            _write_complete_lancedb_fixture(root)
            table_dir = root / "entity_description.lance"
            (table_dir / "qmd_row_count.json").unlink()
            (table_dir / "_versions" / "1.manifest").write_text(
                "part-1.lance rowCount: 1",
                encoding="utf-8",
            )

            self.assertFalse(_is_complete_lancedb_directory(root))

    def test_lancedb_completion_rejects_row_count_sidecar_alias(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-lancedb-") as tmp:
            root = Path(tmp) / "lancedb"
            _write_complete_lancedb_fixture(root)
            table_dir = root / "entity_description.lance"
            (table_dir / "qmd_row_count.json").rename(
                table_dir / "row_count.json",
            )

            self.assertFalse(_is_complete_lancedb_directory(root))

    def test_lancedb_completion_does_not_require_manifest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-lancedb-") as tmp:
            root = Path(tmp) / "lancedb"
            _write_complete_lancedb_fixture(root)
            for manifest in root.glob("*.lance/_versions/*.manifest"):
                manifest.unlink()

            self.assertTrue(_is_complete_lancedb_directory(root))

    def test_lancedb_canonical_hash_ignores_versions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-lancedb-") as tmp:
            root = Path(tmp) / "lancedb"
            _write_complete_lancedb_fixture(root)
            before = _bridge_hash_lancedb_directory_contents(root)
            (root / "entity_description.lance" / "_versions" / "2.manifest").write_text(
                "rewritten manifest",
                encoding="utf-8",
            )
            after = _bridge_hash_lancedb_directory_contents(root)

            self.assertEqual(after, before)

    def test_index_scope_validates_against_graph_vault_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-index-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            _validate_index_scope(
                root,
                {
                    "bookId": "book-1",
                    "sourceId": "sha256:source-1",
                    "documentId": "doc-1",
                    "contentHash": "content-1",
                    "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                },
            )

    def test_index_scope_rejects_identity_mismatch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-index-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            with self.assertRaisesRegex(ValueError, "contentHash mismatches"):
                _validate_index_scope(
                    root,
                    {
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-other",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    },
                )

    def test_filter_graphrag_frames_for_scope_keeps_only_selected_book(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            scoped, evidence_scope = _filter_graphrag_frames_for_scope(
                root,
                _frames(),
                ["book-1"],
                [
                    {
                        "capabilityId": "book-1:graph_query",
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    }
                ],
            )

            self.assertEqual(scoped["documents"]["id"].tolist(), ["doc-1"])
            self.assertEqual(scoped["text_units"]["id"].tolist(), ["tu-1"])
            self.assertEqual(scoped["entities"]["id"].tolist(), ["ent-1"])
            self.assertEqual(scoped["relationships"]["id"].tolist(), ["rel-1"])
            self.assertEqual(scoped["communities"]["community"].tolist(), [1])
            self.assertEqual(scoped["community_reports"]["id"].tolist(), ["report-1"])
            self.assertEqual(
                evidence_scope,
                [
                    {
                        "bookId": "book-1",
                        "normalizedPath": "input/book-one.md",
                        "sourceId": "sha256:source-1",
                        "contentHash": "content-1",
                        "qmdDocumentId": "doc-1",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                        "graphDocumentId": "doc-1",
                        "documentId": "doc-1",
                        "graphTextUnitIds": ["tu-1"],
                    }
                ],
            )

    def test_filter_graphrag_frames_for_scope_accepts_parquet_list_values(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            frames = _frames()
            frames["documents"].at[0, "text_unit_ids"] = np.array(["tu-1"])
            frames["communities"].at[0, "text_unit_ids"] = np.array(["tu-1"])

            scoped, _evidence_scope = _filter_graphrag_frames_for_scope(
                root,
                frames,
                ["book-1"],
                [
                    {
                        "capabilityId": "book-1:graph_query",
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    }
                ],
            )

            self.assertEqual(scoped["documents"]["id"].tolist(), ["doc-1"])
            self.assertEqual(scoped["communities"]["community"].tolist(), [1])

    def test_build_graphrag_evidence_uses_text_unit_lineage(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-evidence-") as tmp:
            root = Path(tmp)
            _write_books(root)
            frames = _frames()
            scoped, evidence_scope = _filter_graphrag_frames_for_scope(
                root,
                frames,
                ["book-1"],
                [
                    {
                        "capabilityId": "book-1:graph_query",
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    }
                ],
            )

            evidence = _build_graphrag_evidence(
                root,
                "local",
                {"text_units": pd.DataFrame([{"id": "tu-1"}])},
                scoped,
                evidence_scope,
                [
                    {
                        "capabilityId": "book-1:graph_query",
                        "bookId": "book-1",
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    }
                ],
            )

            self.assertEqual(len(evidence), 1)
            self.assertEqual(
                evidence[0]["evidenceId"],
                "book-1:graph_query:tu-1",
            )
            self.assertEqual(evidence[0]["graphTextUnitId"], "tu-1")
            self.assertEqual(evidence[0]["artifactId"], "artifact-1")
            self.assertEqual(evidence[0]["metadata"]["scope"], "graph_text_unit")
            self.assertEqual(evidence[0]["quote"], "one")

    def test_build_graphrag_evidence_rejects_missing_required_artifact_kind(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-evidence-") as tmp:
            root = Path(tmp)
            _write_books(root)
            frames = _frames()
            scoped, evidence_scope = _filter_graphrag_frames_for_scope(
                root,
                frames,
                ["book-1"],
                [
                    {
                        "capabilityId": "book-1:graph_query",
                        "bookId": "book-1",
                        "sourceId": "sha256:source-1",
                        "documentId": "doc-1",
                        "contentHash": "content-1",
                        "artifactIds": ["artifact-1-lancedb"],
                    }
                ],
            )

            with self.assertRaisesRegex(ValueError, "required artifact kind"):
                _build_graphrag_evidence(
                    root,
                    "local",
                    {"text_units": pd.DataFrame([{"id": "tu-1"}])},
                    scoped,
                    evidence_scope,
                    [
                        {
                            "capabilityId": "book-1:graph_query",
                            "bookId": "book-1",
                            "artifactIds": ["artifact-1-lancedb"],
                        }
                    ],
                )

    def test_filter_graphrag_frames_for_scope_rejects_unknown_book(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            with self.assertRaisesRegex(ValueError, "unknown bookId"):
                _filter_graphrag_frames_for_scope(root, _frames(), ["book-missing"])

    def test_filter_graphrag_frames_for_scope_rejects_unmatched_document(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            frames = _frames()
            frames["documents"] = frames["documents"].iloc[0:0]

            with self.assertRaisesRegex(
                ValueError,
                "did not match any GraphRAG document",
            ):
                _filter_graphrag_frames_for_scope(root, frames, ["book-1"])

    def test_capability_scope_reduces_selected_books_to_capability_books(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            book_ids, capabilities = _resolve_capability_scoped_book_ids(
                root,
                ["book-1", "book-2"],
                ["book-1:graph_query"],
            )

            self.assertEqual(book_ids, ["book-1"])
            self.assertEqual(capabilities[0]["capabilityId"], "book-1:graph_query")

    def test_capability_scope_derives_capability_without_explicit_catalog(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            (root / "catalog" / "graph-capabilities.yaml").unlink()

            book_ids, capabilities = _resolve_capability_scoped_book_ids(
                root,
                ["book-1", "book-2"],
                ["book-1:graph_query"],
            )

            self.assertEqual(book_ids, ["book-1"])
            self.assertEqual(capabilities[0]["capabilityId"], "book-1:graph_query")
            self.assertEqual(
                capabilities[0]["artifactIds"],
                ["artifact-1", "artifact-1-lancedb"],
            )
            self.assertEqual(capabilities[0]["sourceId"], "sha256:source-1")
            self.assertEqual(capabilities[0]["documentId"], "doc-1")
            self.assertEqual(capabilities[0]["contentHash"], "content-1")
            _validate_capabilities_against_request_scope(
                root,
                {
                    "selectedBookIds": ["book-1"],
                    "graphCapabilityIds": ["book-1:graph_query"],
                    "sourceIds": ["sha256:source-1"],
                    "documentIds": ["doc-1"],
                    "contentHashes": ["content-1"],
                    "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                },
                capabilities,
            )

    def test_capability_scope_rejects_derived_capability_without_identity(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            (root / "catalog" / "graph-capabilities.yaml").unlink()
            (root / "catalog" / "document-identity-map.yaml").unlink()

            with self.assertRaisesRegex(ValueError, "missing document identity"):
                _resolve_capability_scoped_book_ids(
                    root,
                    ["book-1"],
                    ["book-1:graph_query"],
                )

    def test_book_scope_rejects_missing_persisted_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            identity_path = root / "catalog" / "document-identity-map.yaml"
            catalog = yaml.safe_load(identity_path.read_text(encoding="utf-8"))
            catalog["items"] = [
                item for item in catalog["items"]
                if item["canonicalBookId"] != "book-1"
            ]
            identity_path.write_text(yaml.safe_dump(catalog), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "missing document identity"):
                _filter_graphrag_frames_for_scope(root, _frames(), ["book-1"])

    def test_capability_scope_rejects_capability_outside_selected_books(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)

            with self.assertRaisesRegex(ValueError, "outside selectedBookIds"):
                _resolve_capability_scoped_book_ids(
                    root,
                    ["book-1"],
                    ["book-2:graph_query"],
                )

    def test_capability_scope_rejects_identity_outside_request_scope(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            _, capabilities = _resolve_capability_scoped_book_ids(
                root,
                ["book-1"],
                ["book-1:graph_query"],
            )

            with self.assertRaisesRegex(ValueError, "documentId outside requested scope"):
                _validate_capabilities_against_request_scope(
                    root,
                    {
                        "selectedBookIds": ["book-1"],
                        "graphCapabilityIds": ["book-1:graph_query"],
                        "sourceIds": ["sha256:source-1"],
                        "documentIds": ["doc-other"],
                        "contentHashes": ["content-1"],
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    },
                    capabilities,
                )

    def test_capability_scope_requires_persisted_graph_text_units(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qmd-bridge-scope-") as tmp:
            root = Path(tmp)
            _write_books(root)
            identity_path = root / "catalog" / "document-identity-map.yaml"
            catalog = yaml.safe_load(identity_path.read_text(encoding="utf-8"))
            del catalog["items"][0]["graphTextUnitIds"]
            identity_path.write_text(yaml.safe_dump(catalog), encoding="utf-8")
            _, capabilities = _resolve_capability_scoped_book_ids(
                root,
                ["book-1"],
                ["book-1:graph_query"],
            )

            with self.assertRaisesRegex(ValueError, "missing graphTextUnitIds"):
                _validate_capabilities_against_request_scope(
                    root,
                    {
                        "selectedBookIds": ["book-1"],
                        "graphCapabilityIds": ["book-1:graph_query"],
                        "sourceIds": ["sha256:source-1"],
                        "documentIds": ["doc-1"],
                        "contentHashes": ["content-1"],
                        "artifactIds": ["artifact-1", "artifact-1-lancedb"],
                    },
                    capabilities,
                )


if __name__ == "__main__":
    unittest.main()
