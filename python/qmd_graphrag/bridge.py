#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GRAPHRAG_REPO = REPO_ROOT / "vendor" / "graphrag"

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

    if method == "global":
        dfs = _resolve_output_files(
            config=config,
            output_list=["entities", "communities", "community_reports"],
            optional_list=[],
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
                "communities",
                "community_reports",
                "text_units",
                "relationships",
                "entities",
            ],
            optional_list=["covariates"],
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
                "communities",
                "community_reports",
                "text_units",
                "relationships",
                "entities",
            ],
            optional_list=[],
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
            output_list=["text_units"],
            optional_list=[],
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
        "contextData": _serialize_json(context_data),
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
