# R1 设计审计报告：provider-requests 启动前隔离

结论：FAIL

Type DD 未正确约束 runner-start preflight 在 manifest 创建前对
`graph_vault/catalog/provider-requests/*.json` 的写入式修复
（writable repair）与隔离（quarantine）。当前设计和实现共同允许历史
provider request target 在启动期被全量扫描并批量隔离，且缺少范围、数量、
事件、时间与人工确认边界。

## 发现

1. FAIL / Critical：runner-start 将历史 provider request 纳入阻断性写入
   preflight。

   证据：Type DD 要求 `runner_start` 扫描全局 scope，且不得维护独立手写清单
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`-
   `247`）；同一 Type DD 又把
   `graph_vault/catalog/provider-requests/*.json` 注册为生产 durable target
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:472`-
   `477`）。实现中 provider request 明确声明
   `preflightScopes: graph_vault/catalog/provider-requests`
   （`scripts/graphrag/batch-epub-workflow.mjs:378`-`382`），并在
   manifest 加载前执行 `durablePreflight("runner_start")`
   （`scripts/graphrag/batch-epub-workflow.mjs:11694`-`11700`）。

   影响：该组合把历史 provider request 观察记录（historical observation）
   提升为 runner-start 的阻断性修复对象，直接解释了 manifest 创建前的大量
   `durable_checksum_mismatch` quarantine。

   设计操作建议：修正完善设计。Type DD 应明确 runner-start 可扫描目标清单
   与写入式目标清单，并规定 provider request 历史记录在 runner-start 默认
   为 read-only diagnostic，除显式 repair/migrate 命令外不得隔离 primary。

2. FAIL / Critical：启动期隔离缺少数量、scope、时间与事件上限。

   证据：Type DD 的 `durableStatePreflight` 仅规定扫描与
   `stop_until_fixed` 行为，未规定启动期 recovery/quarantine 上限
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1230`-
   `1249`）。实现按目录枚举全部 entry，并对每个 primary JSON/YAML 调用
   reconcile（`scripts/graphrag/batch-epub-workflow.mjs:5594`-`5634`）。
   JSON checksum mismatch 会进入 `quarantineDurableTarget`
   （`scripts/graphrag/batch-epub-workflow.mjs:5915`-`5928`、
   `5992`-`6000`），该函数立即 rename primary target 并追加隔离事件
   （`scripts/graphrag/batch-epub-workflow.mjs:5811`-`5861`）。

   影响：一次 runner 启动可以在发现首个阻断错误之前继续扫描同一目录并隔离
   大量历史文件；失败摘要中的 731 个
   `durable_json_target_quarantined` 与该行为一致。

   设计操作建议：补充设计。Type DD 应为 runner-start recovery 明确数量上限、
   目录/scope 上限、最长扫描/修复时间、最大事件数，以及超限后的
   `stop_until_fixed` 投影方式。

3. FAIL / High：provider request 的状态分类没有区分 cache-like historical
   observation 与 critical catalog state。

   证据：Type DD 只为 provider request 给出 lane、durableKind 与 owner
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:472`-
   `477`），未说明其是可丢弃/可重建的历史观察，还是必须阻断 runner 的
   critical catalog state。通用 checksum 决策表把
   `target_valid_checksum_mismatch` 规定为 primary bundle quarantine 与
   `stop_until_fixed`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:790`-
   `794`）。

   影响：设计缺少 provider request 专属分类，导致通用 durable mismatch
   规则直接套用到历史 provider request 文件，无法判断何时应只诊断、何时可
   bounded repair、何时必须 stop。

   设计操作建议：补充设计。Type DD 应给 provider request target 增加一致
   分类，并按 checksum 缺失、checksum mismatch、checksum meta 缺失分别定义
   read-only diagnostic、bounded repair、quarantine 与 stop_until_fixed。

4. FAIL / High：manifest 创建前允许大量 recovery/quarantine 事件，但缺少
   startup recovery manifest。

   证据：runner 在 `loadManifest(items)` 前执行启动 preflight
   （`scripts/graphrag/batch-epub-workflow.mjs:11694`-`11717`）。隔离事件在
   preflight 内直接写入 `events.jsonl`
   （`scripts/graphrag/batch-epub-workflow.mjs:5845`-`5860`），随后才写入一个
   `durable_preflight_blocked` 事件
   （`scripts/graphrag/batch-epub-workflow.mjs:5744`-`5761`）。Type DD 仅规定
   manifest/status/recovery-summary 是派生状态
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1289`-
   `1297`），未规定 manifest 尚未创建时的 startup recovery manifest。

   影响：当启动期被阻断时，事件流中已有大量隔离副作用，但没有可观测的启动
   恢复清单承载扫描范围、变更数量、停止点与人工处置入口。

   设计操作建议：补充设计。若允许 manifest 前 recovery 写入，Type DD 必须
   规定 startup recovery manifest；否则应禁止 runner-start 在 manifest
   创建前执行 provider request quarantine。

5. FAIL / High：大规模 provider request quarantine 前没有人工确认或显式
   repair gate。

   证据：Type DD 允许 `normal resume、migrate-only 或显式 repair command`
   执行 checksum backfill 与 quarantine
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:756`-
   `759`），但没有把大规模历史 provider request 隔离限定为显式 repair。
   实现中非 `--status-json` 启动路径自动获取 coordinator lock 并执行
   runner-start preflight
   （`scripts/graphrag/batch-epub-workflow.mjs:11694`-`11700`），checksum
   mismatch 后自动隔离 primary target
   （`scripts/graphrag/batch-epub-workflow.mjs:5811`-`5861`）。

   影响：真实 runner 启动本身即可扩大历史状态损伤；没有人工确认
   （manual confirmation）或 explicit repair command 边界。

   设计操作建议：修正完善设计。Type DD 应要求在 provider request 隔离数量
   超过极小阈值或涉及历史目录时先停止，并指向显式 repair 命令或人工确认。

6. FAIL / Medium：status-json read-only 与 normal runner-start 对
   provider request mismatch 的关系未被专门约束。

   证据：Type DD 规定 `--status-json` 不得 repair、quarantine、append event
   或 rebuild manifest
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1605`-
   `1623`），并把 checksum mismatch 投影为 `fail_closed_projection`
   与 `stop_until_fixed`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1630`-
   `1633`）。实现中的 status-json 也是只诊断 mismatch
   （`scripts/graphrag/batch-epub-workflow.mjs:4906`-`4914`），但 normal
   runner-start 会对同类 JSON mismatch 执行 quarantine
   （`scripts/graphrag/batch-epub-workflow.mjs:5515`-`5527`、
   `5811`-`5861`）。

   影响：两种入口的风险呈现不一致：status-json 只显示 stop 风险，normal
   runner-start 会实际改变 provider request 历史文件。Type DD 未要求
   status-json 披露 normal start 将触发的 provider request quarantine 风险。

   设计操作建议：补充设计。Type DD 应要求 status-json 对 provider request
   mismatch 同时投影 normal runner-start 的预期动作，且 normal runner-start
   在该类 target 上默认不执行比 status-json 更强的写入动作。

7. FAIL / Medium：共享 durable 契约的 owner 列表未覆盖
   `providerRequestFingerprint`。

   证据：Type DD 把 provider request owner 设为
   `providerRequestFingerprint`
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:472`-
   `477`），但共享 durable 契约的 owningModules 只列出 repository、
   capabilityCatalog、settingsProjection、batchCoordinator、
   batchEvidenceReader 与 pythonBridgeSubprocessRegistry
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:616`-
   `627`）。

   影响：provider request 作为被 runner-start 扫描和隔离的 durable target，
   没有在共享契约中成为明确 owner，削弱了对其历史观测语义和恢复边界的设计
   约束。

   设计操作建议：修正完善设计。Type DD 应把 provider request owner 纳入共享
   durable 契约，或明确声明其不参与 runner-start 写入式 recovery。

8. FAIL / Medium：验收点没有覆盖 provider request 大规模启动期隔离回归。

   证据：现有 R1 相关 runner-start preflight 测试覆盖的是 book run YAML
   checksum fault
   （`test/graphrag-runner-durable-preflight.test.ts:113`-`195`）。Type DD 的
   provider request 验收点只覆盖 directory fsync scope 映射
   （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1963`-
   `1968`），未覆盖 manifest 创建前 provider request mismatch 的 read-only、
   bounded repair、quarantine 上限或 explicit repair gate。

   影响：当前验收无法防止再次出现 manifest 创建前无界 provider request
   quarantine。

   设计操作建议：补平。补充固定范围内的验收点与测试：runner-start 遇到历史
   provider request mismatch 时不得无界隔离，必须收敛到 read-only diagnostic、
   bounded explicit repair、quarantined-with-cap 或 stop_until_fixed。
