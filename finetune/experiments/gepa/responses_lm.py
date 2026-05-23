"""DSPy LM adapter backed only by the OpenAI Responses API."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class OpenAIResponsesDspyLM:
    """Minimal DSPy-compatible LM using `/responses` with stream transport."""

    def __init__(
        self,
        *,
        model: str,
        api_key_env: str,
        base_url_env: str,
        endpoint: str,
        reasoning_effort: str | None,
        max_tokens: int,
    ) -> None:
        if endpoint != "/responses":
            raise ValueError("Responses API endpoint must be /responses")

        self.model = _strip_openai_provider_prefix(model)
        self.model_type = "responses"
        self.kwargs = {"max_tokens": max_tokens}
        self.history: list[dict[str, Any]] = []
        self.api_key_env = api_key_env
        self.base_url_env = base_url_env
        self.endpoint = endpoint
        self.reasoning_effort = reasoning_effort
        self.max_tokens = max_tokens

    def copy(self, **kwargs: Any) -> "OpenAIResponsesDspyLM":
        copied = OpenAIResponsesDspyLM(
            model=self.model,
            api_key_env=self.api_key_env,
            base_url_env=self.base_url_env,
            endpoint=self.endpoint,
            reasoning_effort=self.reasoning_effort,
            max_tokens=self.max_tokens,
        )
        copied.kwargs = dict(self.kwargs)
        for key, value in kwargs.items():
            if hasattr(copied, key):
                setattr(copied, key, value)
            if value is None:
                copied.kwargs.pop(key, None)
            else:
                copied.kwargs[key] = value
        return copied

    def __call__(
        self,
        prompt: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> list[str]:
        text = self._call_responses(prompt=prompt, messages=messages, **kwargs)
        self.history.append({
            "prompt": prompt,
            "messages": messages,
            "response": text,
        })
        return [text]

    def _call_responses(
        self,
        *,
        prompt: str | None,
        messages: list[dict[str, Any]] | None,
        **kwargs: Any,
    ) -> str:
        api_key = os.environ.get(self.api_key_env, "").strip()
        base_url = os.environ.get(self.base_url_env, "").strip()
        if not api_key:
            raise RuntimeError(f"missing OpenAI API key env: {self.api_key_env}")
        if not base_url:
            raise RuntimeError(f"missing OpenAI base URL env: {self.base_url_env}")

        instructions, input_payload = _normalize_responses_input(prompt, messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "input": input_payload,
            "stream": True,
            "max_output_tokens": kwargs.get("max_tokens")
            or kwargs.get("max_output_tokens")
            or self.max_tokens,
        }
        if instructions:
            payload["instructions"] = instructions
        if self.reasoning_effort:
            payload["reasoning"] = {"effort": self.reasoning_effort}

        request = Request(
            _responses_url(base_url, self.endpoint),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=float(kwargs.get("timeout", 300))) as response:
                return _collect_sse_response_text(response)
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Responses API HTTP {error.code}: {body}") from error
        except URLError as error:
            raise RuntimeError(f"Responses API request failed: {error}") from error


def _strip_openai_provider_prefix(model: str) -> str:
    if model.startswith("openai/"):
        return model.split("/", 1)[1]
    if model.startswith("openai:"):
        return model.split(":", 1)[1]
    return model


def _responses_url(base_url: str, endpoint: str) -> str:
    return f"{base_url.rstrip('/')}{endpoint}"


def _normalize_responses_input(
    prompt: str | None,
    messages: list[dict[str, Any]] | None,
) -> tuple[str | None, str | list[dict[str, str]]]:
    if messages:
        instructions: list[str] = []
        input_messages: list[dict[str, str]] = []
        for item in messages:
            role = str(item.get("role", "user"))
            content = _content_to_text(item.get("content", ""))
            if role in {"system", "developer"}:
                instructions.append(content)
            else:
                input_messages.append({
                    "type": "message",
                    "role": role,
                    "content": content,
                })
        if input_messages:
            return "\n\n".join(instructions) or None, input_messages
        return None, "\n\n".join(instructions)

    return None, prompt or ""


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(content)


def _collect_sse_response_text(response: Any) -> str:
    text_parts: list[str] = []
    event_name = ""
    data_lines: list[str] = []

    for raw_chunk in response:
        chunk = raw_chunk.decode("utf-8", errors="replace")
        for line in chunk.splitlines():
            if not line:
                _consume_sse_event(event_name, data_lines, text_parts)
                event_name = ""
                data_lines = []
                continue
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
                continue
            if line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].lstrip())

    _consume_sse_event(event_name, data_lines, text_parts)
    return "".join(text_parts)


def _consume_sse_event(
    event_name: str,
    data_lines: list[str],
    text_parts: list[str],
) -> None:
    if not data_lines:
        return

    data = "\n".join(data_lines)
    if data == "[DONE]":
        return
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        return

    event_type = str(payload.get("type") or event_name)
    if event_type == "response.output_text.delta":
        text_parts.append(str(payload.get("delta", "")))
        return
    if event_type == "response.output_text.done" and not text_parts:
        text_parts.append(str(payload.get("text", "")))
        return
    if event_type in {"error", "response.failed", "response.incomplete"}:
        error = payload.get("error") or payload
        message = error.get("message") if isinstance(error, dict) else str(error)
        raise RuntimeError(f"Responses API stream failed: {message}")
