# 实施审计基准 R1：Agent B

适用范围：durable 状态机、writer/reconcile 边界、测试 hook 语义、
pre-coordinator 失败证据与异常传播。

1. writer 模式的 reconcile/backfill 必须保持锁内执行与 durable publish
   规则，不得引入无锁 primary 写入。
2. `discoverItems()` 阶段的 durable 失败必须尽可能记录事件证据，并继续
   抛出原始失败，不得伪装成功。
3. pre-coordinator durable 失败事件不得在 `--status-json` 路径写盘。
4. sidecar-only 失败必须继承 primary lane、owner 与 scope，不得被映射成
   无主辅助文件。
5. `writeJsonAtomicSidecar()` 的证据字段必须只补充 sidecar 映射，不改变
   primary atomic write 的提交顺序。
6. rename ENOENT 测试 hook 必须能精确注入 checksum meta sidecar，同时不得
   改变旧有主 JSON 注入测试的匹配语义。
7. DurableStateError 的 local evidence 必须通过 `durableProjection()` 投影到
   event metadata 与顶层事件字段。
8. 对于 repair writer 的 sidecar ENOENT，事件写入失败只能 best-effort，不得
   掩盖原 durable 错误。
9. 不得引入对 `.env`、provider secret 或绝对路径的未脱敏输出。
10. 新增逻辑不得放宽 stale temp、lock timeout、checksum mismatch 的
    stop-until-fixed 分类。
