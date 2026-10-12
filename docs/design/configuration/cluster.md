# Flow 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| dataDir | `.dsh-flow` | 当前契约的协作数据目录 |
| workspace | `.` | 新成员的工作区 |
| preset | `null` | 原生 preset；未指定时沿用正常选择 |
| maxConcurrentAgents | `4` | 同时执行的成员容量 |

用户可在团队创建时明确 deadline_ms。未设置时 Flow 不附加工具次数、角色轮数、模型请求次数或默认业务时限。

Provider 和默认模型保存于宿主 profile。部署 patch 应只配置插件与运行设置，避免覆盖可编辑模型命名空间。数据契约升级使用新目录，旧数据库不会被自动删除或迁移。
