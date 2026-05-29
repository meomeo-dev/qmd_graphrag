# Design Audit R1

结论：FAIL。

Type DD 已覆盖大部分 durable state 原则，但仍缺少 `resume-book` 子进程到
batch runner 的 typed `commandCheck` 传播契约，以及针对真实 EPUB、
book-scoped `job.yaml/checkpoints.yaml` 的恢复验收门。

## 已覆盖设计

- book-scoped YAML targets 已映射到 `checkpointWriterLane` 与 `repository`
  owner。
- targetMapping 可派生 preflight scope，`beforeClaim` 与 `beforeResumeBook`
  应扫描 durable state。
- `--status-json` 已定义为 no-state-root-mutation 的 read-only observer。
- `rename ENOENT` 已定义为 `local_state_integrity`、
  `durable_temp_rename_enoent` 与 `stop_until_fixed`。

## 阻塞缺口

- subprocess registry 只覆盖 process group 管理，未规定 durable failure
  envelope。
- 通用 `rename_enoent` 验收没有绑定 `graph_vault/books/{bookId}/job.yaml`、
  `checkpoints.yaml` 与 `artifacts.yaml`。
- checksum meta read-only 验收偏 catalog，未覆盖 book YAML sidecars。
- production dry run 要求未绑定当前真实 EPUB、`resume-book-2`、失败后 stop、
  显式 resume 与最终 full command checks。

## 必须补充的验收项

- `book_scoped_yaml_rename_enoent_resume_child`：注入 `rename ENOENT` 到
  book-scoped YAML；验收 commandCheck、item checkpoint、events、status-json
  与 recovery summary 均包含 durable evidence，且不得出现
  `failureKind: unknown`。
- `subprocess_command_check_durable_schema`：子进程必须输出带
  `schemaVersion` 的 typed failure envelope；父 runner 必须优先解析并投影。
- `book_scoped_status_json_checksum_meta_read_only`：对 book YAML checksum meta
  缺失执行 `--status-json`，不得发生任何写入或 rename。
- `before_resume_book_book_yaml_preflight_reconcile`：`beforeResumeBook` 必须从
  targetMapping 派生扫描 book-scoped primary 与 sidecar。
- `real_epub_book_yaml_recovery_gate`：真实 EPUB 必须证明失败 stop、修复后
  显式 resume，以及最终真实 qmd/GraphRAG/query-ready 完整闭环。
