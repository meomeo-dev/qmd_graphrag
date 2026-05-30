# GraphRAG Cost Accounting Sidecar Mapping Design Audit R1

## Verdict

FAIL（失败）。

Type DD 尚未明确规定 production durable primary target（生产持久主目标）的
temporary file（临时文件）、owner sidecar（所有者旁车）、lock sidecar、checksum
sidecar 与 checksum meta sidecar 必须全部继承 primary mapping（主目标映射）。
现有文本只明确了 YAML/JSON primary 的 checksum sidecar 继承规则，未覆盖 JSONL
primary，也未覆盖 `.tmp-*` 与 `.tmp-*.owner.json`。因此本次
`graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json` 被判
`durable_target_mapping_missing` 不能归类为单纯实现遗漏。

不允许直接进入实施（implementation）。应先补 Type DD，再按补丁实施。

## 证据

1. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224` 定义
   `targetMappingContract`，要求每个生产持久化目标能追溯到 lane、owner、
   `durableKind`、`laneTimeoutMs` 与 `releaseOn`。

2. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:250` 的
   `derivedSidecarRule` 只写明每个 durable YAML/JSON primary target 隐式拥有
   checksum sidecar 与 checksum meta sidecar，并继承 primary 的 lane、owner、
   timeout、release、durable mode 与 preflight scope。该规则没有覆盖 JSONL
   primary，也没有覆盖 temp sidecar 或 owner sidecar。

3. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:489` 已把
   `graph_vault/catalog/cost-accounting.jsonl` 注册为 `eventWriterLane`、
   `durableKind: jsonl`、`owner: providerCostAccounting`。这只明确 primary
   target 本身的 mapping，不能推出它的 `.tmp-*` 和 `.owner.json` 必须继承该
   mapping。

4. `docs/architecture/graphrag-parallel-runner.type-dd.yaml:686` 的
   `temporaryFileLifecycle` 要求 writer 写入 owner evidence，再写入 temp 并
   fsync；但该段没有说明 temp path 与 owner evidence sidecar 的 target mapping
   解析规则。

5. `src/provider/cost-accounting.ts:37` 将 provider cost accounting 写入
   `graph_vault/catalog/cost-accounting.jsonl`，并通过
   `writeOpaqueFileDurableSync` 提交。

6. `src/job-state/durable-state-store.ts:445` 为 opaque write 创建 primary
   operation，随后在 `src/job-state/durable-state-store.ts:446` 到
   `src/job-state/durable-state-store.ts:449` 创建
   `cost-accounting.jsonl.tmp-*.owner.json`。该 owner sidecar 是 primary write 的
   auxiliary target（辅助目标），但当前设计没有明确其继承映射。

7. `src/job-state/durable-state-store.ts:2224` 的 mapping 归一化只剥离
   `.corrupt-*`、`.sha256.meta.json` 与 `.sha256`，未剥离 `.tmp-*` 或
   `.owner.json`。这与真实失败相符，但实现行为本身不能补足 Type DD 的缺失。

8. `audits/.../reports/status.json:7` 到 `:13` 记录的真实失败为
   cost-accounting JSONL primary 的 temp owner sidecar mapping missing；
   `:31` 到 `:37` 记录为 `local_state_integrity`、
   `durable_target_mapping_missing`、`stop_until_fixed`。

## 设计决策

Type DD 应新增一条统一的 auxiliary sidecar mapping rule（辅助旁车映射规则）：

```yaml
auxiliarySidecarMappingRule: >
  Every production durable primary target, including YAML, JSON, JSONL and
  SQLite targets when they use the durable write protocol, implicitly owns all
  auxiliary durable paths created for that primary write. This includes
  `{target}.tmp-*`, `{target}.tmp-*.owner.json`, `{target}.lock`,
  `{target}.sha256`, `{target}.sha256.tmp-*`,
  `{target}.sha256.tmp-*.owner.json`, and
  `{target}.sha256.meta.json`.
  Each auxiliary path must resolve through the primary target locator and
  inherit the primary lane, owner, durableKind, laneTimeoutMs, releaseOn,
  durableMode and preflight scope. Auxiliary paths must not become recursive
  primary targets. Failure evidence must include targetLocator, and when the
  visible failing path is auxiliary, also primaryTargetLocator,
  sidecarTargetLocator, sidecarKind, tempId when available, operationId,
  lane, targetMappingOwner and primaryDurableKind.
