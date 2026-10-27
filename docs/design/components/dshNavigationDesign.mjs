import { CARD, PALETTES, renderCard, cardLayout, statusBadge, icon } from './agentCardDesign.mjs'

const LOGO = `<symbol id="deepseek-logo" viewBox="0 0 24 24"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"/></symbol>`
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]))
const clamp = value => Math.min(1, Math.max(0, value))
const phase = (value, start, end) => clamp((value - start) / (end - start))
const ease = value => 1 - (1 - value) ** 3
const paths = {
  chat: '<path d="M4 4h16v12H9l-5 4Z"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  return: '<path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.1M4 12h.1M4 18h.1"/>',
  send: '<path d="m3 4 18 8-18 8 3-8Zm3 8h15"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
}

function hostIcon(name, x, y, size = 16, color = 'currentColor') {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" color="${color}" stroke-width="${36 / size}" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.grid}</svg>`
}
function text(x, y, value, size, color, weight = 400, extra = '') {
  return `<text x="${x}" y="${y}" fill="${color}" style="font-size:${size}px;font-weight:${weight};stroke:none;font-variant-numeric:tabular-nums" ${extra}>${esc(value)}</text>`
}
function rect(x, y, width, height, fill, stroke, radius = 6, extra = '') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''} ${extra}/>`
}
function button(x, y, name, p, active = false, description) {
  const label = description ?? ({ arrow: '观察成员会话', return: '返回发起会话', settings: '打开宿主设置', send: '发送消息' }[name] ?? name)
  return `<g role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>` + rect(x, y, 32, 32, active ? p.identity : p.surface, p.border, 6) + hostIcon(name, x + 8, y + 8, 16, active ? p.accent : p.muted) + '</g>'
}
function marker(id, x, y, targetX, targetY, p) {
  return `<path d="M${x} ${y}L${targetX} ${targetY}" fill="none" stroke="${p.accent}" stroke-width="1.2"/>` + rect(x - 15, y - 12, 30, 24, p.accent, undefined, 7) + text(x, y + 4, id, 11, '#fff', 600, 'text-anchor="middle"')
}
function legend(id, x, y, title, first, second, p) {
  return rect(x, y - 16, 30, 24, p.accent, undefined, 7) + text(x + 15, y, id, 11, '#fff', 600, 'text-anchor="middle"') + text(x + 42, y, title, 14, p.text, 500) + text(x + 42, y + 24, first, 12, p.body) + text(x + 42, y + 44, second, 12, p.muted)
}

const runs = [
  { title: '方案研究 · 技术路线', chat: '技术路线研究', root: '协调者', left: '研究者', right: '写作者', rootTask: ['组织资料检索与方案撰写', '汇总成员结果形成技术路线'], leftTask: ['检索相关资料，核对', '关键结论与证据。'], rightTask: ['整理方案正文，等待', '研究分支返回结论。'], time: '10:25', state: 'running' },
  { title: '界面审查 · 节点卡片', chat: '界面设计检查', root: '协调者', left: '审查者', right: '整理者', rootTask: ['检查节点卡片与交互动效', '汇总各视图的设计差异'], leftTask: ['核对卡片字号、间距', '与状态徽标的位置。'], rightTask: ['整理修订项，等待', '审查分支返回结果。'], time: '10:32', state: 'running' },
]

export function renderHostSidebar({ scene = 'global', active = true, p = PALETTES.light, background = '#f5f7fa', selected } = {}) {
  const globalSelected = selected === '智能体' || (selected !== '插件' && scene === 'global' && active)
  const pluginSelected = selected === '插件'
  let body = rect(16, 16, 184, 668, background, undefined, 10) + `<path d="M200 16v668" stroke="${p.border}"/>`
  body += text(36, 49, 'DSH', 16, p.text, 600) + button(152, 29, 'settings', p)
  body += rect(30, 78, 156, 32, p.surface, p.border, 6) + hostIcon('chat', 40, 86, 16, p.muted) + text(66, 99, '新会话', 12, p.text)
  body += rect(30, 124, 156, 36, globalSelected ? p.identity : 'none', undefined, 6) + icon('branch', 40, 134, 16, globalSelected ? p.accent : p.muted) + text(66, 147, '智能体', 13, globalSelected ? p.accent : p.text, globalSelected ? 500 : 400)
  body += text(36, 198, '会话', 11, p.muted)
  const sessions = ['技术路线研究', '界面设计检查', '资料整理']
  sessions.forEach((name, index) => {
    const selected = scene === 'session' && index === 0
    body += rect(30, 212 + index * 38, 156, 32, selected ? p.identity : 'none', undefined, 6) + hostIcon('chat', 40, 220 + index * 38, 14, selected ? p.accent : p.muted) + text(62, 233 + index * 38, name, 12, selected ? p.accent : p.body)
  })
  body += `<path d="M30 626h156" stroke="${p.border}"/>` + rect(30, 634, 156, 36, pluginSelected ? p.identity : 'none', undefined, 6) + hostIcon('grid', 40, 644, 16, pluginSelected ? p.accent : p.muted) + text(66, 657, '插件', 12, pluginSelected ? p.accent : p.body, pluginSelected ? 500 : 400)
  return body
}

function controls(p) {
  let body = rect(226, 636, 106, 32, p.surface, p.border, 6) + rect(230, 640, 47, 24, p.identity, undefined, 4)
  body += icon('branch', 244, 644, 16, p.accent) + hostIcon('list', 296, 644, 16, p.muted)
  body += rect(620, 636, 188, 32, p.surface, p.border, 6) + text(636, 657, '−', 17, p.muted) + text(679, 656, '100%', 11, p.muted, 400, 'text-anchor="middle"') + text(714, 657, '+', 17, p.muted) + hostIcon('expand', 745, 644, 16, p.muted) + icon('branch', 780, 644, 16, p.muted)
  return body
}

function nodeDetail(name, run, logoId, p, theme, opacity = 1) {
  let body = rect(836, 162, 268, 522, p.surface, undefined, 0) + `<path d="M836 162v522" stroke="${p.border}"/>`
  body += `<g transform="translate(856 184)">${rect(0, 0, 22, 22, p.identity, undefined, 6)}<use href="#${logoId}" x="2" y="2" width="18" height="18"/>${text(30, 12, name, 13, p.text, 500)}<use href="#${logoId}" x="30" y="23" width="12" height="12"/>${text(46, 34, 'deepseek-chat', 11, p.muted)}${statusBadge({ state: 'running' }, 184, 0, theme)}</g>`
  body += button(1060, 230, 'arrow', p, false, `观察${name}的原生会话`) + text(856, 252, '成员会话', 12, p.body)
  body += text(856, 292, '概况', 12, p.accent, 500) + text(918, 292, '收件箱', 12, p.muted) + text(992, 292, '用量', 12, p.muted)
  body += `<path d="M856 302h36" stroke="${p.accent}" stroke-width="2"/><path d="M856 312h228" stroke="${p.border}"/>`
  body += text(856, 340, '当前任务', 11, p.muted) + text(856, 364, run.leftTask[0], 12, p.body) + text(856, 382, run.leftTask[1], 12, p.body)
  body += icon('assignment', 856, 407, 12, p.muted) + text(876, 418, run.left === '审查者' ? '审查结论' : '研究结论', 11, p.body) + text(1078, 418, '↻ 1', 11, p.muted, 400, 'text-anchor="end"')
  body += `<path d="M856 440h228" stroke="${p.border}"/>` + text(856, 467, '本实例', 11, p.muted)
  body += `<path d="M856 491l4-6 4 6Z M936 485h8l-4 6Z" fill="${p.muted}"/>` + text(868, 492, '3.8k', 11, p.muted) + text(948, 492, '1.34k', 11, p.muted) + text(1084, 492, '1m23s', 11, p.muted, 400, 'text-anchor="end"')
  body += icon('history', 856, 511, 12, p.muted) + text(872, 522, '10:25:14', 11, p.muted)
  body += `<g role="img" aria-label="停止${esc(name)}及其所有后代"><title>停止${esc(name)}及其所有后代</title>` + rect(856, 632, 228, 32, p.surface, p.border, 6) + icon('stopped', 922, 640, 16, p.muted) + text(947, 653, '停止此分支', 12, p.body) + '</g>'
  return `<g data-navigation-detail="" opacity="${opacity}">${body}</g>`
}

function tree(run, { logoId, theme, p, selected, appear = 1 }) {
  const common = { logoId, theme, timestamp: '10:25:14', taskLines: run.rootTask, input: '6.2k', output: '2.2k', duration: '1m36s' }
  const root = { ...common, id: 'dsh-root', name: run.root, x: 410, y: 212, count: 2 }
  const left = { ...common, id: 'dsh-member-left', name: run.left, x: 270, y: 397, taskLines: run.leftTask, input: '3.8k', output: '1.34k', duration: '1m23s', selected }
  const right = { ...common, id: 'dsh-member-right', name: run.right, x: 530, y: 397, taskLines: run.rightTask, input: '2.4k', output: '860', duration: '1m12s', state: 'waiting' }
  const rootBottom = root.y + cardLayout(root).height
  let body = text(226, 187, 'Agent', 11, p.muted) + text(262, 187, '3', 11, p.muted) + icon('running', 294, 175, 14, p.running[1]) + text(314, 187, '2', 11, p.muted) + icon('waiting', 342, 175, 14, p.waiting[1]) + text(362, 187, '1', 11, p.muted)
  body += `<path d="M518 ${rootBottom}v20H378q0 0 0 0v20M518 ${rootBottom + 20}h120v20" fill="none" stroke="${theme === 'dark' ? '#41658e' : '#bcd5f0'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
  ;[[518, rootBottom], [378, 397], [638, 397]].forEach(([cx, cy]) => body += `<circle cx="${cx}" cy="${cy}" r="3" fill="${p.surface}" stroke="${theme === 'dark' ? '#41658e' : '#bcd5f0'}" stroke-width="1.5"/>`)
  body += renderCard(root) + renderCard(left) + renderCard(right) + controls(p)
  return `<g data-navigation-tree="" opacity="${appear}" transform="translate(0 ${(1 - appear) * 8})">${body}</g>`
}

