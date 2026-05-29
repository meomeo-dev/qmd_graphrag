# Agent C Design Audit R1

## 判定

FAIL

固定失败在当前 Type DD 下不是被禁止的异常路径，而是被现有设计与实现
共同允许的启动期恢复行为（startup recovery behavior）。因此，Type DD
没有正确约束 runner-start preflight 对历史 `provider-requests` durable JSON
target 的大规模 `durable_checksum_mismatch` quarantine。

## 发现

### C1. runner-start 被允许在 manifest 创建前写入式隔离 provider request

严重程度：Critical

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241` 要求
  `runner_start` 从 targetMapping 派生并扫描全局 scope。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:472` 将
  `graph_vault/catalog/provider-requests/*.json` 注册为 production durable JSON
  target。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:790` 对
  `target_valid_checksum_mismatch` 规定 `quarantine_primary_bundle`。
- `scripts/graphrag/batch-epub-workflow.mjs:11694` 在 `loadManifest()` 前执行
  `durablePreflight("runner_start")`。
- `scripts/graphrag/batch-epub-workflow.mjs:5515` 的 preflight 对 primary JSON
  调用写入式 `reconcileDurableJsonTarget()`。
- `scripts/graphrag/batch-epub-workflow.mjs:5811` 的 mismatch 路径会 rename
  primary target 并写 `durable_json_target_quarantined` event。

影响：

真实失败的 731 个 provider request quarantine 是设计允许路径，不是实现越界。
Type DD 未能阻止 manifest 尚未建立时的历史观测文件大规模隔离。

设计操作建议：修正完善设计。为 `runner_start` 增加 phase-specific durable
policy：provider request 默认只读诊断或 bounded repair；primary bundle quarantine
只能在显式 repair/migrate 命令或人工确认（operator confirmation）后执行。

### C2. provider request 的状态等级未被设计一致分类

严重程度：High

证据：

- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1931` 只说明
  provider request sidecar 保存 redacted request fingerprints 和 sanitized metadata。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:472` 将其放入
  `catalogWriterLane`，但未声明它是 critical catalog state 还是 cache-like
  historical observation。
- `src/llm.ts:2003` 与 `src/llm.ts:2046` 表明该文件由 provider cost recording
  写入，随后成本记录引用 artifact id。
- `src/integrations/graphrag.ts:139` 与 `src/integrations/graphrag.ts:147` 表明
  GraphRAG provider request artifact 是请求 fingerprint 派生产物。

影响：

设计没有说明这些历史 fingerprint 对新 batch runner 是否具有阻断权威性。
实现因而把历史成本/观测 sidecar 当作启动期 critical catalog state，阻断
38 本书的正常处理。

设计操作建议：补充设计。明确 provider request durable target 的 criticality、
authority、retention 与 startup recovery 行为；若它只是 historical observation，
runner-start 不得因其 checksum mismatch 阻断新 run。

### C3. 启动前恢复没有数量、时间、scope 或事件上限

严重程度：High

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241` 要求扫描全局
  scope，但没有 quarantine count、target count、time budget 或 event budget。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:755` 允许 repair writer
  在 normal resume、migrate-only 或 explicit repair command 执行 quarantine。
- `scripts/graphrag/batch-epub-workflow.mjs:5594` 扫描目录时遍历全部 entry。
- `scripts/graphrag/batch-epub-workflow.mjs:5716` 在扫描完 targets 后才根据
  blockers 抛错。
- `audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/status.json:19`
  记录本次失败在 manifest 缺失前产生 739 个 event、731 个 JSON quarantine。

影响：

一次普通 runner 启动可以扩大历史状态损伤面，并产生大量 durable event。
Type DD 缺少 fail-early 边界，不能防止同类失败复现。

设计操作建议：补充设计。规定 runner-start writable recovery 的 target 数、
quarantine 数、event 数、扫描时间与目录 scope 上限；超过阈值时停止并输出
只读诊断摘要，转入 explicit repair command。

### C4. manifest 尚未创建时的 recovery observability 未闭合

严重程度：High

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1293` 规定 manifest、
  status.json 与 recovery-summary.json 承载 durable diagnostics。
- `scripts/graphrag/batch-epub-workflow.mjs:11694` 到
  `scripts/graphrag/batch-epub-workflow.mjs:11717` 显示 runner-start preflight
  发生在 manifest 加载或创建之前。
- `scripts/graphrag/batch-epub-workflow.mjs:5845` 在 quarantine 时直接追加
  `durable_json_target_quarantined` event。
