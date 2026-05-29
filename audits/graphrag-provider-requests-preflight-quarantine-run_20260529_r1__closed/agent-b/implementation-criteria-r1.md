# Agent B Implementation Criteria R1

## 固定基准

1. 审计基准固定为本文件 10 条，不得扩展或替换为新范围。
2. Type DD 中 provider_request_fingerprint 的 historical_observation 分类必须
   有实现对应字段或等效分流逻辑。
3. provider request runner-start scan 必须限制扫描数量，并报告是否 truncated。
4. provider request runner-start mutation count 必须为 0，并在诊断中可见。
5. runner-start 对 provider request checksum missing、checksum mismatch、
   checksum meta missing、invalid JSON 均不得写入 provider-requests 目录。
6. status-json provider request projection 必须进入 durableStateFailures 或等价
   status surface。
7. status-json provider request projection 必须与 normal runner diagnostic class
   一致，均为 provider_request_durable_degraded。
8. startup recovery manifest 或等价 manifest metadata 必须在 preflight 前存在。
9. 新增测试必须能证明 provider request mismatch 不产生
   `durable_json_target_quarantined`。
10. 新增测试必须能证明 status-json provider request projection 不改变目录快照。
