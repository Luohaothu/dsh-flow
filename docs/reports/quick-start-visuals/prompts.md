# 快速上手配图提示词与布局约束

工具：内置 image_gen；未使用 CLI/API 生图。

此记录供维护人员复用，不进入 VitePress 导航或站点构建。配图用于描述预期交互，不作为模型实跑成功的证据。实际模型演示已按用户要求停止。最终图以现有 dsh 界面为底，仅替换案例文字、结果与状态。

布局依据：实际模式菜单、输入框、集群管理树、任务详情和会话界面；任务详情的字段顺序同时核对 `packages/dsh-flow/src/client/panel.tsx`。

## 共用约束

```text
Use case: precise-object-edit / ui-mockup. Edit the supplied REAL DeepSeek Harness screenshot into one tutorial frame. CRITICAL: preserve the actual interface layout exactly: sidebar width, existing black DeepSeek logo, all element coordinates, sizes, font sizes, borders, white/grey palette, whitespace, input box shape, and UI labels. This is content replacement ONLY. Do NOT redesign, restyle, add cards, breadcrumbs, avatars, buttons, tabs, progress bars, blue branding, shadows or icons. Preserve the image's original aspect ratio. Render existing controls and Chinese text sharply. No outer captions or watermark. User authorized this authored tutorial; no runtime evidence is implied. Only replace the specific text/status content below.
```

## 图 1：01-cluster-mode.png

成品：`docs/design/public/images/quick-start/01-cluster-mode.png`

```text
Keep every part of this mode-menu screenshot unchanged EXCEPT: select the EXISTING third menu item "集群模式": move the existing checkmark from 标准模式 to 集群模式 and the chip above composer reads 集群模式. Keep all five existing menu items in their actual order and existing dropdown dimensions. Replace description of 集群模式 within its existing lines with "将目标交给一组智能体协作完成。管理节点负责拆解与派发，执行智能体完成任务，审计智能体独立复核。". The actual model selector remains original text. Do not add a title or highlight outline. The actual app layout is mandatory.
```

## 图 2：02-submit-objective.png

成品：`docs/design/public/images/quick-start/02-submit-objective.png`

```text
Preserve this filled composer frame exactly. Replace ONLY the user's long prompt text within the existing textarea with: "帮我核对这次活动的预算：场地费 1500 元、物料费 680 元、茶歇费 420 元，总预算 3000 元。请安排计算和独立复核，告诉我总支出、剩余预算以及是否超预算。完成后用一句话总结。". Retain current composer height and all whitespace even though new text is shorter. Model name, Workspace Write Unattended, folder flow-demo, 集群模式, logo, and send arrow stay EXACTLY unchanged. There are no chat messages or progress cards on this screen.
```

## 图 3：03-cluster-tree.png

成品：`docs/design/public/images/quick-start/03-cluster-tree.png`

```text
Keep the actual dense cluster console unchanged: top header Hierarchical agent cluster, top right RUNNING, Pause Resume Cancel Download report; left cluster list and right Start a cluster form, the existing two rows of compact metrics, all SIX tabs tree transactions communication context health resources, the Management tree disclosure rows, lower Events monospace listing. No role cards, no four-tab redesign. Changes ONLY: sidebar folder "workspace" becomes "flow-demo". Set selected cluster short ID everywhere to a1b2c3d4. Its row remains "a1b2c3d4 · RUNNING · 0/1 accepted". Nodes2, Agents4/4, Active turns1, Transactions1, Ready0, Accepted0. Management tree first row "▾ management b2c3d4e5 · ACTIVE · 0 · 1 tx", indented second row "▸ worker c3d4e5f6 · ACTIVE · 0.0 · ? tx". Keep all original positions. In lower Events keep same small monospace lines, replace content with simple appropriate records such as "#1 cluster-started  活动预算核对", "#2 roles-created  编排智能体、资源分配智能体、审计智能体", "#3 transaction-created  预算核算", "#4 worker-allocated  执行智能体", "#5 tool-call  flow_sum [1500,680,420]". Do not introduce another diagram layout.
```

定向修订提示词：