function runSelector(run, x, y, width, p, open = false) {
  return rect(x, y, width, 36, p.surface, p.border, 6) + icon('running', x + 12, y + 10, 16, p.running[1]) + text(x + 36, y + 23, run.title, 13, p.text, 500) + `<g transform="rotate(${open ? 180 : 0} ${x + width - 18} ${y + 18})">${hostIcon('chevron', x + width - 26, y + 10, 16, p.muted)}</g>`
}

function runMenu(x, y, p, amount, selectedIndex, logoId) {
  let body = rect(x, y, 350, 150, p.surface, p.border, 8, `filter="url(#${esc(logoId)}-shadow)"`) + text(x + 14, y + 23, '全部运行', 11, p.muted)
  runs.forEach((run, i) => {
    const top = y + 34 + i * 52
    if (i === selectedIndex) body += rect(x + 6, top, 338, 46, p.identity, undefined, 5)
    body += icon('running', x + 14, top + 8, 14, p.running[1]) + text(x + 36, top + 19, run.title, 12, p.text, 500) + hostIcon('chat', x + 36, top + 27, 12, p.muted) + text(x + 54, top + 37, run.chat, 11, p.muted) + text(x + 330, top + 19, run.time, 11, p.muted, 400, 'text-anchor="end"')
    if (i === selectedIndex) body += icon('completed', x + 315, top + 28, 14, p.accent)
  })
  return `<g data-navigation-menu="runs" opacity="${amount}" transform="translate(0 ${(1 - amount) * -6})">${body}</g>`
}

