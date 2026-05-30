# Agent C 设计审计 R2

## Verdict

Verdict: PASS.

是否允许进入实施：允许。

当前 Type DD 已充分解决 R1 指出的 cost-accounting JSONL durable temp
owner sidecar mapping 设计缺口。后续实施应保持窄修复，只实现已补规则，
不得扩大到无关 durable target、provider retry、GraphRAG stage gate 或
checkpoint 重开策略。

## 依据

R1 的阻断缺口有三项：auxiliary sidecar mapping、JSONL durable sidecar
mode、subprocess runtime parity。当前 Type DD 已逐项补齐。

1. auxiliary sidecar mapping 已具备可实施规则。

   `targetMappingContract.rule` 已明确：未列入 mapping 的限制只针对
   production primary target；durable engine 为已登记 primary target 生成的
   temp、owner、lock、checksum、checksum meta 与 corrupt quarantine 辅助路径
   必须先归一回 primary target，并继承 primary mapping，不得被当作新的
   primary target
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`)。

   新增 `auxiliarySidecarMappingRule` 明确覆盖
   `{target}.tmp-*`、`{target}.tmp-*.owner.json`、`{target}.lock`、
   `{target}.corrupt-*`，以及启用 checksum policy 时的 checksum 和 checksum
   meta 辅助路径。该规则要求辅助路径通过 primary target locator 解析，继承
   lane、owner、durableKind、laneTimeoutMs、releaseOn、durableMode 与
   preflight scope，并禁止辅助路径拥有独立 targetMapping row 或递归生成自己的
   checksum/meta/owner sidecar
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:263`)。

   这直接覆盖真实失败中的
   `graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json` 被误当作
   production primary target 的缺口。

2. cost-accounting JSONL durable mode 已具备目标级边界。

   `graph_vault/catalog/cost-accounting.jsonl` 的 targetMapping 已补充
   `durableWriteMode: jsonl_read_reconcile_replace`、
   `checksumPolicy: none_for_current_jsonl_replace` 和
   `auxiliarySidecars: inherit_primary_mapping`
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:512`)。

   该 target 的 `sidecarPolicy` 明确 cost-accounting 使用 durable
   opaque/replace JSONL ledger，以 temp file、owner sidecar、atomic rename 与
   parent directory fsync 提交；当前不为该 JSONL target 生成 checksum sidecar；
   `{target}.tmp-*`、`{target}.tmp-*.owner.json`、`{target}.corrupt-*` 与
   parent directory fsync 必须继承 `providerCostAccounting` 的
   `eventWriterLane` mapping，且不得触发
   `durable_target_mapping_missing`
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:521`)。

   `durableWriteContract.jsonlReadReconcileReplace` 也已把读取、合并、截断坏尾
   或重写 ledger 的 JSONL target 与 append-only `events.jsonl` 区分开，
   并要求 temp、owner、corrupt quarantine 与 directory fsync 映射遵守
   `auxiliarySidecarMappingRule`
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:608`)。

3. subprocess runtime parity 已具备可测试约束。

   `singleDurableBoundary.mappingParityRule` 已要求 durableStateStore、runner
   内嵌 adapter 与 `resume-book-*` 子进程边界使用同一 primary target locator
   归一化规则。对同一 primary、temp、temp owner、checksum、checksum meta、
   lock、corrupt quarantine 与 parent directory fsync locator，三者必须解析到
   相同 lane、owner、primaryDurableKind、releaseOn、durableMode 与
   completedPublishRule；子进程 durable failure envelope 必须无损投影这些字段
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:690`)。

   该规则闭合了 R1 对 shared module 与 runner-equivalent runtime 行为漂移的
   设计担忧。

4. preflight 和 acceptance matrix 已绑定测试。

   beforeClaim 已新增 catalog 级 JSONL durable replace target 的扫描要求：
   必须扫描 auxiliarySidecarMappingRule 覆盖的 temp、owner、lock 与 corrupt
   quarantine paths；未启用 checksumPolicy 的 JSONL target 不要求 checksum
   sidecar 存在
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1376`)。

   acceptance matrix 已新增
   `cost_accounting_jsonl_auxiliary_sidecar_mapping`，覆盖 primary mapping、
   temp owner sidecar 继承、corrupt-tail quarantine 继承、不要求 checksum
   sidecar、未知 production JSONL fail-closed、shared durableStateStore 与 runner
   adapter parity，以及 `resume-book-*` failure envelope 字段投影
   (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:2157`)。

## 最小剩余设计缺口

无阻断性剩余设计缺口。

实施时仍需注意两个非阻断约束：

- `directoryFsyncEvidence.requiredFields` 仍以
  `primaryTargetLocator or sidecarTargetLocator` 表述；实现遇到 temp owner
  auxiliary path 时，应按 `auxiliarySidecarMappingRule` 同时提供
  `primaryTargetLocator` 和 `auxiliaryTargetLocator`，避免把目录 fsync 退化为
  `graph_vault/catalog` 的 repository mapping。
- cost-accounting 当前声明 `checksumPolicy: none_for_current_jsonl_replace`；
  实现不得为了通过 owner mapping 测试而给该 JSONL target 隐式生成 checksum
  sidecar。

这些是实施约束，不需要再补设计后才能编码。

## 实施许可

允许进入实施。

允许的实施范围：

- 在 shared durable state store 与 runner 内嵌 adapter 中实现相同的
  auxiliary path -> primary target 归一化。
- 修正 temp owner sidecar 写入，使
  `cost-accounting.jsonl.tmp-*.owner.json` 继承
  `graph_vault/catalog/cost-accounting.jsonl` 的
  `eventWriterLane`、`providerCostAccounting`、`jsonl` durable kind 与
  strict failure evidence。
- 保持 unknown production JSONL target 及其辅助 sidecar fail closed 为
  `durable_target_mapping_missing`。
- 增加 acceptance matrix 中指定的 shared store、runner adapter、
  corrupt-tail quarantine、preflight/status-json 和 subprocess projection 测试。

不允许的实施范围：

- 不修改本次审计问题之外的 provider auth、retry、EPUB 调度或 GraphRAG
  producer lineage 逻辑。
- 不给 cost-accounting JSONL 隐式启用 checksum sidecar。
- 不用宽泛 nonProductionDefault 或忽略 `/graph_vault/` production 判定来掩盖
  mapping 缺失。
- 不静默改写已记录的 `stop_until_fixed` checkpoint 来绕过审计证据链。
