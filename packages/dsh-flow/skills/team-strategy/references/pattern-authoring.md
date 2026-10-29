# 创作与交付团队模式

团队模式是创建成员树的可编译图纸。模式保存长期职责、管理指引、参数和可选初始群；具体任务、材料、验收要求与结果 schema 在应用后通过正式作业交接。组织和规模依据任务选择。

先核对当前安装版本的完整模式包与公开类型。dsh-flow 安装包的 patterns/ 保存内置包，lib/types/patterns/ 保存类型，公开入口为 dsh-flow/patterns。以实际编译和加载结果确认格式。

## 标准定义与文件

可供目录加载的包使用以下结构，所有引用文件随包交付：

```text
my-pattern/
  pattern.yaml
  guidance.md
  roles/
    worker.md
```

pattern.yaml 的顶层字段为 apiVersion、id、description、whenToUse、parameters、roles、root 和可选 groups。apiVersion 为 v1，id 采用命名空间。parameters 按参数名声明类型、说明和可选默认值。roles 按角色名声明 instructions 及可选 preset、skills、model、params、permission、hostExtras。instructions 可以是正文或包内相对文件引用。

root.instructions 提供给应用模板的现存根，其余 root 字段直接命名直属成员。成员节点以 role 引用本包角色，count 默认为 1，也可使用完整参数占位符；use 可以引用其他模板并传参。应用保留现存根的身份与 Profile。角色配置用于新建成员，职责中的文字约束与 permission 等实际配置分别核对。

以下是格式示例。职责、数量和权限均应按实际任务调整：

```yaml
apiVersion: v1
id: example/work-items
description: 对可独立核对的工作项分配成员。
whenToUse: 工作可分解为独立项，且需要汇总核对依据。
parameters:
  members:
    type: integer
    description: 根据工作项与协调成本选择的成员数量。
    default: 1
roles:
  worker:
    instructions: { file: roles/worker.md }
    permission: read-only
root:
  instructions: { file: guidance.md }
  workers:
    role: worker
    count: "{{ members }}"
```

guidance.md 描述根如何按实际作业拆分、派发、收集依据和决定后续工作；roles/worker.md 描述成员的长期职责与交接要求。当前业务结果不写成模板的固定答案。引用其他模板时交付所需依赖，并核对对方参数；同名 ID 冲突和缺失引用均以目录诊断为准。

## 当前 Run 中的候选

Flow 成员工具 flow_pattern_define 接收 document 与可选 assets。document 的三种既有形式是 YAML 字符串、`{ kind: 'yaml', text, path? }` 或 `{ kind: 'object', value, path? }`。value 是符合上述标准字段的定义对象。assets 是包内相对路径到文件文本的映射，供文件和模板依赖解析使用。

```js
const request = {
  document: { kind: 'object', value: definition },
  assets: {
    'guidance.md': rootGuidance,
    'roles/worker.md': workerInstructions,
  },
};
```

将这份输入交给真实成员工具，成功回执为 `{ ok: true, patternId }`，失败时读取实际诊断或工具错误。成功只把定义登记到当前 Run。之后按需要分别应用模式、向直属成员派发正式作业并读取结果。

工具请求的 document/assets 包装不是目录文件格式。注册不创建持久包，也不自动让其他 Run 获得候选。

## 持久交付与验收

需要以后复用时，保存标准 pattern.yaml 与它引用的全部资源。导入者在 dsh-flow 插件设置的模式包来源中加入该包目录，或包含完整模式包的父目录，保存后查看诊断。新 Run 读取保存后的目录快照；既有 Run 保留创建时的快照。

用当前安装版本公开导出的 PatternCatalog 读取实际落盘目录，核对候选是否在 list() 中出现、resolve(id) 是否成功及 diagnostics。例如在能解析当前安装包的验证环境中：

```js
import { PatternCatalog } from 'dsh-flow/patterns';

const catalog = new PatternCatalog({ sources: [{ directory: packageDirectory }] });
const listed = catalog.list();
const resolved = catalog.resolve(authoredPatternId);
```

记录实际使用的目录、候选身份、诊断和解析结果；对本任务所需参数与依赖继续核对。纯编译通过只证明定义可接纳，成员创建、角色权限、正式作业和业务交付仍需实际验证。交付说明应给出原始文件位置、完整依赖、普通设置导入步骤、在新 Run 中发现使用的方式，以及已验证和仍未验证的边界。接收者应能照说明使用原始交付。
