from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))

from qmd_graphrag.graphrag_responses_completion import (
    _build_response_text_config,
    _collect_response_stream,
    _collect_response_stream_async,
    _iter_response_chunks,
    _iter_response_chunks_async,
    _translate_call_args,
)


def _delta(text: str, sequence_number: int) -> SimpleNamespace:
    return SimpleNamespace(
        content_index=0,
        delta=text,
        item_id="msg_1",
        logprobs=[],
        output_index=0,
        sequence_number=sequence_number,
        type="response.output_text.delta",
    )


def _completed() -> SimpleNamespace:
    return SimpleNamespace(
        response=SimpleNamespace(
            id="resp_test",
            created_at=123,
            output_text="",
            usage=SimpleNamespace(
                input_tokens=2,
                output_tokens=3,
                total_tokens=5,
            ),
        ),
        sequence_number=3,
        type="response.completed",
    )


def _error(message: str) -> SimpleNamespace:
    return SimpleNamespace(
        code="upstream_error",
        message=message,
        param=None,
        sequence_number=1,
        type="error",
    )


async def _async_events():
    yield _delta("hel", 1)
    yield _delta("lo", 2)
    yield _completed()


def test_collect_response_stream_returns_responses_compat_completion():
    response = _collect_response_stream(
        iter([_delta("hel", 1), _delta("lo", 2), _completed()]),
        model="gpt-5.4",
    )

    assert response.id == "resp_test"
    assert response.choices[0].message.content == "hello"
    assert response.usage.total_tokens == 5


def test_iter_response_chunks_returns_responses_compat_chunks():
    chunks = list(
        _iter_response_chunks(
            iter([_delta("hel", 1), _delta("lo", 2), _completed()]),
            model="gpt-5.4",
        )
    )

    assert "".join(chunk.choices[0].delta.content or "" for chunk in chunks) == "hello"
    assert chunks[-1].choices[0].finish_reason == "stop"


def test_collect_response_stream_async_returns_responses_compat_completion():
    async def run():
        return await _collect_response_stream_async(
            _async_events(),
            model="gpt-5.4",
        )

    response = asyncio.run(run())

    assert response.id == "resp_test"
    assert response.choices[0].message.content == "hello"
    assert response.usage.total_tokens == 5


def test_iter_response_chunks_async_returns_responses_compat_chunks():
    async def run():
        chunks = []
        async for chunk in _iter_response_chunks_async(
            _async_events(),
            model="gpt-5.4",
        ):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(run())

    assert "".join(chunk.choices[0].delta.content or "" for chunk in chunks) == "hello"
    assert chunks[-1].choices[0].finish_reason == "stop"


def test_collect_response_stream_raises_on_error_event():
    try:
        _collect_response_stream(iter([_error("gateway rejected request")]), model="gpt-5.4")
    except RuntimeError as error:
        assert "gateway rejected request" in str(error)
    else:
        raise AssertionError("expected RuntimeError")


def test_iter_response_chunks_raises_on_error_event():
    try:
        list(
            _iter_response_chunks(
                iter([_error("gateway rejected request")]),
                model="gpt-5.4",
            )
        )
    except RuntimeError as error:
        assert "gateway rejected request" in str(error)
    else:
        raise AssertionError("expected RuntimeError")


def test_build_response_text_config_closes_object_schemas():
    class FindingModel(BaseModel):
        summary: str
        explanation: str

    class CommunityReportResponse(BaseModel):
        title: str
        findings: list[FindingModel]

    config = _build_response_text_config(
        response_format=CommunityReportResponse,
        response_format_json_object=False,
    )

    schema = config["format"]["schema"]
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["FindingModel"]["additionalProperties"] is False


def test_build_response_text_config_rejects_json_object_fallback():
    try:
        _build_response_text_config(
            response_format=None,
            response_format_json_object=True,
        )
    except ValueError as error:
        assert "strict" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_build_response_text_config_omits_format_for_plain_completion():
    config = _build_response_text_config(
        response_format=None,
        response_format_json_object=False,
    )

    assert config is None


def test_translate_call_args_accepts_responses_endpoint_without_v1():
    translated = _translate_call_args({
        "responses_endpoint": "/responses",
        "responses_stream": True,
        "strict_structured_output": True,
        "reasoning_effort": "medium",
    })

    assert translated["reasoning"] == {"effort": "medium"}


def test_translate_call_args_rejects_versioned_responses_endpoint():
    try:
        _translate_call_args({"responses_endpoint": "/v1/responses"})
    except ValueError as error:
        assert "/responses" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_translate_call_args_rejects_non_stream_responses_transport():
    try:
        _translate_call_args({"responses_stream": False})
    except ValueError as error:
        assert "stream" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_translate_call_args_rejects_non_strict_structured_output():
    try:
        _translate_call_args({"strict_structured_output": False})
    except ValueError as error:
        assert "structured output" in str(error)
    else:
        raise AssertionError("expected ValueError")


if __name__ == "__main__":
    test_collect_response_stream_returns_responses_compat_completion()
    test_iter_response_chunks_returns_responses_compat_chunks()
    test_collect_response_stream_async_returns_responses_compat_completion()
    test_iter_response_chunks_async_returns_responses_compat_chunks()
    test_collect_response_stream_raises_on_error_event()
    test_iter_response_chunks_raises_on_error_event()
    test_build_response_text_config_closes_object_schemas()
    test_build_response_text_config_rejects_json_object_fallback()
    test_build_response_text_config_omits_format_for_plain_completion()
    test_translate_call_args_accepts_responses_endpoint_without_v1()
    test_translate_call_args_rejects_versioned_responses_endpoint()
    test_translate_call_args_rejects_non_stream_responses_transport()
    test_translate_call_args_rejects_non_strict_structured_output()
    print("responses stream unit harness passed")
