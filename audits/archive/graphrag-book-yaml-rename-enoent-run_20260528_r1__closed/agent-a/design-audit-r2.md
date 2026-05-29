# Design Audit R2

结论：PASS。

当前 Type DD 已足够覆盖真实失败链路。

## 已确认覆盖点

- `subprocessDurableFailureProjection` 已覆盖 `resume-book-workspace`，要求
  子进程输出 `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope，不能只靠
  stderr/stdout 文本推断。
- `BatchCommandCheck` 已被定义为子进程 durable failure 的 first-hop
  carrier，并要求保留 envelope durable fields。
- 父 runner 必须先解析 typed envelope，再退回 legacy 文本分类。
- envelope 缺失、不可解析或字段不足时已有 fail-closed 规则：投影为
  `local_state_integrity`、`retryable: false`、`stop_until_fixed`，且不得降级为
  `unknown`。
- book-scoped `job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 已在 targetMapping
  中注册，并有 `book_scoped_yaml_rename_enoent_resume_child` 验收用例。
- `--status-json` 只读约束一致：不得创建 lock/temp/checksum/meta，不得
  quarantine，不得写 event/manifest/status/recovery-summary；book-scoped
  checksum meta 缺失也有只读验收。

未发现阻塞缺口。