```text
Make a precise text-only edit; keep the supplied UI layout, all dimensions, fonts, colors, counts, header, sidebar, tree and controls unchanged. Replace only five existing bottom Events rows with:
#1 roles-created {"node_id":"b2c3d4e5","agents":{"orchestrator":"o1","allocator":"a1","auditor":"u1"}}
#2 transaction-created {"transaction_id":"d4e5f6a7","node_id":"b2c3d4e5","parent":null}
#3 dispatched {"transaction_id":"d4e5f6a7","audit_id":"audit1","revision":1}
#4 agent-allocated {"agent_id":"w1","node_id":"b2c3d4e5","transaction_id":"d4e5f6a7","write_scope":[],"capabilities":[]}
#5 tool-call-charged {"call_id":"call1","payer":"a1b2c3d4:agent:w1","tool":"flow_sum","agent_id":"w1"}
Retain monospace. Allow normal line wrap if necessary. Change no other area.
```

## 图 4：04-transaction-result.png

成品：`docs/design/public/images/quick-start/04-transaction-result.png`

```text
This is the EXISTING transactions-detail panel; preserve its actual page layout exactly: top header and buttons, two-column cluster list / Start a cluster form, compact metrics, all SIX tabs, selected transactions tab, bordered plain monospace FIELD LIST (never cards or tables), Close button, transaction row and Events below. Keep sidebar flow-demo and 活动预算核对. Keep all typography sizes and relative coordinates; same 1440x1300 canvas proportions.
Replace only these contents:
Header status "COMPLETED".
Clusters row "a1b2c3d4 · COMPLETED · 1/1 accepted".
Metrics: Cluster a1b2c3d4; Nodes 2; Agents (live/total) 0/4; Active turns 0; Transactions 1; Ready 0; Accepted 1; Open issues 0; Event cursor 10. Other unchanged.
Detail heading "Transaction d4e5f6a7".
Field rows, keep exact sequence and plain monospace style, allow wrapping within existing width:
status ACCEPTED · revision 2 · result revision 2
priority 0 · owner b2c3d4e5 · node c3d4e5f6
objective: 预算核算：核对三项支出、剩余预算及是否超预算。
criteria: ["核算1500、680、420元三项支出","计算3000元总预算的余额","独立复核结果并总结"]
validation: {"checks":[{"criterion":"金额与计算记录一致","passed":true,"evidence":"1500+680+420=2600；3000-2600=400"}],"accepted":true,"notes":"核对通过","by":"e5f6a7b8"}
result: {"total":2600,"remaining":400,"over_budget":false,"summary":"本次活动支出2600元，剩余400元，未超预算。"}
result revision: 2
allocation: none active
audit plan rev1 APPROVED by f6a7b8c9: {"evidence":"输入、目标与验收条件明确"}
audit validation rev2 APPROVED by f6a7b8c9: {"evidence":"已核对工具记录、输入项与剩余预算，结论一致"}
The existing Close button remains. Transaction list row below detail reads "ACCEPTED rev2 · 预算核算：核对三项支出、剩余预算及是否超预算。". Existing "1 of 1 transactions shown." remains.
Events heading "Events (10 shown, cursor #10)". Keep the existing monospace event list structure. Replace visible lines with:
#1 cluster-started {"objective":"活动预算核对"}
#2 roles-created {"node_id":"b2c3d4e5"}
#3 transaction-created {"transaction_id":"d4e5f6a7"}
#4 agent-allocated {"transaction_id":"d4e5f6a7"}
#5 tool-call-charged {"name":"flow_sum"}
#6 result-staged {"transaction_id":"d4e5f6a7"}
#7 transaction-validated {"accepted":true}
#8 audit-approved {"kind":"validation"}
#9 transaction-accepted {"transaction_id":"d4e5f6a7"}
#10 cluster-completed {"cluster_id":"a1b2c3d4"}
These may continue below bottom edge exactly as existing page scroll. Do not squeeze fonts or redesign to fit. Most important visible details are ACCEPTED, validation passed true and accepted true, result2600/400/false, both APPROVED records, COMPLETED and Download report in original top right.
```

定向修订提示词：

