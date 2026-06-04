from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


_METRICS_HEADER = re.compile(
    r"Metrics for (?P<model>[^:]+):\s*(?P<payload>\{.*?\})",
    re.DOTALL,
)
MAX_MODEL_METRIC_ROWS = 32


def _round_ms(value: float) -> float:
    return round(value * 100) / 100


def _number(value: Any, default: float = 0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _integer(value: Any) -> int:
    return int(_number(value, 0))


def _file_size(path: Path | None) -> int | None:
    if path is None or not path.exists():
        return 0 if path is not None else None
    try:
        return path.stat().st_size
    except OSError:
        return None


def query_log_offset(path: Path | None) -> int | None:
    return _file_size(path)


class QueryRuntimeMetricsRecorder:
    def __init__(self) -> None:
        self._started = time.perf_counter()
        self._stages: list[dict[str, Any]] = []

    @contextmanager
    def measure(self, name: str) -> Iterator[None]:
        started = time.perf_counter()
        try:
            yield
        except Exception:
            self._stages.append(
                {
                    "name": name,
                    "durationMs": _round_ms((time.perf_counter() - started) * 1000),
                    "status": "failed",
                }
            )
            raise
        self._stages.append(
            {
                "name": name,
                "durationMs": _round_ms((time.perf_counter() - started) * 1000),
                "status": "succeeded",
            }
        )

    def report(
        self,
        *,
        query_log_path: Path | None = None,
        query_log_start_offset: int | None = None,
    ) -> dict[str, Any]:
        raw_model_metrics = parse_query_log_metrics_slice(
            query_log_path,
            query_log_start_offset,
        )
        model_metrics = aggregate_metrics_by_model(raw_model_metrics)
        aggregate = aggregate_model_metrics(model_metrics)
        visible_model_metrics = limit_model_metrics(model_metrics)
        total_duration_ms = _round_ms((time.perf_counter() - self._started) * 1000)
        aggregate["unattributedWallDurationMs"] = _round_ms(
            max(total_duration_ms - aggregate["loggedComputeDurationMs"], 0)
        )
        return {
            "kind": "graphrag_query_runtime_metrics",
            "scope": "current_invocation"
            if query_log_path is not None and query_log_start_offset is not None
            else "unavailable",
            "totalDurationMs": total_duration_ms,
            "stages": list(self._stages),
            "modelMetrics": visible_model_metrics,
            "aggregate": aggregate,
        }


def parse_query_log_metrics_slice(
    path: Path | None,
    start_offset: int | None,
) -> list[dict[str, Any]]:
    if path is None or start_offset is None:
        return []
    try:
        with path.open("rb") as file:
            file.seek(start_offset)
            text = file.read().decode("utf-8", errors="replace")
    except OSError:
        return []

    records: list[dict[str, Any]] = []
    for match in _METRICS_HEADER.finditer(text):
        try:
            payload = json.loads(match.group("payload"))
        except json.JSONDecodeError:
            continue
        records.append(_normalize_model_metrics(match.group("model").strip(), payload))
    return records


def aggregate_metrics_by_model(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for record in records:
        model = str(record["model"])
        item = grouped.setdefault(
            model,
            {
                "model": model,
                "attemptedRequestCount": 0,
                "successfulResponseCount": 0,
                "failedResponseCount": 0,
                "requestsWithRetries": 0,
                "retryCount": 0,
                "streamingResponseCount": 0,
                "loggedComputeDurationMs": 0.0,
                "promptTokens": 0,
                "completionTokens": 0,
                "totalTokens": 0,
                "cacheHitRate": 0.0,
                "_cacheHitWeight": 0,
            },
        )
        attempted = int(record["attemptedRequestCount"])
        item["attemptedRequestCount"] += attempted
        item["successfulResponseCount"] += int(record["successfulResponseCount"])
        item["failedResponseCount"] += int(record["failedResponseCount"])
        item["requestsWithRetries"] += int(record["requestsWithRetries"])
        item["retryCount"] += int(record["retryCount"])
        item["streamingResponseCount"] += int(record["streamingResponseCount"])
        item["loggedComputeDurationMs"] += float(record["loggedComputeDurationMs"])
        item["promptTokens"] += int(record["promptTokens"])
        item["completionTokens"] += int(record["completionTokens"])
        item["totalTokens"] += int(record["totalTokens"])
        item["cacheHitRate"] += float(record["cacheHitRate"]) * attempted
        item["_cacheHitWeight"] += attempted

    result: list[dict[str, Any]] = []
    for item in grouped.values():
        cache_hit_weight = int(item.pop("_cacheHitWeight"))
        item["cacheHitRate"] = _round_ms(
            item["cacheHitRate"] / cache_hit_weight if cache_hit_weight else 0
        )
        item["loggedComputeDurationMs"] = _round_ms(
            float(item["loggedComputeDurationMs"])
        )
        result.append(item)
    return sorted(result, key=lambda value: str(value["model"]))


def limit_model_metrics(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(
        records,
        key=lambda value: (
            -int(value["attemptedRequestCount"]),
            -int(value["totalTokens"]),
            str(value["model"]),
        ),
    )
    return ranked[:MAX_MODEL_METRIC_ROWS]


def _normalize_model_metrics(model: str, payload: dict[str, Any]) -> dict[str, Any]:
    prompt_tokens = _integer(payload.get("prompt_tokens"))
    completion_tokens = _integer(payload.get("completion_tokens"))
    total_tokens = _integer(payload.get("total_tokens"))
    return {
        "model": model,
        "attemptedRequestCount": _integer(payload.get("attempted_request_count")),
        "successfulResponseCount": _integer(payload.get("successful_response_count")),
        "failedResponseCount": _integer(payload.get("failed_response_count")),
        "requestsWithRetries": _integer(payload.get("requests_with_retries")),
        "retryCount": _integer(payload.get("retries")),
        "streamingResponseCount": _integer(payload.get("streaming_responses")),
        "loggedComputeDurationMs": _round_ms(
            _number(payload.get("compute_duration_seconds")) * 1000
        ),
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "cacheHitRate": _number(payload.get("cache_hit_rate")),
    }


def aggregate_model_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "modelCount": len({record["model"] for record in records}),
        "attemptedRequestCount": sum(record["attemptedRequestCount"] for record in records),
        "successfulResponseCount": sum(
            record["successfulResponseCount"] for record in records
        ),
        "failedResponseCount": sum(record["failedResponseCount"] for record in records),
        "requestsWithRetries": sum(record["requestsWithRetries"] for record in records),
        "retryCount": sum(record["retryCount"] for record in records),
        "streamingResponseCount": sum(record["streamingResponseCount"] for record in records),
        "loggedComputeDurationMs": _round_ms(
            sum(record["loggedComputeDurationMs"] for record in records)
        ),
        "promptTokens": sum(record["promptTokens"] for record in records),
        "completionTokens": sum(record["completionTokens"] for record in records),
        "totalTokens": sum(record["totalTokens"] for record in records),
    }
