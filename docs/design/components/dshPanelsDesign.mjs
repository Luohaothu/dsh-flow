import { PALETTES, renderCard, statusBadge, icon } from './agentCardDesign.mjs'
import { renderHostSidebar } from './dshNavigationDesign.mjs'

const LOGO = `<path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"/>`
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[ch]))
const clamp = n => Math.max(0, Math.min(1, n))
const ease = n => 1 - (1 - clamp(n)) ** 3
const txt = (x, y, value, size = 13, fill = '#253247', weight = 400, attributes = '') => `<text x="${x}" y="${y}" fill="${fill}" style="font-size:${size}px;font-weight:${weight};stroke:none;font-variant-numeric:tabular-nums" ${attributes}>${escape(value)}</text>`
const rect = (x, y, w, h, fill, stroke = 'none', r = 6, attributes = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ${attributes}/>`
const line = (d, stroke, width = 1.5, attributes = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${attributes}/>`

function uiIcon(name, x, y, size, color) {
  const paths = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    down: '<path d="M12 4v16m-5-5 5 5 5-5"/>',
    restore: '<path d="M4 10h10a6 6 0 0 1 0 12M4 10l5-5m-5 5 5 5" transform="translate(0 -2)"/>',
    inherit: '<path d="m10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
    snapshot: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 2v6m8-6v6M4 11h16m-11 5h6"/>',
    admission: '<path d="M3 6h12M3 12h8M3 18h12m2-10 4 4-4 4m-4-4h8"/>',
    restart: '<path d="M20 7A9 9 0 1 0 21 15M20 2v6h-6"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    tool: '<path d="m8 16 7-7m-5-6a6 6 0 0 0 8 8L9 20a3 3 0 0 1-5-5l9-9A6 6 0 0 0 10 3Z"/>',
    thought: '<path d="M8 17h8m-7 4h6M8 14a7 7 0 1 1 8 0v3H8Z"/>',
    user: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
    plugin: '<path d="M8 3v5m8-5v5M6 8h12v5a6 6 0 0 1-12 0Zm6 11v4"/>',
    chat: '<path d="M4 4h16v12H9l-5 4Z"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  }
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${36 / size}" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.arrow}</svg>`
}

function palette(theme) {
  return { ...PALETTES[theme], canvas: theme === 'dark' ? '#151519' : '#f7f9fb', shell: theme === 'dark' ? '#202126' : '#f4f6f9', line: theme === 'dark' ? '#353842' : '#e3e8ef', blueLine: theme === 'dark' ? '#485f7d' : '#b8cfe9', field: theme === 'dark' ? '#24262d' : '#fbfcfe', danger: theme === 'dark' ? '#e8a19a' : '#b65348', dangerBg: theme === 'dark' ? '#402a2b' : '#fff0ee', success: theme === 'dark' ? '#8ed7aa' : '#28724a' }
}

function shell(p, selected) {
  return rect(16, 16, 1088, 668, p.surface, p.line, 12)
    + renderHostSidebar({ scene:'global', active:true, p, background:p.shell, selected })
    + line('M200 16v668', p.line, 1)
}

function observerBody(name, p, logoId, writer = false, newMessage = false) {
  const x = 734, w = 344
  let body = rect(x + 26, 218, w - 26, 48, p.shell)
  body += uiIcon('user', x, 224, 16, p.muted) + txt(x + 38, 238, writer ? '将研究结论整理为报告初稿。' : '核对公开数据与关键来源。', 13, p.body)
  body += txt(x + 38, 258, writer ? '保留对应依据与引用。' : '保留证据与检索时间。', 13, p.body)
  body += `<use href="#${escape(logoId)}" x="${x}" y="284" width="18" height="18"/>` + txt(x + 26, 297, name, 13, p.text, 500)
  body += txt(x + 26, 322, writer ? '已收到资料，开始组织报告结构。' : '先比对官方资料，再核验统计口径。', 13, p.body)
  body += rect(x + 26, 340, w - 26, 70, p.field, p.line)
  body += uiIcon('thought', x + 38, 352, 14, p.muted) + txt(x + 60, 363, '思考', 12, p.muted) + uiIcon('chevron', x + w - 24, 352, 12, p.muted)
  body += txt(x + 38, 385, writer ? '先梳理趋势，再串联证据与建议。' : '需要统一时间范围与统计单位。', 13, p.body)
  body += rect(x + 26, 426, w - 26, 94, p.field, p.line)
  body += uiIcon('tool', x + 38, 438, 14, p.muted) + txt(x + 60, 449, writer ? 'read_file' : 'web_fetch', 12, p.text, 500, 'font-family="ui-monospace,SFMono-Regular,Menlo,monospace"') + icon('completed', x + w - 25, 437, 16, p.success)
  body += line(`M${x + 38} 461h${w - 50}`, p.line, 1)
  body += txt(x + 38, 480, writer ? 'path  research/notes.md' : 'url  https://example.org/report', 11, p.muted, 400, 'font-family="ui-monospace,SFMono-Regular,Menlo,monospace"')
  body += txt(x + 38, 503, writer ? '返回：6 条结论与对应引用' : '返回：年度报告与发布日期', 12, p.body, 400, 'font-family="ui-monospace,SFMono-Regular,Menlo,monospace"')
  body += txt(x + 26, 549, writer ? '初稿已包含全部关键结论。' : '数据口径已确认，正在整理证据。', 13, p.body)
  if (newMessage) body += `<g opacity="${newMessage}">${txt(x + 26, 577, '新增：已补充两条引用。', 13, p.body)}</g>`
  return body
}

function observerScene(progress, theme, annotated, logoId) {
  const p = palette(theme), t = annotated ? .53 : progress
  const open = t < .15 ? 0 : t < .205 ? ease((t - .15) / .055) : t < .945 ? 1 : 1 - ease((t - .945) / .055)
  const change = ease((t - .62) / .04), loading = t >= .205 && t < .46
  const loaded = ease((t - .42) / .04), name = change > .5 ? '写作者' : '研究者'
  let output = shell(p, '智能体') + txt(222, 51, '智能体团队', 16, p.text, 500)
  output += rect(222, 88, 320, 36, p.surface, p.line) + txt(236, 111, '行业趋势调研', 13, p.text, 500) + uiIcon('chevron',514,100,12,p.muted) + icon('running', 562, 99, 16, p.accent) + txt(587, 112, '2', 12, p.muted)
  output += rect(935, 88, 137, 32, p.shell) + uiIcon('chat', 946, 97, 14, p.muted) + txt(969, 109, '返回发起会话', 12, p.body)
  output += line('M200 162h904',p.line,1) + rect(201, 163, 902, 520, p.canvas, 'none', 0)
  output += `<g clip-path="url(#${logoId}-viewport)">`
  output += line('M454 330v20H330v20M454 350h124v20', p.blueLine)
  output += '<g data-observer-tree="">'
  output += renderCard({ x:346, y:185, name:'主 Agent', taskLines:['组织研究任务，汇总团队结果。','持续协调各成员进度。'], state:'running', count:2, timestamp:'10:25:14', theme, logoId })
  output += renderCard({ x:222, y:370, name:'研究者', taskLines:['核查公开资料与关键数据。','整理可追溯的资料来源。'], state:'running', timestamp:'10:25:19', selected:change < .5 || t >= .945, focused:!annotated && t === 1, theme, logoId })
  output += renderCard({ x:470, y:370, name:'写作者', taskLines:['组织报告结构与文字表达。','引用已核验的研究结论。'], state:change > .5 ? 'running' : 'waiting', timestamp:'10:25:17', input:'2.1k', output:'860', duration:'1m42s', selected:change >= .5 && t < .945, theme, logoId })
  output += '</g>'
  output += '<g><title>观察研究者会话</title>' + rect(406, 527, 32, 32, p.surface, p.line) + uiIcon('arrow', 414, 535, 16, p.accent) + '</g>'
  output += rect(224, 618, 172, 32, p.surface, p.line) + txt(240, 639, '−', 17, p.muted) + txt(270, 638, '100%', 11, p.muted) + txt(320, 639, '+', 17, p.muted) + line('M355 629h-6v6m20 0v-6h-6m-14 12v6h6m8 0h6v-6', p.muted)
  output += `<g data-observer-panel="" opacity="${open}" transform="translate(${376 * (1 - open)} 0)">`
  output += rect(724, 163, 380, 521, '#182e5508', 'none', 0) + rect(728, 163, 376, 521, p.surface, 'none', 0) + line('M728 163v521', p.line, 1)
  output += '<g transform="translate(10 37)">'
  output += rect(734, 138, 214, 32, p.shell) + `<use href="#${logoId}" x="742" y="145" width="18" height="18"/>` + txt(768, 159, name, 13, p.text, 500) + uiIcon('chevron', 926, 149, 12, p.muted)
  output += `<use href="#${logoId}" x="734" y="179" width="12" height="12"/>` + txt(750, 189, 'deepseek-chat', 11, p.muted)
  output += statusBadge({ state:change > .5 ? 'running' : 'running', rotation:t * 720 }, 1020, 144, theme)
  output += rect(1052, 136, 32, 32, p.shell) + uiIcon('close', 1061, 145, 14, p.muted)
  output += line('M734 204h344', p.line, 1)
  if (loading) {
    output += `<g data-observer-loading="" opacity="${1 - clamp((t - .42) / .04)}">`
    ;[[760,224,304,42],[760,290,222,10],[760,312,292,10],[760,348,304,64],[760,438,304,80]].forEach(([x,y,w,h]) => output += rect(x,y,w,h,p.shell))
    output += '</g>'
  }
  output += `<g data-observer-content="" opacity="${loaded}"><g opacity="${1 - change}">${observerBody('研究者', p, logoId)}</g><g opacity="${change}">${observerBody('写作者', p, logoId, true, clamp((t - .74) / .04))}</g></g>`
  const newMessages = t >= .74 && t < .945
  output += rect(831, 599, 153, 32, newMessages ? p.identity : p.surface, newMessages ? 'none' : p.line) + uiIcon('down', 844, 608, 14, newMessages ? p.accent : p.muted) + txt(867, 619, newMessages ? '1 条新消息' : '跟随末尾', 12, newMessages ? p.accent : p.body)
  output += '</g></g></g>'
  if (annotated) output += callouts('O', p, [
    {x:1010,y:192,tx:954,ty:192,title:'成员身份与切换',lines:['名称 13/16，模型 11/14；徽标高 18px。','32px 切换器原位换成员，厂商 Logo 与节点一致。']},
    {x:714,y:407,tx:760,ty:407,title:'原生会话内容',lines:['正文 13px / 20px；内容块间隔 16px。','用户、助手、思考、工具记录完整连续呈现。']},
    {x:1025,y:653,tx:994,ty:653,title:'阅读位置与增量',lines:['按钮距底 16px；滚到末尾后持续跟随。','查看历史时保持原位，新消息汇入蓝色按钮。']},
    {x:1090,y:148,tx:1078,ty:175,title:'侧栏与焦点',lines:['右侧区域宽 376px；220ms 滑入、滑出。','切换时交叉淡入；关闭后焦点回到原节点。']},
  ])
  return output
}

function field(config, p, logoId) {
  const { x, y, w, label, value, changed = false, dirty = changed, model = false, inherit = true, restart = false, transition = 1, previousValue = value } = config
  if (changed && transition < 1) return `<g opacity="${1-transition}">${field({...config, changed:false, dirty:false, value:previousValue, transition:1},p,logoId)}</g><g opacity="${transition}">${field({...config, transition:1},p,logoId)}</g>`
  let output = txt(x, y, label, 12, p.body, 500)
  if (dirty) output += `<circle cx="${x - 8}" cy="${y - 4}" r="2.5" fill="${p.accent}"><title>未保存的覆盖值</title></circle>`
  output += rect(x, y + 12, w, 34, changed ? p.identity : p.field, changed ? p.accent : p.line)
  if (model) output += `<use href="#${logoId}" x="${x + 10}" y="${y + 22}" width="14" height="14"/>`
  output += txt(x + (model ? 32 : 12), y + 34, value, 13, changed ? p.accent : p.body)
  if (model || label === '推理强度') output += uiIcon('chevron', x + w - 23, y + 23, 12, p.muted)
  if (changed) output += `<g><title>恢复继承</title>${uiIcon('restore', x + w - 48, y + 23, 12, p.accent)}</g>`
  if (inherit && !restart) output += uiIcon(changed ? 'snapshot' : 'inherit', x, y + 53, 12, changed ? p.accent : p.muted) + txt(x + 18, y + 63, changed ? '角色覆盖 · 新运行使用' : '继承主会话', 11, changed ? p.accent : p.muted)
  return output
}

function settingsScene(progress, theme, annotated, logoId, outcome) {
  const p = palette(theme), t = annotated ? .45 : progress
  const changedModel = t >= .2, changedEffort = t >= .3, changedPort = t >= .4
  const saving = t >= .5 && t < .7, done = t >= .7, success = done && outcome === 'success'
  const feedback = ease((t - .7) / .04)
  const dirty = !success && (changedModel || changedEffort || changedPort), fail = done && outcome === 'error', conflict = done && outcome === 'conflict'
  let output = shell(p, '插件') + txt(222, 51, '插件 / dsh-flow', 16, p.text, 500)
  output += txt(224, 105, 'dsh-flow', 18, p.text, 600) + txt(325, 105, '设置', 13, p.body)
  output += rect(1004, 88, 66, 24, p.completed[0]) + `<circle cx="1017" cy="100" r="3" fill="${p.success}"/>` + txt(1027, 104, '已启用', 11, p.success)
  output += line('M220 126h856', p.line, 1)
  const groups = [ ['运行默认值','snapshot','新运行使用完整配置快照'], ['角色配置','snapshot','新运行使用完整角色快照'], ['执行与清理','admission','容量用于后续准入；清理时限进入新运行快照'], ['服务连接','restart','保存并重启后采用新连接配置'] ]
  groups.forEach(([label, ico, title],i) => {
    const y = 168 + i * 48
    output += `<g><title>${title}</title>`
    if (i === 1) output += rect(220, y - 22, 172, 36, p.identity)
    output += uiIcon(ico, 233, y - 14, 16, i === 1 ? p.accent : p.muted) + txt(259, y, label, 13, i === 1 ? p.accent : p.body, i === 1 ? 500 : 400)
    output += '</g>'
  })
  output += txt(234, 389, '配置生效', 11, p.muted)
  output += uiIcon('snapshot', 234, 407, 12, p.muted) + txt(254, 418, '新运行快照', 11, p.muted)
  output += uiIcon('admission', 234, 435, 12, p.muted) + txt(254, 446, '后续执行准入', 11, p.muted)
  output += uiIcon('restart', 234, 463, 12, p.muted) + txt(254, 474, '重启服务生效', 11, p.muted)
  output += line('M406 144v446', p.line, 1)
  output += txt(434, 169, '角色配置', 14, p.text, 500) + rect(864, 146, 190, 32, p.field, p.line) + txt(876, 167, '研究者', 13, p.body) + uiIcon('chevron', 1028, 157, 12, p.muted)
  output += field({x:434,y:211,w:298,label:'模型',value:changedModel ? 'deepseek-reasoner' : 'deepseek-chat',changed:changedModel,dirty:changedModel && !success,model:true,transition:ease((t-.2)/.03),previousValue:'deepseek-chat'},p,logoId)
  output += field({x:756,y:211,w:298,label:'推理强度',value:changedEffort ? 'high' : 'medium',changed:changedEffort,dirty:changedEffort && !success,transition:ease((t-.3)/.03),previousValue:'medium'},p,logoId)
  output += txt(434, 310, '职责', 12, p.body, 500) + rect(434, 322, 620, 44, p.field, p.line) + txt(446, 342, '检索公开资料、核对关键数据，形成带引用的研究结论。', 13, p.body)
  output += field({x:434,y:393,w:298,label:'Preset',value:'research',inherit:false},p,logoId)
  output += field({x:756,y:393,w:298,label:'Skills',value:'web-search · evidence-check',inherit:false},p,logoId)
  output += line('M434 458h620', p.line, 1) + txt(434, 482, '服务连接', 13, p.text, 500)
  output += `<g><title>服务连接配置在重启服务后生效</title>${uiIcon('restart', 1028, 469, 16, p.muted)}</g>`
  output += field({x:434,y:507,w:172,label:'端口',value:changedPort ? '4180' : '4175',changed:changedPort,dirty:changedPort && !success,transition:ease((t-.4)/.03),previousValue:'4175',inherit:false,restart:true},p,logoId)
  output += field({x:630,y:507,w:424,label:'状态目录',value:'~/.dsh/flow/state',inherit:false,restart:true},p,logoId)
  if (fail) output += `<g opacity="${feedback}">` + rect(434, 564, 620, 30, p.dangerBg) + icon('failed', 444, 571, 14, p.danger) + txt(466, 584, '保存失败：配置文件写入失败。修改已保留，可重新保存。', 12, p.danger) + '</g>'
  if (conflict) {
    output += `<g opacity="${feedback}">` + rect(420, 452, 648, 144, p.surface, p.accent, 8)
    output += icon('failed', 434, 466, 16, p.waiting[1]) + txt(459, 479, '配置已被更新 · 本地修改已保留', 13, p.text, 500)
    output += rect(434, 493, 298, 45, p.identity) + txt(446, 510, '本地草稿', 11, p.accent) + txt(446, 529, '端口 4180', 13, p.body)
    output += rect(744, 493, 310, 45, p.field, p.line) + txt(756, 510, '最新配置', 11, p.muted) + txt(756, 529, '端口 4190', 13, p.body)
    output += rect(804, 551, 108, 30, p.field, p.line) + txt(821, 571, '重新读取', 12, p.body)
    output += rect(922, 551, 132, 30, p.identity) + txt(940, 571, '比较后保存', 12, p.accent) + '</g>'
  }
  output += rect(420, 608, 650, 50, p.surface, p.line, 8)
  const message = success ? '已保存' : saving ? '正在保存…' : dirty ? `${[changedModel,changedEffort,changedPort].filter(Boolean).length} 项待保存` : '已保存'
  if (success || !dirty) output += icon('completed', 434, 624, 16, p.success)
  else if (saving) output += `<g transform="rotate(${t * 1440} 442 632)">${icon('running', 434, 624, 16, p.accent)}</g>`
  else output += `<circle cx="442" cy="632" r="3" fill="${p.accent}"/>`
  output += txt(460, 637, message, 12, success ? p.success : p.body)
  if (success) output += `<g><title>连接字段重启服务后生效；角色设置用于新运行。</title>${uiIcon('restart', 548, 625, 14, p.muted)}${txt(569,637,'端口 · 重启生效',11,p.muted)}</g>`
  const button = (state, opacity = 1) => {
    const enabled = state === 'dirty' || state === 'error' || state === 'conflict'
    let buttonSvg = `<g opacity="${opacity}">` + rect(916, 617, 138, 32, enabled ? p.accent : p.shell)
    const color = enabled ? '#fff' : p.muted
    if (state === 'saving') buttonSvg += `<g transform="rotate(${t*1440} 943 633)">${icon('running',935,625,16,p.accent)}</g>`
    if (state === 'success') buttonSvg += icon('completed',946,626,14,p.success)
    const label = {dirty:'保存修改',error:'重新保存',conflict:'比较后保存',saving:'保存中…',success:'已保存',saved:'已保存'}[state]
    return buttonSvg + txt(state==='saving' || state==='success' ? 994 : 985,638,label,12,state==='success'?p.success:color,500,'text-anchor="middle"') + '</g>'
  }
  output += done ? button('saving',1-feedback)+button(outcome==='success'?'success':outcome,feedback) : button(saving?'saving':dirty?'dirty':'saved')
  if (annotated) output += callouts('S', p, [
    {x:210,y:216,tx:231,ty:216,title:'插件设置分组',lines:['导航行高 36px、间隔 12px；蓝色标记当前组。','快照、执行准入、重启图标表达各组生效时机。']},
    {x:1080,y:240,tx:1054,ty:240,title:'表单字段',lines:['正文 13px；标签 12px；控件高 34px。','左右字段间隔 24px；模型前使用厂商 Logo。']},
    {x:742,y:273,tx:709,ty:246,title:'继承与覆盖',lines:['继承值用灰色链条；覆盖值以蓝色边框强调。','蓝点标记未保存字段；回转箭头恢复上层配置。']},
    {x:1080,y:632,tx:1054,ty:632,title:'保存与反馈',lines:['底部保存条高 50px；保存时旋转、成功打勾。','失败保留草稿；冲突并列比较本地与最新值。']},
  ])
  return output
}

function callouts(prefix, p, entries) {
  return entries.map((entry, i) => {
    const x = 26 + (i % 2) * 546, y = 720 + Math.floor(i / 2) * 82
    return line(`M${entry.x} ${entry.y}L${entry.tx} ${entry.ty}`, p.blueLine, 1)
      + `<circle cx="${entry.x}" cy="${entry.y}" r="12" fill="${p.accent}"/>`
      + txt(entry.x, entry.y + 4, `${prefix}${i + 1}`, 10, '#fff', 600, 'text-anchor="middle"')
      + rect(x, y, 522, 70, p.surface, p.line, 9)
      + rect(x + 14, y + 12, 28, 20, p.identity, 'none', 5)
      + txt(x + 28, y + 26, `${prefix}${i + 1}`, 10, p.accent, 600, 'text-anchor="middle"')
      + txt(x + 52, y + 27, entry.title, 14, p.text, 500)
      + txt(x + 16, y + 47, entry.lines[0], 12, p.body)
      + txt(x + 16, y + 63, entry.lines[1], 12, p.muted)
  }).join('')
}

export function renderPanelScene({ scene = 'observer', progress = 1, theme = 'light', annotated = false, logoId = 'dsh-panel-logo', outcome = 'success' } = {}) {
  const height = annotated ? 900 : 700, p = palette(theme), id = escape(logoId)
  const title = scene === 'observer' ? 'DSH 成员观察侧栏' : 'DSH 插件设置'
  const content = scene === 'observer' ? observerScene(clamp(progress),theme,annotated,id) : settingsScene(clamp(progress),theme,annotated,id,outcome)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-labelledby="${id}-title ${id}-desc" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;stroke:none"><title id="${id}-title">${title}</title><desc id="${id}-desc">${scene === 'observer' ? '同一右侧区域展示成员切换、原生消息、思考与工具内容，增量跟随及关闭返回焦点。' : '插件详情内的四组配置、继承与覆盖、保存进度、错误及冲突比较。'}</desc><defs><symbol id="${id}" viewBox="0 0 24 24">${LOGO}</symbol><clipPath id="${id}-viewport"><rect x="201" y="163" width="902" height="521"/></clipPath></defs>${rect(0,0,1120,height,p.canvas,'none',16)}${content}</svg>`
}
