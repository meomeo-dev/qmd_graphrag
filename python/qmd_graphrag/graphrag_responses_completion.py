from __future__ import annotations

from copy import deepcopy
from collections.abc import AsyncIterator, Iterator, Sequence
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
        return {"format": {"type": "json_object"}}

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
        object="chat.completion",
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
        object="chat.completion.chunk",
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
            raise RuntimeError(_stream_error_message(event))

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
            raise RuntimeError(_stream_error_message(event))

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
            raise RuntimeError(_stream_error_message(event))


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
            raise RuntimeError(_stream_error_message(event))


def _translate_call_args(kwargs: dict[str, Any]) -> dict[str, Any]:
    translated: dict[str, Any] = {}

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
            response_stream = client.responses.create(
                **{k: v for k, v in create_args.items() if v is not None},
            )
            if stream:
                return _iter_response_chunks(response_stream, model=model_name)
            return _collect_response_stream(response_stream, model=model_name)

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
            response_stream = await async_client.responses.create(
                **{k: v for k, v in create_args.items() if v is not None},
            )
            if stream:
                return _iter_response_chunks_async(response_stream, model=model_name)
            return await _collect_response_stream_async(
                response_stream,
                model=model_name,
            )

        self._completion, self._completion_async = with_middleware_pipeline(
            model_config=self._model_config,
            model_fn=_base_completion,
            async_model_fn=_base_completion_async,
            request_type="chat",
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
        is_streaming = kwargs.get("stream") or False
        if response_format is not None and is_streaming:
            raise ValueError(
                "response_format is not supported for streaming completions."
            )

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
        is_streaming = kwargs.get("stream") or False
        if response_format is not None and is_streaming:
            raise ValueError(
                "response_format is not supported for streaming completions."
            )

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