function teamMenu(p, amount, selected, logoId, theme) {
  const x = 690, y = 91
  let body = rect(x, y, 394, 378, p.surface, p.border, 8, `filter="url(#${esc(logoId)}-shadow)"`)
  const groups = [
    { top: 0, title: '方案研究 · 技术路线', time: '10:25', members: [['协调者', 'running'], ['研究者', 'running'], ['写作者', 'waiting']] },
    { top: 214, title: '证据复核 · 关键结论', time: '09:48', members: [['复核者', 'completed'], ['检索者', 'completed']] },
  ]
  groups.forEach((group, groupIndex) => {
    const groupY = y + group.top
    if (groupIndex) body += `<path d="M${x + 14} ${groupY}h366" stroke="${p.border}"/>`
    body += text(x + 14, groupY + 23, group.title, 12, p.text, 500) + text(x + 374, groupY + 23, group.time, 11, p.muted, 400, 'text-anchor="end"')
    group.members.forEach(([name, state], index) => {
      const top = groupY + 34 + index * 55
      if (selected && groupIndex === 0 && index === 1) body += rect(x + 6, top, 382, 49, p.identity, undefined, 5)
      body += `<use href="#${logoId}" x="${x + 14}" y="${top + 7}" width="18" height="18"/>` + text(x + 42, top + 19, name, 13, p.text, 500) + `<use href="#${logoId}" x="${x + 42}" y="${top + 29}" width="12" height="12"/>` + text(x + 58, top + 40, 'deepseek-chat', 11, p.muted)
      body += statusBadge({ state }, x + 292, top + 7, theme) + button(x + 344, top + 8, 'arrow', p, false, `观察${name}的原生会话`)
    })
  })
  return `<g data-navigation-menu="members" opacity="${amount}" transform="translate(0 ${(1 - amount) * -6})">${body}</g>`
}

