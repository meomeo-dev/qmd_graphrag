from __future__ import annotations

import asyncio
import random
import re
import time
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from collections.abc import AsyncIterator, Iterator, Sequence
from threading import BoundedSemaphore, Lock
from typing import Any, cast

from openai import AsyncOpenAI, OpenAI
from openai.types.chat.chat_completion import Choice
from openai.types.chat.chat_completion_chunk import Choice as ChunkChoice
from openai.types.chat.chat_completion_chunk import ChoiceDelta
from openai.types.chat.chat_completion_message import ChatCompletionMessage
from openai.types.completion_usage import CompletionUsage
from pydantic import BaseModel

from graphrag_llm.completion.completion import LLMCompletion
from graphrag_llm.middleware import with_middleware_pipeline
from graphrag_llm.types import (
    LLMCompletionArgs,
    LLMCompletionChunk,
    LLMCompletionMessagesParam,
    LLMCompletionResponse,
    LLMChoice,
    Metrics,
    ResponseFormat,
)
from graphrag_llm.utils import structure_completion_response


_RESPONSE_STREAM_FAILURE_EVENT_TYPES = {
    "error",
    "response.failed",
    "response.incomplete",
}

# GraphRAG's completion middleware currently accepts OpenAI chat-shaped
# `LLMCompletionResponse` objects. qmd_graphrag still calls only the OpenAI
# Responses API; these constants are a private compatibility projection for the
# upstream GraphRAG completion interface, not an invocation of Chat Completions.
_GRAPHRAG_COMPLETION_RESPONSE_OBJECT = "chat.completion"
_GRAPHRAG_COMPLETION_CHUNK_OBJECT = "chat.completion.chunk"
_GRAPHRAG_COMPLETION_MIDDLEWARE_REQUEST_TYPE = "chat"
_DEFAULT_RESPONSES_MAX_CONCURRENCY = 5
_DEFAULT_RESPONSES_RETRY_MAX_RETRIES = 12
_DEFAULT_RESPONSES_RETRY_BASE_DELAY = 2.0
_DEFAULT_RESPONSES_RETRY_MAX_DELAY = 120.0
_DEFAULT_RESPONSES_RETRY_JITTER = True
_TRANSIENT_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_TRANSIENT_MESSAGE_FRAGMENTS = (
    "concurrency limit",
    "rate limit",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "connection error",
    "connection reset",
    "server error",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "(408)",
    "(409)",
    "(425)",
    "(429)",
    "(500)",
    "(502)",
    "(503)",
    "(504)",
)
_RESPONSES_GATE_LOCK = Lock()
_RESPONSES_GATES: dict[tuple[str, str, int], "_ResponsesConcurrencyGate"] = {}


class OpenAIResponsesTransientError(RuntimeError):
    def __init__(
        self,
        *,
        message: str,
        kind: str = "transient",
        status_code: int | None = None,
    ) -> None:
        self.kind = kind
        self.status_code = status_code
        status = status_code if status_code is not None else "unknown"
        safe_message = _sanitize_error_message(message)
        super().__init__(
            f"Responses API transient error kind={kind} "
            f"status_code={status}: {safe_message}"
        )


def _normalize_api_base(api_base: str | None) -> str | None:
    if not api_base:
        return api_base
    return api_base.rstrip("/")


def _normalize_messages(
    messages: LLMCompletionMessagesParam,
) -> tuple[str | None, list[dict[str, Any]] | str]:
    if isinstance(messages, str):
        return None, messages

    normalized: list[dict[str, Any]] = []
    instructions: list[str] = []

    for message in messages:
        item = dict(message)
        role = item.get("role", "user")
        content = item.get("content", "")

        if isinstance(content, list):
            text_parts: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(str(part.get("text", "")))
                else:
                    text_parts.append(str(part))
            content = "\n".join(part for part in text_parts if part)
        else:
            content = str(content)

        if role in {"system", "developer"}:
            instructions.append(content)
        else:
            normalized.append({
                "type": "message",
                "role": role,
                "content": content,
            })

    instructions_text = "\n\n".join(part for part in instructions if part) or None
    if not normalized:
        normalized = [{
            "type": "message",
            "role": "user",
            "content": "",
        }]

    return instructions_text, normalized


def _schema_type_includes_object(schema_type: Any) -> bool:
    if schema_type == "object":
        return True
    return isinstance(schema_type, list) and "object" in schema_type


