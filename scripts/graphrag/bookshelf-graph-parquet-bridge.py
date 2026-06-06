#!/usr/bin/env python3

import json
import sys

from bookshelf_graph_bridge_build import build
from bookshelf_graph_bridge_inspect import inspect
from bookshelf_graph_bridge_query import query
from library_graph_bridge_build import build_library


def main() -> None:
    modes = {"build", "build-library", "inspect", "query"}
    if len(sys.argv) != 2 or sys.argv[1] not in modes:
        raise SystemExit(
            "Usage: bookshelf-graph-parquet-bridge.py "
            "build|build-library|inspect|query"
        )
    payload = json.load(sys.stdin)
    if sys.argv[1] == "build":
        result = build(payload)
    elif sys.argv[1] == "build-library":
        result = build_library(payload)
    elif sys.argv[1] == "inspect":
        result = inspect(payload)
    else:
        result = query(payload)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