function chat(p, amount, logoId) {
  let body = rect(280, 190, 694, 56, p.identity, undefined, 8) + text(300, 214, '/agent-team 梳理技术路线，并核对关键资料。', 13, p.text) + text(300, 234, '已附：研究材料.pdf', 11, p.muted)
  body += `<use href="#${logoId}" x="280" y="280" width="22" height="22"/>` + text(314, 294, 'DeepSeek', 13, p.text, 500) + text(280, 330, '我会安排资料检索与方案撰写，并在团队视图中同步进展。', 13, p.body)
  body += rect(280, 354, 694, 58, p.surface, p.border, 8) + icon('branch', 296, 373, 20, p.accent) + text(330, 378, '方案研究 · 技术路线', 13, p.text, 500) + text(330, 398, '3 位成员', 11, p.muted) + hostIcon('arrow', 936, 375, 16, p.muted)
  body += rect(280, 586, 694, 66, p.surface, p.border, 8) + text(298, 614, '继续对话…', 12, p.muted) + button(926, 603, 'send', p)
  return `<g data-navigation-chat="" opacity="${amount}">${body}</g>`
}

export function renderNavigationScene({ scene = 'global', progress = 1, theme = 'light', annotated = false, logoId = 'dsh-nav-logo' } = {}) {
  progress = clamp(progress)
  theme = theme === 'dark' ? 'dark' : 'light'
  const p = PALETTES[theme], canvas = theme === 'dark' ? '#17181c' : '#f7f9fc', shell = theme === 'dark' ? '#202126' : '#f5f7fa'
  const height = annotated ? 900 : 700
  const logo = LOGO.replace('id="deepseek-logo"', `id="${esc(logoId)}"`)
  let body = rect(0, 0, 1120, height, canvas, undefined, 0) + rect(16, 16, 1088, 668, p.surface, p.border, 10)
  const global = scene === 'global', active = global ? progress > .02 : true
  body += renderHostSidebar({ scene, active, p, background: shell })
  if (global) {
    const enter = ease(phase(progress, 0, .15)), changed = progress >= .55, run = runs[changed ? 1 : 0]
    const menuOpacity = annotated ? 0 : ease(phase(progress, .25, .28)) * (1 - ease(phase(progress, .52, .55)))
    const selected = annotated || progress >= .8
    body += `<g opacity="${enter}" data-navigation-panel="global">`
    body += text(222, 51, '智能体团队', 16, p.text, 500) + text(222, 70, '全部运行', 11, p.muted)
    body += runSelector(run, 222, 88, 320, p, menuOpacity > .1) + hostIcon('chat', 562, 99, 14, p.muted) + text(584, 112, run.chat, 12, p.body) + button(760, 90, 'return', p)
    body += `<path d="M200 162h904" stroke="${p.border}"/>` + rect(200, 163, 636, 521, canvas, undefined, 0)
    body += tree(run, { logoId, theme, p, selected, appear: annotated ? 1 : (changed ? ease(phase(progress, .55, .595)) : 1 - ease(phase(progress, .52, .55))) })
    body += selected ? nodeDetail(run.left, run, logoId, p, theme, annotated ? 1 : ease(phase(progress, .8, .845))) : text(970, 374, '选择节点查看详情', 12, p.muted, 400, 'text-anchor="middle"')
    if (menuOpacity > 0) body += runMenu(222, 130, p, menuOpacity, progress >= .52 ? 1 : 0, logoId)
    body += '</g>'
    if (annotated) {
      body += marker('N1', 176, 119, 150, 142, p) + marker('N2', 548, 85, 526, 106, p) + marker('N3', 810, 110, 776, 106, p) + marker('N4', 1090, 167, 1076, 184, p)
      body += text(30, 720, 'DSH 全局面板 · 1120 × 700 视图；节点卡片按 1:1 展示，宽 216px。', 12, p.muted)
      body += legend('N1', 30, 756, '侧栏智能体入口', '36px 行高；图标 16px，文字 13px。', '蓝色底与前景表示当前面板。', p)
      body += legend('N2', 574, 756, '跨会话运行选择器', '36px 触发器；展开项显示任务、会话与时间。', '选择运行后恢复该运行的视点与折叠状态。', p)
      body += legend('N3', 30, 842, '所属会话与返回入口', '会话名紧随选择器，回转箭头采用 32px 按钮。', '返回准确的发起会话，保留全局面板视图。', p)
      body += legend('N4', 574, 842, '树与节点详情', '复用主体卡片、状态徽标、Token 与时间。', '详情中独立箭头打开成员观察侧栏。', p)
    }
  } else {
    const tabProgress = ease(phase(progress, .2, .245)), selected = annotated || progress >= .68
    const menuOpacity = annotated ? 1 : ease(phase(progress, .4, .43)) * (1 - ease(phase(progress, .65, .68)))
    body += text(222, 51, '技术路线研究', 16, p.text, 500)
    body += rect(970, 31, 112, 32, p.surface, p.border, 6) + icon('branch', 980, 39, 16, p.muted) + text(1006, 52, '团队 2', 12, p.body) + `<g transform="rotate(${menuOpacity * 180} 1062 47)">${hostIcon('chevron', 1054, 39, 16, p.muted)}</g>`
    body += text(234, 96, '对话', 13, tabProgress < .5 ? p.accent : p.muted, tabProgress < .5 ? 500 : 400) + text(306, 96, '智能体', 13, tabProgress >= .5 ? p.accent : p.muted, tabProgress >= .5 ? 500 : 400)
    body += `<path d="M${228 + tabProgress * 72} 108h${36 + tabProgress * 12}" stroke="${p.accent}" stroke-width="2"/><path d="M200 112h904" stroke="${p.border}"/>`
    if (tabProgress < 1) body += chat(p, 1 - tabProgress, logoId)
    if (tabProgress > 0) {
      body += `<g opacity="${tabProgress}" data-navigation-panel="session">` + runSelector(runs[0], 222, 119, 320, p) + text(562, 143, '技术路线研究', 11, p.muted) + button(760, 121, 'return', p)
      body += `<path d="M200 162h904" stroke="${p.border}"/>` + rect(200, 163, 636, 521, canvas, undefined, 0) + tree(runs[0], { logoId, theme, p, selected, appear: 1 })
      body += selected ? nodeDetail('研究者', runs[0], logoId, p, theme) : text(970, 374, '选择节点查看详情', 12, p.muted, 400, 'text-anchor="middle"')
      body += '</g>'
    }
    if (menuOpacity > 0) body += teamMenu(p, menuOpacity, annotated || progress >= .65, logoId, theme)
    if (annotated) {
      body += marker('T1', 389, 92, 348, 99, p) + marker('T2', 548, 153, 521, 138, p) + marker('T3', 944, 47, 970, 47, p) + marker('T4', 1090, 204, 1050, 204, p)
      body += text(30, 720, 'DSH 会话页签 · 与全局面板共享节点样式；下拉层位于画布上方，保留画布位置。', 12, p.muted)
      body += legend('T1', 30, 756, '对话／智能体并列页签', '13px 文字、2px 蓝色指示线；切换时平移。', '只展示当前会话发起的运行。', p)
      body += legend('T2', 574, 756, '会话内运行选择器', '与全局面板共用 36px 触发器和选项样式。', '分别保存节点选择、折叠状态与视点。', p)
      body += legend('T3', 30, 842, '顶部团队下拉', '32px 灰色触发器；图标、团队数量与箭头。', '展开后按运行分组，成员行显示身份与状态。', p)
      body += legend('T4', 574, 842, '成员定位与独立观察', '行主体定位并选中节点；32px 箭头打开观察。', '两种操作独立命中，收起后焦点回到触发器。', p)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-label="${global ? 'DSH 全局智能体面板' : 'DSH 会话内智能体页签'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"><defs>${logo}<filter id="${esc(logoId)}-shadow" x="-15%" y="-15%" width="130%" height="145%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#182e55" flood-opacity=".1"/></filter></defs>${body}</svg>`
}