```

同时修改现有 `derivedSidecarRule`：

- 将 “durable YAML/JSON primary target” 改为
  “production durable YAML/JSON/JSONL primary target”。
- 明确 checksum sidecars 只是 auxiliary sidecar 的一种，不能替代 temp、
  owner、lock 的继承规则。
- 明确 JSONL target 若采用 durable replace 或 opaque durable write，也必须让
  `.tmp-*` 与 `.owner.json` 继承 primary mapping。

该补丁是最小设计补丁（minimal design patch），不需要新增新的 lane、owner、
durable kind 或 target family。

## 实施边界

实施应被限制在 durable target mapping 归一化与 owner sidecar evidence 生成：

1. `primaryTargetPathForMapping` 或等价函数必须能从以下路径回推 primary：
   `target.tmp-*`、`target.tmp-*.owner.json`、`target.sha256.tmp-*`、
   `target.sha256.tmp-*.owner.json`、`target.lock`、
   `target.sha256`、`target.sha256.meta.json`。

2. 对 `graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json` 的 mapping
   结果必须继承：
   `lane: eventWriterLane`、`targetMappingOwner: providerCostAccounting`、
   `laneTimeoutMs: 120000`、`releaseOn: [commit, error, cancellation,
   lease_loss, timeout]`，并保留 strict durable mode。

3. 不应把 `.owner.json`、`.tmp-*`、`.sha256` 或 `.lock` 加入
   `targetMapping` 作为新的显式 primary 条目。它们应作为派生 auxiliary paths
   解析，避免递归 sidecar 与规则膨胀。

4. 不应改变 provider cost accounting 的业务 schema、record 内容、费用计算、
   provider auth 恢复策略或 batch item retry 策略。

5. 若修复同时触及 runner 内嵌 durable adapter 与共享
   `src/job-state/durable-state-store.ts`，两者必须保持同一契约语义。

## 测试要求

1. 新增或更新 Type DD 测试，覆盖 JSONL primary 的 auxiliary sidecar 继承规则。

2. 新增 durable mapping 单元测试：
   `graph_vault/catalog/cost-accounting.jsonl.tmp-x.owner.json` 必须解析到
   `graph_vault/catalog/cost-accounting.jsonl` 的 mapping。

3. 覆盖 checksum 派生路径：
   `cost-accounting.jsonl.sha256`、
   `cost-accounting.jsonl.sha256.tmp-x.owner.json` 与
   `cost-accounting.jsonl.sha256.meta.json` 必须继承同一 primary mapping，并写入
   `primaryDurableKind: jsonl`。

4. 覆盖 negative case（反例）：未知 production target 的 `.tmp-*` 或
   `.owner.json` 不能因 auxiliary 规则获得 nonProduction default，仍必须
   `durable_target_mapping_missing`。

5. 回归测试 provider cost accounting append：在真实或测试 vault 中写入
   `graph_vault/catalog/cost-accounting.jsonl` 时，不得因
   `.tmp-*.owner.json` 触发 mapping missing；失败 evidence 仍需包含
   `targetLocator`、`primaryTargetLocator` 或可回推 primary 的 locator、
   `lane`、`targetMappingOwner`、`tempId` 与 `operationId`。

## 是否允许进入实施

不允许直接进入实施。

条件性允许路径：先提交并通过 Type DD 最小设计补丁审计，明确 production durable
primary 的 temp、owner、lock、checksum 与 checksum meta auxiliary sidecars
全部继承 primary mapping，且覆盖 JSONL target。设计补丁通过后，方可实施代码修复
与测试。