- `audits/graphrag-provider-requests-preflight-quarantine-run_20260529_r1__open/reports/status.json:27`
  记录 `manifestCreated: false`。

影响：

设计允许大量恢复事件存在于无 manifest 的 run 中，但没有定义 startup recovery
manifest、preflight summary 或等价可观测对象（observable artifact）。这削弱了
后续判读、人工处置和恢复收敛能力。

设计操作建议：补充设计。规定 manifest 创建前可写恢复动作的最小可观测契约：
至少包含 runId、stage、scope、target count、mutation count、first/last sample、
decision 与 explicit repair hint；未能写入该契约时不得继续 quarantine。

### C5. runner 脚本与 shared durable store 对缺失 checksum 的语义不一致

严重程度：Medium

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:748` 允许有效 target
  在 checksum sidecar 缺失时回填 checksum，并把 meta 缺失视为 legacy target
  onboarding。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:784` 的
  `target_valid_checksum_missing` 允许 repair writer backfill checksum。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:614` 要求 durable
  replace、checksum backfill、quarantine 和 recovery 通过共享契约。
- `scripts/graphrag/batch-epub-workflow.mjs:5930` 在 checksum 缺失且 meta
  不匹配时直接抛 `checksum_mismatch`；meta 缺失也会不匹配。
- `src/job-state/durable-state-store.ts:648` 对 checksum 缺失且 meta 缺失的
  target 会执行 backfill，而不是 quarantine。

影响：

历史 provider request 若缺少 sidecar，runner 脚本可能按 mismatch 进入 primary
quarantine，而 shared durable store 的语义是 legacy backfill。Type DD 要求单一
durable boundary，但实现存在分叉。

设计操作建议：修正。让 runner adapter 调用 shared durable store，或把脚本内
reconcile 语义修正为与 Type DD 和 shared store 一致。

### C6. status-json 与 normal runner-start 对 provider request 风险不可对齐

严重程度：Medium

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1605` 规定
  `--status-json` 是严格只读 observer。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1611` 禁止 status-json
  repair、quarantine、event append、manifest rebuild 和 recovery summary 写入。
- `scripts/graphrag/batch-epub-workflow.mjs:5716` 在 `statusJson` 时直接跳过
  durable preflight scan。
- `scripts/graphrag/batch-epub-workflow.mjs:4860` 的只读 durable diagnostic 只在
  target 被读取时检查 checksum，不会独立扫描 provider request scope。

影响：

normal runner-start 会扫描并隔离 provider request，status-json 却不能提前暴露
同一 scope 的 mismatch 风险。操作者只能通过启动 mutating runner 才发现问题。

设计操作建议：补平。为 status-json 增加同 targetMapping 的只读 provider request
scope projection，输出 capped count 与 sample，不创建 lock、sidecar、event、
manifest 或 quarantine target。

### C7. normal runner-start 与 explicit repair command 的边界被混合

严重程度：Medium

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:755` 将 normal resume、
  migrate-only 与 explicit repair command 都列入 repair writer 可执行模式。
- `scripts/graphrag/batch-epub-workflow.mjs:11694` 对普通非 status-json 启动
  无条件进入 runner-start preflight。
- `scripts/graphrag/batch-epub-workflow.mjs:5994` 在 JSON reconcile 失败时直接
  quarantine primary target。

影响：

普通批处理启动承担了历史 durable store repair 的写入职责。对 provider request
这类历史观测目标，该职责会把工作命令变成大规模修复命令。

设计操作建议：修剪错误设计。将 provider request 的 writable quarantine 从
normal runner-start 移出，保留在 explicit repair/migrate-only 边界内；普通启动
只允许 read-only diagnostic、bounded meta backfill 或 fail-before-mutation。

### C8. 验收点没有覆盖 provider request 启动期隔离边界

严重程度：Low

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1967` 的 provider request
  验收点只覆盖 parent directory fsync 映射。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:2001` 的 quarantine
  验收点是通用 sidecar boundary，未覆盖 manifest 前 provider request 大规模
  quarantine。
- `test/graphrag-runner-durable-preflight.test.ts:113` 只覆盖 runner-start 对
  book run YAML checksum fault 的阻断。
- `test/cli.test.ts:3296` 只覆盖 manifest partial checksum sidecar crash window。

影响：

现有验收不会防止 provider request mismatch 在 manifest 创建前被无界隔离。
R1 失败缺少回归保护。

设计操作建议：补平。增加固定范围内的验收要求：历史 provider request checksum
mismatch 在 runner-start 必须被 read-only/capped 诊断，或在 explicit repair 下
bounded quarantine；manifest 创建前不得发生无界 provider request mutation。