```text
Make a precise text-only edit of this image. Keep every part of the real interface layout fixed, all buttons, positions, colors, fonts and sizes. No cards or restyling. Only correct existing detail JSON rows and event rows:
1. In validation JSON, before "by", add "at":1791300600000. Keep every existing check, accepted true, notes and by.
2. Replace the existing audit plan row with:
audit plan rev1 APPROVED by f6a7b8c9: {"requested_by":"e5f6a7b8","evidence":"计划可执行"}
3. Replace audit validation row with:
audit validation rev2 APPROVED by f6a7b8c9: {"proposed_by":"e5f6a7b8","accepted":true,"checks":[{"criterion":"金额一致","passed":true,"evidence":"2600；400"}],"evidence":"独立复核一致"}
Keep normal wrapping within the same detail box, no font shrinking.
4. In bottom Events list, change line #5 to:
#5 tool-call-charged {"tool":"flow_sum","agent_id":"w1"}
change line #7 to:
#7 validation-proposed {"transaction_id":"d4e5f6a7","result_revision":2,"accepted":true,"checks":1}
change line #8 to:
#8 result-accepted {"transaction_id":"d4e5f6a7","result_revision":2}
change line #9 to:
#9 summary-written {"transaction_id":"d4e5f6a7","node_id":"c3d4e5f6"}
change line #10 to:
#10 cluster-completed {"transactions":1}
Keep COMPLETED, ACCEPTED, amounts2600/400/false, Download report top right, all six tabs, all controls and rest of image unchanged.
```

定向修订提示词：

```text
Precise final content consistency edit. Preserve the exact supplied UI screenshot layout and typography. Change NO amounts, status, interface labels, buttons, sizes or positions.
In the detail validation object replace the value of "by" with "o1".
In BOTH audit rows the text "by f6a7b8c9" becomes "by u1".
In the plan audit JSON "requested_by" value becomes "o1".
In the validation audit JSON "proposed_by" value becomes "o1".
At bottom Events, replace ONLY the first five event lines to match the earlier frame of this same tutorial:
#1 roles-created {"node_id":"b2c3d4e5","agents":{"orchestrator":"o1","allocator":"a1","auditor":"u1"}}
#2 transaction-created {"transaction_id":"d4e5f6a7","node_id":"b2c3d4e5","parent":null}
#3 dispatched {"transaction_id":"d4e5f6a7","audit_id":"audit1","revision":1}
#4 agent-allocated {"agent_id":"w1","node_id":"b2c3d4e5","transaction_id":"d4e5f6a7","write_scope":[],"capabilities":[]}
#5 tool-call-charged {"call_id":"call1","payer":"a1b2c3d4:agent:w1","tool":"flow_sum","agent_id":"w1"}
Keep existing Events lines #6 to #10, counts10, result2600/400/false, status COMPLETED, status ACCEPTED, checks accepted true and audits APPROVED unchanged. Keep normal text wrapping. Do not change any other area.
```

定向修订提示词：

```text
Precise minimal text correction. Preserve every part of the supplied interface image, layout, typography, sizes, controls and all other text. Change ONLY three fragments:
1. In the validation.checks object's "evidence" string replace the arithmetic expression with exactly "合计2600元；结余400元". There must be no arithmetic formula or equal signs in that evidence string.
2. In the detail priority/owner/node row replace "node c3d4e5f6" with "node b2c3d4e5". Owner stays b2c3d4e5.
3. In event #9 summary-written JSON replace "node_id":"c3d4e5f6" with "node_id":"b2c3d4e5".
Nothing else changes. Keep all status strings, numbers, result JSON, audits, original interface layout unchanged.
```

## 图 5：05-completed.png

成品：`docs/design/public/images/quick-start/05-completed.png`

```text
Preserve this exact existing conversation layout: narrow actual left sidebar with black DeepSeek logo, main header 活动预算核对 and 集群模式, two tabs 对话 / 轨迹, right aligned pale-blue user message at same coordinates, bottom actual rounded composer with permission/model selectors and footer. Change sidebar workspace to flow-demo. Replace user bubble contents with "帮我核对这次活动的预算：场地费 1500 元、物料费 680 元、茶歇费 420 元，总预算 3000 元。请安排计算和独立复核，告诉我总支出、剩余预算以及是否超预算。完成后用一句话总结。". Replace ONLY the current assistant thinking status area with a plain markdown assistant answer using the existing message column width, NOT a card or new UI. First line "预算核对已完成，计算结果已通过独立复核。"; simple bulleted lines "总支出：2600 元", "剩余预算：400 元", "是否超预算：未超预算"; final paragraph "本次活动总支出 2600 元，剩余预算 400 元，未超出 3000 元的总预算。". No extra buttons, no download button, no progress card, no return button. Replace blue stop square inside existing send circle with its normal up-arrow; preserve its location and dimensions. Keep remaining whitespace and footer.
```