def _make_strict_response_schema(schema: dict[str, Any]) -> dict[str, Any]:
    strict_schema = deepcopy(schema)

    def visit(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return

        if _schema_type_includes_object(node.get("type")) or "properties" in node:
            node["additionalProperties"] = False

        for value in node.values():
            visit(value)

    visit(strict_schema)
    return strict_schema


def _build_response_text_config(
    *,
    response_format: type[BaseModel] | None,
    response_format_json_object: bool,
) -> dict[str, Any] | None:
    if response_format is not None:
        schema = _make_strict_response_schema(response_format.model_json_schema())
        return {
            "format": {
                "type": "json_schema",
                "name": response_format.__name__,
                "schema": schema,
                "strict": True,
            }
        }

    if response_format_json_object:
        raise ValueError(
            "response_format_json_object is not supported; use a strict "
            "response_format model for Responses API structured output."
        )

    return None


def _extract_usage(response: Any) -> CompletionUsage:
    usage = getattr(response, "usage", None)
    if usage is None:
        return CompletionUsage(
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
        )

    prompt_tokens = int(getattr(usage, "input_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    total_tokens = int(getattr(usage, "total_tokens", 0) or 0)

    return CompletionUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _create_completion_response(
    *,
    response: Any,
    model: str,
    output_text: str | None = None,
) -> LLMCompletionResponse:
    text = (
        output_text
        if output_text is not None
        else getattr(response, "output_text", "") or ""
    )
    created = int(getattr(response, "created_at", 0) or 0)
    response_id = str(getattr(response, "id", "responses-completion"))

    choice: LLMChoice = Choice(
        finish_reason="stop",
        index=0,
        logprobs=None,
        message=ChatCompletionMessage(
            role="assistant",
            content=text,
        ),
    )

    return LLMCompletionResponse(
        id=response_id,
        object=_GRAPHRAG_COMPLETION_RESPONSE_OBJECT,
        created=created,
        model=model,
        choices=[choice],
        usage=_extract_usage(response),
        formatted_response=None,
    )


def _create_completion_chunk(
    *,
    content: str,
    model: str,
    response_id: str,
    created: int,
    finish_reason: str | None = None,
) -> LLMCompletionChunk:
    return LLMCompletionChunk(
        id=response_id,
        object=_GRAPHRAG_COMPLETION_CHUNK_OBJECT,
        created=created,
        model=model,
        choices=[
            ChunkChoice(
                delta=ChoiceDelta(
                    role="assistant",
                    content=content,
                ),
                finish_reason=finish_reason,
                index=0,
                logprobs=None,
            )
        ],
    )


def _event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def _stream_error_message(event: Any) -> str:
    message = getattr(event, "message", None)
    if message:
        return str(message)

    response = getattr(event, "response", None)
    error = getattr(response, "error", None)
    if error is None:
        return f"Responses API stream ended with event: {_event_type(event)}"

    error_message = getattr(error, "message", None)
    if error_message:
        return str(error_message)
    return str(error)


def _sanitize_error_message(message: Any) -> str:
    text = str(message)
    replacements = [
        (r"(?i)(api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]"),
        (r"(?i)(base[_-]?url)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]"),
        (r"https?://[^\s,;)]+", "[redacted-url]"),
        (r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b", "[redacted-key]"),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    return text


def _stream_error_status_code(event: Any) -> int | None:
    for candidate in (
        getattr(event, "status_code", None),
        getattr(event, "code", None),
    ):
        try:
            parsed = int(candidate)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed

    response = getattr(event, "response", None)
    error = getattr(response, "error", None)
    for candidate in (
        getattr(response, "status_code", None),
        getattr(error, "status_code", None),
        getattr(error, "code", None),
    ):
        try:
            parsed = int(candidate)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed

    return None


def _raise_stream_failure(event: Any) -> None:
    message = _stream_error_message(event)
    status_code = _stream_error_status_code(event)
    error = OpenAIResponsesTransientError(
        message=message,
        status_code=status_code,
    )
    if _is_transient_responses_error(error):
        raise error
    raise RuntimeError(message)


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


class _ResponsesRetryPolicy:
    def __init__(
        self,
        *,
        max_retries: int = _DEFAULT_RESPONSES_RETRY_MAX_RETRIES,
        base_delay: float = _DEFAULT_RESPONSES_RETRY_BASE_DELAY,
        max_delay: float = _DEFAULT_RESPONSES_RETRY_MAX_DELAY,
        jitter: bool = _DEFAULT_RESPONSES_RETRY_JITTER,
    ) -> None:
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.jitter = jitter

    def sleep_seconds(self, attempt: int) -> float:
        delay = min(self.max_delay, self.base_delay * (2 ** max(0, attempt - 1)))
        if self.jitter:
            delay += random.uniform(0, min(1.0, delay * 0.1))  # noqa: S311
        return min(self.max_delay, delay)


class _ResponsesConcurrencyGate:
    def __init__(self, limit: int) -> None:
        self._sync = BoundedSemaphore(limit)
        self._async = asyncio.BoundedSemaphore(limit)

    @contextmanager
    def sync_slot(self) -> Iterator[None]:
        self._sync.acquire()
        try:
            yield
        finally:
            self._sync.release()

    @asynccontextmanager
    async def async_slot(self) -> AsyncIterator[None]:
        await self._async.acquire()
        try:
            yield
        finally:
            self._async.release()


def _responses_gate_for(
    *,
    api_base: str | None,
    model: str,
    limit: int,
) -> _ResponsesConcurrencyGate:
    key = (api_base or "", model, limit)
    with _RESPONSES_GATE_LOCK:
        gate = _RESPONSES_GATES.get(key)
        if gate is None:
            gate = _ResponsesConcurrencyGate(limit)
            _RESPONSES_GATES[key] = gate
        return gate


def _is_transient_responses_error(error: BaseException) -> bool:
    status_code = getattr(error, "status_code", None)
    if isinstance(status_code, int) and status_code in _TRANSIENT_STATUS_CODES:
        return True

    message = str(error).lower()
    if any(fragment in message for fragment in _TRANSIENT_MESSAGE_FRAGMENTS):
        return True

    body = getattr(error, "body", None)
    if body is not None:
        body_message = str(body).lower()
        return any(
            fragment in body_message
            for fragment in _TRANSIENT_MESSAGE_FRAGMENTS
        )

    return False


def _retry_exhausted_message(error: BaseException, attempts: int) -> str:
    return (
        f"Responses API transient failure after {attempts} attempts: "
        f"{type(error).__name__}: {_sanitize_error_message(error)}"
    )


def _run_with_responses_recovery(
    func: Any,
    *,
    gate: _ResponsesConcurrencyGate,
    retry_policy: _ResponsesRetryPolicy,
) -> Any:
    attempts = retry_policy.max_retries + 1
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            with gate.sync_slot():
                return func()
        except Exception as error:
            if not _is_transient_responses_error(error):
                raise
            last_error = error
            if attempt >= attempts:
                raise RuntimeError(_retry_exhausted_message(error, attempt)) from error
            time.sleep(retry_policy.sleep_seconds(attempt))

    if last_error is not None:
        raise RuntimeError(_retry_exhausted_message(last_error, attempts)) from last_error
    raise RuntimeError("unreachable Responses API retry state")


async def _run_with_responses_recovery_async(
    func: Any,
    *,
    gate: _ResponsesConcurrencyGate,
    retry_policy: _ResponsesRetryPolicy,
) -> Any:
    attempts = retry_policy.max_retries + 1
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            async with gate.async_slot():
                return await func()
        except Exception as error:
            if not _is_transient_responses_error(error):
                raise
            last_error = error
            if attempt >= attempts:
                raise RuntimeError(_retry_exhausted_message(error, attempt)) from error
            await asyncio.sleep(retry_policy.sleep_seconds(attempt))

    if last_error is not None:
        raise RuntimeError(_retry_exhausted_message(last_error, attempts)) from last_error
    raise RuntimeError("unreachable Responses API retry state")


def _completed_response_output_text(response: Any) -> str:
    return str(getattr(response, "output_text", "") or "")


def _collect_response_stream(
    stream: Iterator[Any],
    *,
    model: str,
) -> LLMCompletionResponse:
    text_parts: list[str] = []
    completed_response: Any | None = None

    for event in stream:
        event_type = _event_type(event)
        if event_type == "response.output_text.delta":
            text_parts.append(str(getattr(event, "delta", "") or ""))
            continue
        if event_type == "response.output_text.done":
            text = getattr(event, "text", None)
            if text and not text_parts:
                text_parts.append(str(text))
            continue
        if event_type == "response.completed":
            completed_response = getattr(event, "response", None)
            continue
        if event_type in _RESPONSE_STREAM_FAILURE_EVENT_TYPES:
            _raise_stream_failure(event)

    output_text = "".join(text_parts)
    if completed_response is not None:
        final_text = _completed_response_output_text(completed_response)
        return _create_completion_response(
            response=completed_response,
            model=model,
            output_text=final_text or output_text,
        )

    return _create_completion_response(
        response=None,
        model=model,
        output_text=output_text,
    )


async def _collect_response_stream_async(
    stream: AsyncIterator[Any],
    *,
    model: str,
) -> LLMCompletionResponse:
    text_parts: list[str] = []
    completed_response: Any | None = None

    async for event in stream:
        event_type = _event_type(event)
        if event_type == "response.output_text.delta":
            text_parts.append(str(getattr(event, "delta", "") or ""))
            continue
        if event_type == "response.output_text.done":
            text = getattr(event, "text", None)
            if text and not text_parts:
                text_parts.append(str(text))
            continue
        if event_type == "response.completed":
            completed_response = getattr(event, "response", None)
            continue
        if event_type in _RESPONSE_STREAM_FAILURE_EVENT_TYPES:
            _raise_stream_failure(event)

    output_text = "".join(text_parts)
    if completed_response is not None:
        final_text = _completed_response_output_text(completed_response)
        return _create_completion_response(
            response=completed_response,
            model=model,
            output_text=final_text or output_text,
        )

    return _create_completion_response(
        response=None,
        model=model,
        output_text=output_text,
    )


def _iter_response_chunks(
    stream: Iterator[Any],
    *,
    model: str,
) -> Iterator[LLMCompletionChunk]:
    response_id = "responses-completion"
    created = 0

    for event in stream:
        response = getattr(event, "response", None)
        if response is not None:
            response_id = str(getattr(response, "id", response_id))
            created = int(getattr(response, "created_at", created) or created)

        event_type = _event_type(event)
        if event_type == "response.output_text.delta":
            delta = str(getattr(event, "delta", "") or "")
            if delta:
                yield _create_completion_chunk(
                    content=delta,
                    model=model,
                    response_id=response_id,
                    created=created,
                )
            continue
        if event_type == "response.completed":
            yield _create_completion_chunk(
                content="",
                model=model,
                response_id=response_id,
                created=created,
                finish_reason="stop",
            )
            continue
        if event_type in _RESPONSE_STREAM_FAILURE_EVENT_TYPES:
            _raise_stream_failure(event)


async def _iter_response_chunks_async(
    stream: AsyncIterator[Any],
    *,
    model: str,
) -> AsyncIterator[LLMCompletionChunk]:
    response_id = "responses-completion"
    created = 0

    async for event in stream:
        response = getattr(event, "response", None)
        if response is not None:
            response_id = str(getattr(response, "id", response_id))
            created = int(getattr(response, "created_at", created) or created)

        event_type = _event_type(event)
        if event_type == "response.output_text.delta":
            delta = str(getattr(event, "delta", "") or "")
            if delta:
                yield _create_completion_chunk(
                    content=delta,
                    model=model,
                    response_id=response_id,
                    created=created,
                )
            continue
        if event_type == "response.completed":
            yield _create_completion_chunk(
                content="",
                model=model,
                response_id=response_id,
                created=created,
                finish_reason="stop",
            )
            continue
        if event_type in _RESPONSE_STREAM_FAILURE_EVENT_TYPES:
            _raise_stream_failure(event)


def _translate_call_args(kwargs: dict[str, Any]) -> dict[str, Any]:
    translated: dict[str, Any] = {}
    responses_endpoint = kwargs.pop("responses_endpoint", "/responses")
    responses_stream = kwargs.pop("responses_stream", True)
    strict_structured_output = kwargs.pop("strict_structured_output", True)

    if responses_endpoint != "/responses":
        raise ValueError("Responses API endpoint must be /responses")
    if responses_stream is not True:
        raise ValueError("Responses API stream transport must be enabled")
    if strict_structured_output is not True:
        raise ValueError("Responses API structured output must be strict")

    if "temperature" in kwargs:
        translated["temperature"] = kwargs["temperature"]
    if "top_p" in kwargs:
        translated["top_p"] = kwargs["top_p"]
    if "parallel_tool_calls" in kwargs:
        translated["parallel_tool_calls"] = kwargs["parallel_tool_calls"]
    if "user" in kwargs:
        translated["user"] = kwargs["user"]
    if "timeout" in kwargs:
        translated["timeout"] = kwargs["timeout"]
    if "extra_headers" in kwargs:
        translated["extra_headers"] = kwargs["extra_headers"]
    if "tools" in kwargs:
        translated["tools"] = kwargs["tools"]
    if "tool_choice" in kwargs:
        translated["tool_choice"] = kwargs["tool_choice"]
    if "top_logprobs" in kwargs:
        translated["top_logprobs"] = kwargs["top_logprobs"]
    if "truncation" in kwargs:
        translated["truncation"] = kwargs["truncation"]

    max_output_tokens = kwargs.get("max_output_tokens")
    if max_output_tokens is None:
        max_output_tokens = kwargs.get("max_completion_tokens")
    if max_output_tokens is None:
        max_output_tokens = kwargs.get("max_tokens")
    if max_output_tokens is not None:
        translated["max_output_tokens"] = max_output_tokens

    reasoning_effort = kwargs.get("reasoning_effort")
    if reasoning_effort is not None:
        translated["reasoning"] = {"effort": reasoning_effort}

    return translated


class OpenAIResponsesCompletion(LLMCompletion):
    _model_config: Any
    _model_id: str
    _metrics_store: Any
    _metrics_processor: Any
    _tokenizer: Any
    _completion: Any
    _completion_async: Any
    _track_metrics: bool = False

    def __init__(
        self,
        *,
        model_id: str,
        model_config: Any,
        tokenizer: Any,
        metrics_store: Any,
        metrics_processor: Any = None,
        rate_limiter: Any = None,
        retrier: Any = None,
        cache: Any = None,
        cache_key_creator: Any = None,
        **_: Any,
    ) -> None:
        self._model_id = model_id
        self._model_config = model_config
        self._tokenizer = tokenizer
        self._metrics_store = metrics_store
        self._metrics_processor = metrics_processor
        self._track_metrics = metrics_processor is not None

        base_url = _normalize_api_base(model_config.api_base)
        client = OpenAI(
            api_key=model_config.api_key,
            base_url=base_url,
        )
        async_client = AsyncOpenAI(
            api_key=model_config.api_key,
            base_url=base_url,
        )

        model_name = model_config.azure_deployment_name or model_config.model
        call_args_config = dict(model_config.call_args or {})
        retry_policy = _ResponsesRetryPolicy(
            max_retries=_positive_int(
                call_args_config.get("qmd_responses_retry_max_retries"),
                _DEFAULT_RESPONSES_RETRY_MAX_RETRIES,
            ),
            base_delay=_positive_float(
                call_args_config.get("qmd_responses_retry_base_delay"),
                _DEFAULT_RESPONSES_RETRY_BASE_DELAY,
            ),
            max_delay=_positive_float(
                call_args_config.get("qmd_responses_retry_max_delay"),
                _DEFAULT_RESPONSES_RETRY_MAX_DELAY,
            ),
            jitter=_bool_value(
                call_args_config.get("qmd_responses_retry_jitter"),
                _DEFAULT_RESPONSES_RETRY_JITTER,
            ),
        )
        concurrency_gate = _responses_gate_for(
            api_base=base_url,
            model=model_name,
            limit=_positive_int(
                call_args_config.get("qmd_responses_max_concurrency"),
                _DEFAULT_RESPONSES_MAX_CONCURRENCY,
            ),
        )

        def _base_completion(
            **kwargs: Any,
        ) -> LLMCompletionResponse | Iterator[LLMCompletionChunk]:
            kwargs.pop("metrics", None)
            response_format = kwargs.pop("response_format", None)
            response_format_json_object = bool(
                kwargs.pop("response_format_json_object", False)
            )
            stream = bool(kwargs.pop("stream", False))

            messages = cast(LLMCompletionMessagesParam, kwargs.pop("messages"))
            instructions, input_payload = _normalize_messages(messages)
            text_config = _build_response_text_config(
                response_format=response_format,
                response_format_json_object=response_format_json_object,
            )
            call_args = _translate_call_args({
                **model_config.call_args,
                **kwargs,
            })

            create_args: dict[str, Any] = {
                "model": model_name,
                "input": input_payload,
                "instructions": instructions,
                "text": text_config,
                "stream": True,
                **call_args,
            }
            if stream:
                def collect_chunks() -> list[LLMCompletionChunk]:
                    response_stream = client.responses.create(
                        **{k: v for k, v in create_args.items() if v is not None},
                    )
                    return list(
                        _iter_response_chunks(response_stream, model=model_name)
                    )

                chunks = _run_with_responses_recovery(
                    collect_chunks,
                    gate=concurrency_gate,
                    retry_policy=retry_policy,
                )
                return iter(chunks)

            def collect_response() -> LLMCompletionResponse:
                response_stream = client.responses.create(
                    **{k: v for k, v in create_args.items() if v is not None},
                )
                return _collect_response_stream(response_stream, model=model_name)

            return _run_with_responses_recovery(
                collect_response,
                gate=concurrency_gate,
                retry_policy=retry_policy,
            )

        async def _base_completion_async(
            **kwargs: Any,
        ) -> LLMCompletionResponse | AsyncIterator[LLMCompletionChunk]:
            kwargs.pop("metrics", None)
            response_format = kwargs.pop("response_format", None)
            response_format_json_object = bool(
                kwargs.pop("response_format_json_object", False)
            )
            stream = bool(kwargs.pop("stream", False))

            messages = cast(LLMCompletionMessagesParam, kwargs.pop("messages"))
            instructions, input_payload = _normalize_messages(messages)
            text_config = _build_response_text_config(
                response_format=response_format,
                response_format_json_object=response_format_json_object,
            )
            call_args = _translate_call_args({
                **model_config.call_args,
                **kwargs,
            })

            create_args: dict[str, Any] = {
                "model": model_name,
                "input": input_payload,
                "instructions": instructions,
                "text": text_config,
                "stream": True,
                **call_args,
            }
            if stream:
                async def collect_chunks() -> list[LLMCompletionChunk]:
                    response_stream = await async_client.responses.create(
                        **{k: v for k, v in create_args.items() if v is not None},
                    )
                    chunks: list[LLMCompletionChunk] = []
                    async for chunk in _iter_response_chunks_async(
                        response_stream,
                        model=model_name,
                    ):
                        chunks.append(chunk)
                    return chunks

                chunks = await _run_with_responses_recovery_async(
                    collect_chunks,
                    gate=concurrency_gate,
                    retry_policy=retry_policy,
                )

                async def replay_chunks() -> AsyncIterator[LLMCompletionChunk]:
                    for chunk in chunks:
                        yield chunk

                return replay_chunks()

            async def collect_response() -> LLMCompletionResponse:
                response_stream = await async_client.responses.create(
                    **{k: v for k, v in create_args.items() if v is not None},
                )
                return await _collect_response_stream_async(
                    response_stream,
                    model=model_name,
                )

            return await _run_with_responses_recovery_async(
                collect_response,
                gate=concurrency_gate,
                retry_policy=retry_policy,
            )

        self._completion, self._completion_async = with_middleware_pipeline(
            model_config=self._model_config,
            model_fn=_base_completion,
            async_model_fn=_base_completion_async,
            request_type=_GRAPHRAG_COMPLETION_MIDDLEWARE_REQUEST_TYPE,
            cache=cache,
            cache_key_creator=cache_key_creator,
            tokenizer=self._tokenizer,
            metrics_processor=self._metrics_processor,
            rate_limiter=rate_limiter,
            retrier=retrier,
        )

    def completion(
        self,
        /,
        **kwargs: LLMCompletionArgs[ResponseFormat],
    ) -> LLMCompletionResponse[ResponseFormat] | Iterator[LLMCompletionChunk]:
        request_metrics: Metrics | None = kwargs.pop("metrics", None) or {}
        if not self._track_metrics:
            request_metrics = None

        response_format = kwargs.get("response_format")

        try:
            response = self._completion(
                metrics=request_metrics,
                **kwargs,
            )
            if (
                isinstance(response, LLMCompletionResponse)
                and response_format is not None
                and response.formatted_response is None
            ):
                response.formatted_response = structure_completion_response(
                    response.content,
                    response_format,
                )
            return response
        finally:
            if request_metrics is not None:
                self._metrics_store.update_metrics(metrics=request_metrics)

    async def completion_async(
        self,
        /,
        **kwargs: LLMCompletionArgs[ResponseFormat],
    ) -> LLMCompletionResponse[ResponseFormat] | AsyncIterator[LLMCompletionChunk]:
        request_metrics: Metrics | None = kwargs.pop("metrics", None) or {}
        if not self._track_metrics:
            request_metrics = None

        response_format = kwargs.get("response_format")

        try:
            response = await self._completion_async(
                metrics=request_metrics,
                **kwargs,
            )
            if (
                isinstance(response, LLMCompletionResponse)
                and response_format is not None
                and response.formatted_response is None
            ):
                response.formatted_response = structure_completion_response(
                    response.content,
                    response_format,
                )
            return response
        finally:
            if request_metrics is not None:
                self._metrics_store.update_metrics(metrics=request_metrics)

    @property
    def metrics_store(self) -> Any:
        return self._metrics_store

    @property
    def tokenizer(self) -> Any:
        return self._tokenizer
