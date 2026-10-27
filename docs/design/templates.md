# 团队模板

团队模板是一份创建图纸，描述成员层级、职责、管理指引和初始群聊。发起 Agent 就是模板的根。创建器按照图纸和参数展开成员，后续工作由实际的 Agent、Group 和作业机制管理。

## 模式包与参数

一个模式包以 `pattern.yaml` 为入口，指引可内联，也可以通过 `{ file: 相对路径 }` 引用包内文件。

```text
patterns/<package>/
  pattern.yaml
  guidance.md
  roles/*.md
```

模板采用 `apiVersion: v1`，用带命名空间的 `id` 标识，例如 `builtin/hierarchical`。ID 在当前模板目录内唯一。`description` 说明组织特点，`whenToUse` 说明适用场景。

`parameters` 直接按名称声明参数，每项包含 `type`、`description` 和可选的 `default`。调用者未传值时使用默认值；没有默认值则必须提供。参数类型支持字符串、整数、数值、布尔、数组、对象和空值，对应 `string / integer / number / boolean / array / object / null`。

`count` 和 `use.with` 的参数值可用纯变量占位符，例如 `"{{ groups }}"`。占位符带引号，YAML 解析后由创建器做整值替换，保留实际数据类型。数量须为非负整数，默认 `1`；数量为 `0` 时跳过该节点及后代。

## 层级、角色与指引

`root.instructions` 提供给现存根 Agent 的管理指引。其余字段直接命名直属成员，每个成员通过 `role` 引用本模板的角色定义，并可继续用字段名定义下级成员。

`roles` 说明各角色职责，以及预设、附加技能、模型、推理参数和初始权限。每个节点默认具备 `team-strategy`，模板的 `skills` 只需列出附加技能。

配置依次采用运行默认值、角色配置和本次显式覆盖。创建子节点时，同时检查其初始权限不高于父级。`instructions` 是根的保留字段，`role / count / use` 是成员节点的保留字段。

## 引用其他模板

成员节点的 `use` 是一个对象：`id` 指定被引用模板，`with` 位于 `use` 之下，为这次引用传递参数。参数值可以是常量，也可以引用外层模板的参数。被引用模板再按自己的声明补充默认值。

引用位置的当前节点就是对方模板的 `root`。该节点的身份和配置由外层角色定义，对方的根指引追加到该角色指引之后；其下成员的角色从对方自己的 `roles` 中解析。成员节点的下级结构采用内联定义或 `use` 引用，两种方式择一使用。

下面的模板为每个组长复用资料共享与核验结构。`groups` 默认是 `1`；`membersPerGroup` 必须由调用者提供，并传给被引用模板的 `members` 参数。

```yaml
apiVersion: v1
id: builtin/hierarchical
description: 各组长的子树引用资料共享与核验模板，一次创建成员后逐层派发作业并汇总结果。
whenToUse: 子问题仍需拆分，但各层能以明确结果和业务归属交接。
parameters:
  groups:
    type: integer
    description: 群组数量，每个研究方向对应一个群组
    default: 1
  membersPerGroup:
    type: integer
    description: 每组资料收集成员数量，核验者和审查者另行创建
roles:
  lead:
    permission: read-only
    instructions: 管理本组直属成员。根据所承接作业拆分任务，逐项制定背景、需求、验收标准和结果 schema，读取结果后决定后续安排。
  integrator:
    instructions: 读取组长的实际交付，核对来源作业、证据和未完成事项，形成当前作业要求的整合结果。
    permission: read-only
root:
  instructions: |-
    按任务选定组数与每组资料收集者数量，向引用的模板传参，一次建立完整多层结构。创建完成后，向直属组长派发任务，由组长分别为自己的直属成员制定子作业，并明确其上级作业。
    跨组信息通过协调群共享。读取组长的交付后，可向直属汇总者派发整合作业。各级成员需要扩充组织时可以自行应用模板，任务和结果始终按实际作业父子关系追踪。
  leads:
    role: lead
    count: "{{ groups }}"
    use:
      id: builtin/shared-review
      with:
        members: "{{ membersPerGroup }}"
  integrator:
    role: integrator
groups:
  - key: coordination
    members:
      - root
      - root/leads/*
      - root/integrator/0
```

传入 `groups: 2` 和 `membersPerGroup: 3` 时，创建两名组长，每名组长下创建三名资料收集者、一名核验者和一名审查者，同时创建一名根的直属汇总者。模板只建立成员与协作关系，具体作业随后由各级父 Agent 派发。

