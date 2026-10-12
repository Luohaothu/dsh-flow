# Auditor 消融实验：SQLite 冻结调研证据

这个场景要求执行者依据四篇 SQLite 官方文档，整理事务、WAL 与连接隔离的六条结构化结论。它测试固定证据包上的资料整合、引用覆盖和验收审查；不代表开放网络深度调研的检索广度、来源发现能力或综合研究质量。

机器可读包位于 `tests/experiments/auditor-ablation/research-sources.json`。每个 source 保存检索时间、官方 URL、短摘录及其 SHA256；摘要 hash 只针对 `text` 的 UTF-8 字节，不是整页 hash。保留摘录均少于 180 个英文单词。出处编号由专用 `auditor-ablation-citations.json` ledger 生成。

## 任务边界与预期结论

外键支持需要可用的库支持，并在每个连接上显式配置；官方页面说明默认关闭，同时提醒应用不要依赖默认设置。[1]

在活动的多语句事务中切换外键设置无效，而且这个尝试本身不会报告错误。[1]

WAL 允许读取与写入同时进行，但同一数据库同时只允许一个写者。[2]

WAL 读取事务持有固定快照，其他连接后续提交不使它自动刷新；基于过期快照升级写入会遇到 SQLITE_BUSY_SNAPSHOT。[3]

普通独立连接读不到另一连接的未提交写入；文档中的例外必须同时满足共享缓存及读取连接启用 read_uncommitted。[3]

BEGIN IMMEDIATE 在开始时尝试取得写入事务；另一连接已有写入事务时可能返回 SQLITE_BUSY。[4]

## 输出与机械评分

执行者输出六个 `claims`，每个包含 `id`、指定类型的 `facts` 、`source_ids` 和 `quotes`。引用项包含 `source_id`、`excerpt_id` 与 `text`，URL 从对应 source 读取，并覆盖该 claim 的所有要求摘录。允许附带解释，但不能用解释修正错误的结构化事实。

事实判定使用 `expected_claims[].required_facts` 深度相等；ID 必须各出现一次。引用判定逐条检查 source ID 存在、excerpt 属于对应 source、quote 与完整摘录相等，并确认它确实存在于冻结 `source.text`。这刻意把评分限制在结构化结论及出处存在性，不能推断自由文本的全面正确性。

源包校验先重新计算 `SHA256(source.text)`，再校验 `word_count` 和摘录包含关系；检索时间是本次收集时间，不充当文档发布时间或适用于所有 SQLite 构建的保证。

## 缺陷注入建议

| Fixture | 受影响项 | 注入方式 | 预期问题 |
| --- | --- | --- | --- |
| foreign-keys-global | R1 | 将连接级配置替换为数据库文件级配置 | 正确 URL 搭配错误作用域 |
| foreign-keys-active-toggle | R2 | 把事务内 no-effect 改为 enabled-immediately | 无错误被误当成配置生效 |
| wal-many-writers | R3 | 将同时写者数从 1 改为 2 | 读写并发被误当成写写并发 |
| snapshot-refresh | R4 | 将其他连接提交后的可见性改为 true | 快照边界被抹去 |
| uncommitted-exception-one-condition | R5 | 删除 shared-cache 必要条件 | 只保留一个条件的错误例外 |
| immediate-never-busy | R6 | 将起始锁冲突可能性改为 false | 写事务获取被当成无条件成功 |
| correct-facts-wrong-evidence | R4 | 用 S3.E3 替代快照相关引用 | 事实正确、验收证据不适用 |
| broken-citation | R3 | 把 source ID 改为 S99 | 引用不存在 |

这些只是缺陷构造候选。主实验冻结四类交付：合格、覆盖缺口、证据过期、结论无依据；每类重复两次，本场景共八个配对单元。实施前固定选用的 fixture、顺序和角色预算，不得根据模型已表现好的缺陷追加样本来支撑既定结论。

## Auditor 的测量对象

Orchestrator 负责业务验收，必须逐项比对事实及引用覆盖；Auditor 审查这次验收是否实际执行、证据是否适用于相同结果版本，以及通过结论是否有依据。Auditor 不替 Orchestrator 产出六条业务结论，也不使用隐藏 oracle 替代独立判断。

每个配对单元先运行真实 Orchestrator 初验并保留原始决定，然后在相同交付与验收记录下比较 Orchestrator 恢复自审及新 Auditor 独立审核。记录错误放行、有效结果误拒、补充验收动作和成本。模型只获得官方摘录和候选报告，`expected_claims` 留在隐藏 oracle；运行后才对决定评分。结果仅说明局部验收审查能力，不能声称它改善了从检索到交付的完整研究流程。

## 冻结材料验收

专用 ledger 的引用与逐字证据需通过 `sources.py verify --strict --evidence`。每页证据已经由脚本对本次实际抓取页面进行字面匹配；引用完整性检查不等同于证明每个自然语言推断都正确。

## Sources

[1] https://www.sqlite.org/foreignkeys.html
[2] https://www.sqlite.org/wal.html
[3] https://www.sqlite.org/isolation.html
[4] https://www.sqlite.org/lang_transaction.html
