from __future__ import annotations

import asyncio
from types import SimpleNamespace

from pydantic import BaseModel

from qmd_graphrag.graphrag_responses_completion import (
    _build_response_text_config,
    _collect_response_stream,
    _collect_response_stream_async,
    _iter_response_chunks,
    _iter_response_chunks_async,
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


def test_collect_response_stream_returns_chat_completion_response():
    response = _collect_response_stream(
        iter([_delta("hel", 1), _delta("lo", 2), _completed()]),
        model="gpt-5.4",
    )

    assert response.id == "resp_test"
    assert response.choices[0].message.content == "hello"
    assert response.usage.total_tokens == 5


def test_iter_response_chunks_returns_chat_completion_chunks():
    chunks = list(
        _iter_response_chunks(
            iter([_delta("hel", 1), _delta("lo", 2), _completed()]),
            model="gpt-5.4",
        )
    )

    assert "".join(chunk.choices[0].delta.content or "" for chunk in chunks) == "hello"
    assert chunks[-1].choices[0].finish_reason == "stop"


def test_collect_response_stream_async_returns_chat_completion_response():
    async def run():
        return await _collect_response_stream_async(
            _async_events(),
            model="gpt-5.4",
        )

    response = asyncio.run(run())

    assert response.id == "resp_test"
    assert response.choices[0].message.content == "hello"
    assert response.usage.total_tokens == 5


def test_iter_response_chunks_async_returns_chat_completion_chunks():
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


if __name__ == "__main__":
    test_collect_response_stream_returns_chat_completion_response()
    test_iter_response_chunks_returns_chat_completion_chunks()
    test_collect_response_stream_async_returns_chat_completion_response()
    test_iter_response_chunks_async_returns_chat_completion_chunks()
    test_collect_response_stream_raises_on_error_event()
    test_iter_response_chunks_raises_on_error_event()
    test_build_response_text_config_closes_object_schemas()
    print("responses stream unit harness passed")