## 初始群与节点路径

节点路径从 `root` 开始，由字段名和从零开始的序号组成。例如 `root/leads/0/contributors/1` 表示第一名组长下面的第二名资料收集者。`*` 匹配路径中的一级序号。

`groups` 使用这些路径指定初始群成员。没有 `forEach` 时，以模板根为选择起点；有 `forEach` 时，为每个匹配节点建立一个群，`.` 表示该节点，`./` 表示它下面的相对路径。

被引用模板以引用节点作为自己的根。例如第一组的讨论群返回键为 `root/leads/0/discussion`。外层模板也可用完整展开路径选取组内成员。创建后，群具有实际的 GroupID 和固定成员集合，后续按 [群聊规则](communication.md#群聊与共享黑板) 使用。

## 加载与使用

内置和用户模板使用同一加载器。加载时解析指引文件、角色与 `use.id`，检查参数声明、默认值和引用无环；创建前完成各层参数、数量和群成员校验。

`flow_patterns` 列出模板，`flow_pattern_apply` 按图纸创建成员。研究型 Agent 可通过 `flow_pattern_define` 提交同格式的候选定义，在当前运行内使用。候选模板注册、成员创建和评估作业派发分别进行。

## 参考模板

以下模板提供组织经验。实际任务、结果 schema、协作轮次和结果取舍由 Agent 根据当前工作决定。

| 模板 ID | 协作形式 | 组织与管理指引 |
| --- | --- | --- |
| [builtin/independent-vote](/patterns/independent-vote/pattern.yaml) | 独立采样与投票 | 创建独立求解者和评审者，根组织独立初答、证据核验和计票。 |
| [builtin/heterogeneous-ensemble](/patterns/heterogeneous-ensemble/pattern.yaml) | 异构模型集成 | 创建使用不同模型的求解者和汇总者，根按本次任务说明权重与合成依据。 |
| [builtin/debate](/patterns/debate/pattern.yaml) | 辩论 | 创建辩论者和评审者；根决定何时交换论点、要求修订或交付结论。 |
| [builtin/expert-router](/patterns/expert-router/pattern.yaml) | 专家协调 | 建立不同专长的成员，根根据任务选择需要的专家和核验者。 |
| [builtin/pipeline](/patterns/pipeline/pattern.yaml) | 流水线分工 | 建立计划、制作、核验和汇总角色，根按依赖与实际结果安排交接。 |
| [builtin/hierarchical](/patterns/hierarchical/pattern.yaml) | 多层管理 | 为各组长引用资料共享与核验模板并传参，一次创建完整子树，随后逐层派发作业。 |
| [builtin/mixture-of-agents](/patterns/mixture-of-agents/pattern.yaml) | 分层合成 | 建立提议、提炼和汇总成员；信息处理层次由根组织，不改变作业只能向直属成员派发的关系。 |
| [builtin/generate-review-revise](/patterns/generate-review-revise/pattern.yaml) | 生成、审查与修订 | 保留作者及独立审查、核验成员，根根据反馈继续派发修订任务。 |
| [builtin/tool-specialists](/patterns/tool-specialists/pattern.yaml) | 工具专家 | 模板声明职责和初始权限，根按需通过节点路径覆盖补充预设与附加技能；通过作业交接材料及真实工具产物。 |
| [builtin/search-swarm](/patterns/search-swarm/pattern.yaml) | 分组搜索 | 创建各搜索组及组长，以局部群共享线索，由各级父节点按先到结果调整工作。 |
| [builtin/workflow-search](/patterns/workflow-search/pattern.yaml) | 组织方案搜索 | 创建模板设计和评估成员，根根据真实创建与作业结果选择后续方案。 |
| [builtin/sparse-routing](/patterns/sparse-routing/pattern.yaml) | 稀疏通信 | 创建观察、路由建议和处理角色，跨分支信息通过定向消息或局部群转交。 |
| [builtin/shared-review](/patterns/shared-review/pattern.yaml) | 资料共享与核验 | 创建收集、核验和审查成员，通过群消息与黑板共享资料，通过作业交付核验结果。 |
| [builtin/tournament-evolution](/patterns/tournament-evolution/pattern.yaml) | 锦标赛与演化 | 创建候选生成、比较和选择成员，根保留谱系与多样性，根据证据安排下一轮。 |
