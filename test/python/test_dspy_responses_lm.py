from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "finetune" / "experiments" / "gepa"))

import responses_lm
from responses_lm import OpenAIResponsesDspyLM


class FakeHttpResponse:
    def __iter__(self):
        events = [
            {
                "type": "response.output_text.delta",
                "delta": "hel",
            },
            {
                "type": "response.output_text.delta",
                "delta": "lo",
            },
            {
                "type": "response.completed",
                "response": {"id": "resp_test"},
            },
        ]
        for event in events:
            yield f"data: {json.dumps(event)}\n\n".encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_dspy_responses_lm_calls_plain_responses_endpoint(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["headers"] = dict(request.header_items())
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return FakeHttpResponse()

    monkeypatch.setattr(responses_lm, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://gateway.local")

    lm = OpenAIResponsesDspyLM(
        model="openai/gpt-5.4",
        api_key_env="OPENAI_API_KEY",
        base_url_env="OPENAI_BASE_URL",
        endpoint="/responses",
        reasoning_effort="medium",
        max_tokens=128,
    )

    output = lm(messages=[
        {"role": "system", "content": "Answer tersely."},
        {"role": "user", "content": "Say hello."},
    ])

    assert output == ["hello"]
    assert captured["url"] == "http://gateway.local/responses"
    assert captured["payload"]["stream"] is True
    assert captured["payload"]["model"] == "gpt-5.4"
    assert captured["payload"]["reasoning"] == {"effort": "medium"}
    assert captured["payload"]["instructions"] == "Answer tersely."


def test_dspy_responses_lm_rejects_versioned_endpoint():
    try:
        OpenAIResponsesDspyLM(
            model="gpt-5.4",
            api_key_env="OPENAI_API_KEY",
            base_url_env="OPENAI_BASE_URL",
            endpoint="/v1/responses",
            reasoning_effort="medium",
            max_tokens=128,
        )
    except ValueError as error:
        assert "/responses" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_dspy_responses_lm_requires_env(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_BASE_URL", "http://gateway.local")
    lm = OpenAIResponsesDspyLM(
        model="gpt-5.4",
        api_key_env="OPENAI_API_KEY",
        base_url_env="OPENAI_BASE_URL",
        endpoint="/responses",
        reasoning_effort="medium",
        max_tokens=128,
    )

    try:
        lm(prompt="hello")
    except RuntimeError as error:
        assert "OPENAI_API_KEY" in str(error)
    else:
        raise AssertionError("expected RuntimeError")


class ScriptMonkeyPatch:
    def __init__(self) -> None:
        self._restore: list[tuple[object, str, object, bool]] = []
        self._env_restore: list[tuple[str, str | None]] = []

    def setattr(self, target: object, name: str, value: object) -> None:
        sentinel = object()
        old_value = getattr(target, name, sentinel)
        self._restore.append((target, name, old_value, old_value is sentinel))
        setattr(target, name, value)

    def setenv(self, key: str, value: str) -> None:
        self._env_restore.append((key, os.environ.get(key)))
        os.environ[key] = value

    def delenv(self, key: str, raising: bool = True) -> None:
        if key not in os.environ and raising:
            raise KeyError(key)
        self._env_restore.append((key, os.environ.get(key)))
        os.environ.pop(key, None)

    def undo(self) -> None:
        for key, value in reversed(self._env_restore):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        for target, name, old_value, missing in reversed(self._restore):
            if missing:
                delattr(target, name)
            else:
                setattr(target, name, old_value)


def _run_with_monkeypatch(test_fn):
    monkeypatch = ScriptMonkeyPatch()
    try:
        test_fn(monkeypatch)
    finally:
        monkeypatch.undo()


if __name__ == "__main__":
    _run_with_monkeypatch(test_dspy_responses_lm_calls_plain_responses_endpoint)
    test_dspy_responses_lm_rejects_versioned_endpoint()
    _run_with_monkeypatch(test_dspy_responses_lm_requires_env)
    print("dspy responses lm unit harness passed")
