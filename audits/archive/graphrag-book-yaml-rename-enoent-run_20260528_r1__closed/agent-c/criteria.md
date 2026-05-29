# Implementation Audit Criteria

本文件固定本轮实施审计基准。后续重审不得修改本文件内容。

1. Type DD 优先：实现必须可追溯到
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 的
   production-ready 设计，且不得引入设计外的完成态、失败分类或恢复策略。
2. Durable rename ENOENT 分类：任何 durable atomic rename ENOENT，尤其是
   book-scoped YAML 写入失败，必须分类为 `local_state_integrity`、
   `localFailureClass=durable_temp_rename_enoent`、`retryable=false`、
   `recoveryDecision=stop_until_fixed`，不得退化为 `unknown`、provider
   transient 或普通业务失败。
3. 子进程 failure envelope：`resume-book-workspace` 捕获 durable local state
   failure 时必须向 stderr/stdout 输出单行 `QMD_GRAPHRAG_DURABLE_FAILURE`
   JSON envelope，并携带 Type DD 要求的 root-cause 字段。
4. 父 runner 解析优先级：父 runner 必须先解析 typed failure envelope，再使用
   legacy stderr/stdout 文本分类；envelope 可解析时必须无损投影到
   commandCheck、item checkpoint、command_failed、item_failed、status-json 与
   recovery summary。
5. Evidence fail-closed：envelope 缺失、不可解析或必填字段不完整时，只要失败
   位于 durable subprocess boundary，就必须 fail closed 为
   `local_state_integrity`、`durable_subprocess_evidence_incomplete`、
   `retryable=false`、`stop_until_fixed`，并写入 unavailable sentinel。
6. 真实 runner 门控：在实施审计通过前，真实 batch runner 恢复必须保持门控，
   不得继续处理已知 `stop_until_fixed` 的真实失败 run。
7. 测试闭环：测试必须覆盖 resume-book child stderr envelope 到父
   commandCheck、item checkpoint、events、status-json 或 recovery summary 的闭环，
   并断言 Type DD 对 book-scoped YAML rename ENOENT 要求的关键字段。
8. Settings projection 安全性：修复 settings projection ENOENT 时，可以创建缺失的
   managed projection，但不得覆盖或弱化 user-owned `graph_vault/settings.yaml`
   拒绝策略；拒绝必须在 checkpoint、events 或 summary 中可观测。
9. Durable read-only 约束：`--status-json` 必须保持 read-only inspection，不得创建、
   删除、rename lock/temp/checksum/meta/quarantine/event/status/recovery-summary 等
   持久文件。
10. 维护性约束：实现不得引入与修复目标无关的大型重构；超过项目行数阈值的
    文件必须作为维护风险记录，并要求后续拆分或收敛。
