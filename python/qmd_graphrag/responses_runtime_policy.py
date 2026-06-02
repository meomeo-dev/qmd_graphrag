from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any


DEFAULT_RESPONSES_REQUEST_TIMEOUT_SECONDS = 120.0

_TIMEOUT_ENV_NAMES = (
    "QMD_GRAPHRAG_RESPONSES_TIMEOUT_SECONDS",
    "QMD_RESPONSES_REQUEST_TIMEOUT_SECONDS",
)
_RETRY_MAX_RETRIES_ENV_NAMES = (
    "QMD_GRAPHRAG_RESPONSES_RETRY_MAX_RETRIES",
    "QMD_RESPONSES_RETRY_MAX_RETRIES",
)
_RETRY_BASE_DELAY_ENV_NAMES = (
    "QMD_GRAPHRAG_RESPONSES_RETRY_BASE_DELAY",
    "QMD_RESPONSES_RETRY_BASE_DELAY",
)
_RETRY_MAX_DELAY_ENV_NAMES = (
    "QMD_GRAPHRAG_RESPONSES_RETRY_MAX_DELAY",
    "QMD_RESPONSES_RETRY_MAX_DELAY",
)
_RETRY_JITTER_ENV_NAMES = (
    "QMD_GRAPHRAG_RESPONSES_RETRY_JITTER",
    "QMD_RESPONSES_RETRY_JITTER",
)


def _first_env(
    env: Mapping[str, str],
    names: tuple[str, ...],
) -> str | None:
    for name in names:
        value = env.get(name)
        if value not in {None, ""}:
            return value
    return None


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _positive_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _bool_value(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def _env_or_config(
    env: Mapping[str, str],
    names: tuple[str, ...],
    configured: Any,
) -> Any:
    env_value = _first_env(env, names)
    return env_value if env_value is not None else configured


def responses_request_timeout(
    configured_timeout: Any,
    *,
    env: Mapping[str, str] = os.environ,
) -> Any:
    if configured_timeout is not None:
        return configured_timeout
    return _positive_float(
        _first_env(env, _TIMEOUT_ENV_NAMES),
        DEFAULT_RESPONSES_REQUEST_TIMEOUT_SECONDS,
    )


def responses_max_concurrency(configured_limit: Any, *, default: int) -> int:
    return _positive_int(configured_limit, default)


def responses_retry_policy_values(
    call_args: Mapping[str, Any],
    *,
    default_max_retries: int,
    default_base_delay: float,
    default_max_delay: float,
    default_jitter: bool,
    env: Mapping[str, str] = os.environ,
) -> dict[str, Any]:
    return {
        "max_retries": _positive_int(
            _env_or_config(
                env,
                _RETRY_MAX_RETRIES_ENV_NAMES,
                call_args.get("qmd_responses_retry_max_retries"),
            ),
            default_max_retries,
        ),
        "base_delay": _positive_float(
            _env_or_config(
                env,
                _RETRY_BASE_DELAY_ENV_NAMES,
                call_args.get("qmd_responses_retry_base_delay"),
            ),
            default_base_delay,
        ),
        "max_delay": _positive_float(
            _env_or_config(
                env,
                _RETRY_MAX_DELAY_ENV_NAMES,
                call_args.get("qmd_responses_retry_max_delay"),
            ),
            default_max_delay,
        ),
        "jitter": _bool_value(
            _env_or_config(
                env,
                _RETRY_JITTER_ENV_NAMES,
                call_args.get("qmd_responses_retry_jitter"),
            ),
            default_jitter,
        ),
    }
