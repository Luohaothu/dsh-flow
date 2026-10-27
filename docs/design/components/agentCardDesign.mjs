export const CARD = Object.freeze({
  width: 216, radius: 8, left: 10, right: 10, top: 10, bottom: 8, gap: 6,
  nameX: 40, nameTop: 10, nameHeight: 16, modelTop: 32, modelHeight: 14,
  statusHeight: 18, metricHeight: 14, footerHeight: 20,
})

export const ICONS = {
  running: '<circle cx="12" cy="12" r="8" opacity=".2"/><path d="M12 4a8 8 0 0 1 8 8"/>',
  waiting: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  idle: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  completed: '<path d="m5 12 4.5 4.5L19 7"/>',
  failed: '<path d="m12 3 10 17H2Z"/><path d="M12 9v4m0 3v.5"/>',
  stopped: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  history: '<path d="M4 9a8 8 0 1 1 1 9M3 3v6h6"/><path d="M12 7v5l3 2"/>',
  assignment: '<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="2" width="6" height="5" rx="1"/><path d="M9 11h6m-6 4h6"/>',
  branch: '<circle cx="12" cy="4" r="2.5"/><circle cx="5" cy="20" r="2.5"/><circle cx="19" cy="20" r="2.5"/><path d="M12 7v5M5 17v-5h14v5"/>',
  permission: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m9 12 2 2 4-4"/>',
  cleanup: '<path d="m18 3-9 10M7 11l6 6-5 5-6-6Z"/><path d="m5 15 5 5m-2-8 5 5"/>',
}

export const STATE_LABELS = { running: '运行中', waiting: '等待中', idle: '空闲', completed: '完成', failed: '失败', stopped: '已停止' }
export const PALETTES = {
  light: { surface: '#fff', text: '#253247', body: 'rgba(0,0,0,.61)', muted: 'rgba(0,0,0,.45)', border: 'rgba(0,0,0,.06)', identity: '#eaf3ff', accent: '#367bc9',
    running: ['#eaf3ff','#367bc9'], waiting: ['#fff5df','#aa7417'], idle: ['#f0f1f3','#737b89'], completed: ['#e8f6ed','#28724a'], failed: ['#fff0ee','#bd6254'], stopped: ['#edf0f3','#5e6877'] },
  dark: { surface: '#1c1c1f', text: '#f1f3f6', body: 'rgba(255,255,255,.62)', muted: 'rgba(255,255,255,.45)', border: 'rgba(255,255,255,.08)', identity: '#233954', accent: '#8bbaff',
    running: ['#233954','#a1c9ff'], waiting: ['#3b321f','#dcc477'], idle: ['#343842','#c1c7d1'], completed: ['#243c30','#8ed7aa'], failed: ['#402a2b','#e8a19a'], stopped: ['#343842','#c1c7d1'] },
}

export function statusWidth(card) {
  return 22 + (card.cleanup ? 22 : 0) + (card.marker ? 22 + String(card.marker).length * 7 : 0)
}

export function cardLayout(card = {}) {
  const modelTop = CARD.modelTop
  const taskTop = modelTop + (card.folded ? CARD.statusHeight : CARD.modelHeight) + CARD.gap
  const taskLines = card.taskLines ?? [card.task ?? '']
  let cursor = taskTop + taskLines.length * 16
  const extras = (card.extras ?? []).map(extra => {
    const top = cursor + CARD.gap
    const height = extra.background ? 20 : 14
    cursor = top + height
    return { ...extra, top, height }
  })
  const dividerY = cursor + CARD.gap
  const metricsTop = dividerY + 1 + CARD.gap
  const footerTop = metricsTop + CARD.metricHeight + CARD.gap
  const footerProgress = card.timestamp ? 1 : (card.foldProgress ?? (card.count ? 1 : 0))
  const height = metricsTop + CARD.metricHeight + (CARD.gap + CARD.footerHeight) * footerProgress + CARD.bottom
  return { modelTop, taskTop, extras, dividerY, metricsTop, footerTop, height, footerProgress }
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]))
const text = (x,y,value,size=11,color='currentColor',weight=400,extra='') => `<text x="${x}" y="${y}" style="font-size:${size}px;font-weight:${weight};fill:${color};stroke:none;font-variant-numeric:tabular-nums" ${extra}>${esc(value)}</text>`

