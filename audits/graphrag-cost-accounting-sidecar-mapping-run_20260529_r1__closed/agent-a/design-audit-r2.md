# Agent A Design Audit R2: Cost Accounting Sidecar Mapping

## Verdict

Verdict: PASS

刚刚补入的 Type DD 规则已充分解决 R1 指出的
`graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json`
durable target mapping 设计缺口。当前设计可以进入实施
（implementation），但实施范围应限于 Type DD 已定义的 auxiliary sidecar
归一化、共享 durable store 与 runner adapter parity、以及对应测试补齐。

## 依据

1. Primary target 与 JSONL policy 已明确。

   `graph_vault/catalog/cost-accounting.jsonl` 现在不仅登记了
   `eventWriterLane`、`providerCostAccounting`、`durableKind: jsonl`、
   `laneTimeoutMs` 与 `releaseOn`，还声明了：

   - `durableWriteMode: jsonl_read_reconcile_replace`
   - `checksumPolicy: none_for_current_jsonl_replace`
   - `auxiliarySidecars: inherit_primary_mapping`

   该规则直接回答了 R1 的 checksum policy 缺口：当前 cost accounting JSONL
   durable replace 不要求 checksum sidecar；若未来启用 checksum policy，必须
   通过 targetMapping 或 durable write mode 显式声明。

2. Temp owner sidecar 不再是独立 primary target。

   新增 `auxiliarySidecarMappingRule` 明确规定每个 production durable primary
   target，包括 YAML、JSON、JSONL 与 SQLite lock family，在 durable write
   protocol 下隐式拥有 `{target}.tmp-*`、`{target}.tmp-*.owner.json`、
   `{target}.lock`、`{target}.corrupt-*` 等 auxiliary paths。所有 auxiliary
   paths 必须通过 primary target locator 解析并继承 primary 的 lane、owner、
   durableKind、laneTimeoutMs、releaseOn、durableMode 与 preflight scope。

   这正面禁止了 R1 发现的错误行为：把
   `cost-accounting.jsonl.tmp-*.owner.json` 当作新的 production JSON primary
   target 查表。

3. Checksum sidecar 规则已从 YAML/JSON 扩展为 policy-driven。

   `derivedSidecarRule` 现在以 checksum policy 为边界，而不是只依赖文件类型。
   YAML/JSON durable replace 必须采用 checksum policy；JSONL target 只有在
   targetMapping 或 durable write mode 明确声明 checksum policy 时才生成
   checksum sidecar。该表述消除了 R1 中 JSONL checksum 是否必须存在的歧义。

4. JSONL read-reconcile-replace 写入流程已纳入 durable write contract。

   `jsonlReadReconcileReplace` 规则要求读取、合并、截断坏尾或重写 ledger 的
   JSONL target 使用 durable replace 等价流程，包括 temp、owner sidecar、
   exclusive create、atomic rename 与 parent directory fsync；temp、owner、
   corrupt quarantine 与 directory fsync 映射必须遵守
   `auxiliarySidecarMappingRule`。

5. Preflight scope 已覆盖 catalog 级 JSONL auxiliary paths。

   `beforeClaim` 规则现在明确要求 catalog 级 JSONL durable replace target
   扫描其 auxiliary sidecar rule 覆盖的 temp、owner、lock 与 corrupt quarantine
   paths；未启用 checksumPolicy 的 JSONL target 不要求 checksum sidecar 存在。
   这补齐了 R1 指出的 preflight 只显式提到 book-scoped output 的缺口。

6. Acceptance matrix 已包含本问题的回归证据。

   新增 `cost_accounting_jsonl_auxiliary_sidecar_mapping` case 要求：

   - cost accounting primary 映射到 `eventWriterLane` 和
     `providerCostAccounting`。
   - `cost-accounting.jsonl.tmp-*.owner.json` 继承 primary mapping，并报告为
     `temp_owner` auxiliary evidence。
   - `cost-accounting.jsonl.corrupt-*` 及其 temp owner sidecar 继承 primary
     mapping。
   - 未启用 checksumPolicy 时不要求 cost accounting JSONL checksum sidecar。
   - 未登记 production JSONL target 及其 `.tmp-*.owner.json` 仍 fail closed。
   - shared durableStateStore 与 runner adapter 对 auxiliary locators 解析一致。
   - `resume-book-*` durable failure envelope 保留 target、primary、auxiliary、
     tempId、operationId、lane、targetMappingOwner 与 primaryDurableKind。

   这些验收点覆盖 R1 的 production path append、temp owner mapping、corrupt
   quarantine、negative mapping、adapter parity 与 subprocess envelope 要求。

## 若 FAIL 的最小剩余设计缺口

不适用。本轮审计未发现阻止实施的剩余 Type DD 设计缺口。

仍需在实施阶段注意两点：

- 实现不得通过新增
  `graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json`
  的显式 targetMapping row 解决问题；必须实现 primary target normalization。
- 实现必须保持 unknown production JSONL target fail closed，避免把所有 catalog
  temp owner sidecar 无条件归入 cost accounting。

## 是否允许进入实施

允许进入实施。

实施边界：

- 修改应限于共享 durable store、runner adapter parity、auxiliary path
  normalization、failure evidence projection 与测试。
- 不需要再补 Type DD 作为进入实施的前置条件。
- 实施完成前必须用 acceptance matrix 中
  `cost_accounting_jsonl_auxiliary_sidecar_mapping` 对应测试证明：
  production `graph_vault` path、temp owner sidecar、corrupt quarantine、
  negative mapping 与 `resume-book-*` envelope 均符合设计。