export function icon(name,x,y,size=12,color='currentColor') {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" color="${color}" stroke-width="${36/size}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.idle}</svg>`
}

export function statusBadge(card = {}, x, y, theme = 'light') {
  const p=PALETTES[theme], state=card.state ?? 'running', w=statusWidth(card)
  const [bg,color]=p[state]
  x ??= CARD.width-CARD.right-w
  y ??= card.folded ? CARD.modelTop : CARD.top
  let body=`<g transform="rotate(${state==='running' ? card.rotation ?? 0 : 0} 11 9)">${icon(state,3,1,16,color)}</g>`
  let offset=22
  if(card.cleanup) {
    body+=`<path d="M${offset} 4v10" stroke="${p.border}"/>`+icon('cleanup',offset+3,1,16,p.muted)
    const marks = {
      清理完成: `<path d="m${offset+12} 6 2 2 4-4" fill="none" stroke="${p.completed[1]}" stroke-width="1.5"/>`,
      强制清理: `<path d="m${offset+16} 1-5 6h4l-2 5 6-7h-4Z" fill="${p.waiting[1]}"/>`,
      清理失败: `<path d="m${offset+12} 2 6 6m0-6-6 6" stroke="${p.failed[1]}" stroke-width="1.5"/>`,
      已放弃: `<path d="m${offset+12} 8 6-6" stroke="${p.muted}" stroke-width="1.5"/>`,
    }
    body+=marks[card.cleanup] ?? `<g transform="rotate(${card.rotation ?? 0} ${offset+15} 5)"><path d="M${offset+15} 2a3 3 0 1 1-3 3" fill="none" stroke="${p.accent}" stroke-width="1.5"/></g>`
    offset+=22
  }
  if(card.marker) body+=`<path d="M${offset} 4v10" stroke="${p.border}"/>`+icon('failed',offset+3,3,12,p.waiting[1])+text(offset+18,13,card.marker,11,p.waiting[1])
  return `<g data-design-status="${state}" transform="translate(${x} ${y})"><title>${esc([STATE_LABELS[state],card.cleanup,card.marker ? `${card.marker} 项告警` : ''].filter(Boolean).join(' · '))}</title><rect width="${w}" height="18" rx="4" fill="${bg}"/>${body}</g>`
}

export function renderCard(card = {}) {
  const { x=0,y=0,scale=1,theme='light',name='研究者',model='deepseek-chat',input='3.8k',output='1.34k',duration='2m06s',timestamp,count,folded=false }=card
  const p=PALETTES[theme], l=cardLayout(card), tasks=card.taskLines ?? [card.task ?? '整理任务资料与分析结果']
  const modelWidth=folded ? 216-10-statusWidth(card)-6-56 : 150
  const border=card.selected ? p.accent : p.border
  const svgText=(...args)=>text(...args)
  let content=`<rect y="2" width="216" height="${l.height}" rx="8" fill="#182e5510"/><rect data-card-surface="" width="216" height="${l.height}" rx="8" fill="${p.surface}" stroke="${border}" stroke-width="${card.selected?1.5:1}"/>`
  if(card.focused) content+=`<rect x="-4" y="-4" width="224" height="${l.height+8}" rx="12" fill="none" stroke="${p.accent}" stroke-width="2"/>`
  const logo=esc(card.logoId ?? 'deepseek-logo')
  content+=`<rect x="10" y="10" width="22" height="22" rx="6" fill="${p.identity}"/><use href="#${logo}" x="12" y="12" width="18" height="18"/>`
  content+=svgText(40,22,name,13,p.text,500)+`<use href="#${logo}" x="40" y="33" width="12" height="12"/>`
  content+=`<foreignObject x="56" y="32" width="${modelWidth}" height="14"><div xmlns="http://www.w3.org/1999/xhtml" title="${esc(model)}" style="font-family:inherit;font-size:11px;line-height:14px;color:${p.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(model)}</div></foreignObject>`
  content+=statusBadge(card,undefined,undefined,theme)
  tasks.forEach((line,i)=>content+=svgText(10,l.taskTop+12+i*16,line,12,p.body))
  l.extras.forEach(extra=>{
    if(extra.kind==='branchCounts') {
      content+=icon('running',10,extra.top+1,12,p.running[1])+svgText(26,extra.top+11,extra.running,11,p.muted)
        +icon('waiting',62,extra.top+1,12,p.waiting[1])+svgText(78,extra.top+11,extra.waiting,11,p.muted)
      return
    }
    if(extra.kind==='branchUsage') {
      const top=extra.top
      content+=icon('branch',10,top+1,12,p.muted)+`<path d="M32 ${top+10}l4-6 4 6Z M104 ${top+4}h8l-4 6Z" fill="${p.muted}"/>`+svgText(44,top+11,extra.input,11,p.muted)+svgText(116,top+11,extra.output,11,p.muted)
      return
    }
    if(extra.background) content+=`<rect x="10" y="${extra.top}" width="196" height="${extra.height}" rx="4" fill="${extra.background}"/>`
    const left=extra.background?16:10, center=extra.top+extra.height/2
    content+=icon(extra.icon ?? 'idle',left,center-6,12,p.muted)+svgText(left+16,center+4,extra.text,11,p.muted)
    if(extra.detail)content+=svgText(200,center+4,extra.detail,11,p.muted,400,'text-anchor="end"')
  })
  content+=`<path d="M10 ${l.dividerY}h196" stroke="${p.border}"/>`
  const mt=l.metricsTop
  content+=`<g data-card-metrics="" aria-label="输入 ${esc(input)} Token，输出 ${esc(output)} Token，运行 ${esc(duration)}"><path d="M10 ${mt+10}l4-6 4 6Z M82 ${mt+4}h8l-4 6Z" fill="${p.muted}"/>${svgText(22,mt+11,input,11,p.muted)}${svgText(94,mt+11,output,11,p.muted)}${svgText(206,mt+11,duration,11,p.muted,400,'text-anchor="end"')}</g>`
  if(timestamp)content+=icon('history',10,l.footerTop+4,12,p.muted)+svgText(26,l.footerTop+14,timestamp,11,p.muted)
  if(count)content+=`<g data-card-fold=""><rect x="172" y="${l.footerTop}" width="34" height="20" rx="4" fill="${p.identity}"/>${svgText(188,l.footerTop+14,folded?`+${count}`:count,11,p.accent,400,'text-anchor="end"')}<path d="M196 ${l.footerTop+8}l3 3 3-3" transform="rotate(${card.angle ?? (folded ? -90 : 0)} 199 ${l.footerTop+10})" fill="none" stroke="${p.accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g>`
  return `<g data-design-card="${esc(card.id ?? name)}" role="img" aria-label="${esc(name)}" transform="translate(${x} ${y}) scale(${scale})" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;stroke:none"${card.hovered?' filter="url(#hover)"':''}><title>${esc(name)}</title>${content}</g>`
}
