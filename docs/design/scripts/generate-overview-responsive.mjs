import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderCard, cardLayout, statusBadge } from '../components/agentCardDesign.mjs'

const imageDirectory = fileURLToPath(new URL('../public/images/agent-tree-design/', import.meta.url))
const common = { timestamp: '10:25:14' }
const root = { ...common, name: '协调者', taskLines: ['统筹研究与方案交付，', '汇总各分支的结论。'], input: '6.2k', output: '2.2k', duration: '1m23s', count: 3 }
const research = { ...common, name: '研究者', taskLines: ['检索相关资料，核对', '关键结论与证据。'], input: '3.8k', output: '1.3k', duration: '1m12s', count: 1 }
const writer = { ...common, name: '写作者', taskLines: ['整理方案正文，等待', '研究分支返回结论。'], state: 'waiting', input: '2.4k', output: '860', duration: '1m03s' }
const developer = { ...common, name: '开发者', taskLines: ['完成方案原型，准备', '接收下一步任务。'], state: 'idle', input: '7.1k', output: '2.6k', duration: '1m18s' }
const search = { ...common, name: '检索者', taskLines: ['收集公开资料，标注', '可追溯的来源位置。'], input: '3.4k', output: '1.3k', duration: '48s' }
const folded = { ...writer, name: '写作者 · +3 子代理', folded: true, count: 3, extras: [{ kind: 'branchCounts', running: 2, waiting: 1 }, { kind: 'branchUsage', input: '7.2k', output: '2.6k' }] }

const height = cardLayout(root).height
const foldedHeight = cardLayout(folded).height
const overviewFirstRow = 250 + height + 40
const overviewGroupBottom = overviewFirstRow + Math.max(height, foldedHeight) + 24
const overviewLeafTop = overviewGroupBottom + 8
const wideFirstRow = 184 + height + 40
const wideLeafTop = wideFirstRow + height + 32
const narrowFirstRow = 882 + height + 32
const narrowLeafTop = narrowFirstRow + height + 12

const diagrams = {
  'overview.svg': [
    ['overview-root', 328, 250, root],
    ['overview-research', 72, overviewFirstRow, { ...research, selected: true }],
    ['overview-writer', 328, overviewFirstRow, folded],
    ['overview-developer', 584, overviewFirstRow, developer],
    ['overview-search', 104, overviewLeafTop, search],
    ['overview-folded-example', 390, overviewLeafTop, folded],
  ],
  'responsive.svg': [
    ['responsive-wide-root', 472, 184, root],
    ['responsive-wide-research', 160, wideFirstRow, research],
    ['responsive-wide-writer', 448, wideFirstRow, writer],
    ['responsive-wide-developer', 736, wideFirstRow, { ...developer, input: '2.5k', output: '800' }],
    ['responsive-wide-search', 192, wideLeafTop, search],
    ['responsive-narrow-root', 74, 882, root],
    ['responsive-narrow-research', 106, narrowFirstRow, research],
    ['responsive-narrow-search', 138, narrowLeafTop, search],
    ['responsive-overlay-root', 636, 882, root],
    ['responsive-overlay-research', 668, 882 + height + 12, research],
    ['responsive-overlay-search', 700, 882 + (height + 12) * 2, search],
  ],
}

function replaceCard(svg, id, rendered) {
  const lines = svg.split('\n')
  const index = lines.findIndex(line => line.trimStart().startsWith(`<g data-design-card="${id}"`))
  if (index < 0) throw new Error(`Missing card: ${id}`)
  lines[index] = '  ' + rendered
  return lines.join('\n')
}

function updateLayout(svg, id, attributes) {
  const tag = new RegExp(`<[^>]+ data-layout="${id}"[^>]*>`)
  if (!tag.test(svg)) throw new Error(`Missing layout anchor: ${id}`)
  return svg.replace(tag, original => Object.entries(attributes).reduce((updated, [name, value]) => {
    const attribute = new RegExp(` ${name}="[^"]*"`)
    if (!attribute.test(updated)) throw new Error(`Missing attribute "${name}" on layout anchor: ${id}`)
    return updated.replace(attribute, ` ${name}="${value}"`)
  }, original))
}

const overviewGeometry = {
  'overview-group': { y: overviewFirstRow - 24, height: Math.max(height, foldedHeight) + 48 },
  'overview-group-label-bg': { y: overviewFirstRow - 35 },
  'overview-group-label': { y: overviewFirstRow - 19 },
  'overview-root-edge': { d: `M436 ${250 + height}v20M180 ${overviewFirstRow}v-20h512v20M436 ${overviewFirstRow - 20}v20` },
  'overview-root-out': { cy: 250 + height },
  'overview-research-in': { cy: overviewFirstRow },
  'overview-writer-in': { cy: overviewFirstRow },
  'overview-developer-in': { cy: overviewFirstRow },
  'overview-child-edge': { d: `M84 ${overviewFirstRow + height}v${overviewLeafTop + 24 - overviewFirstRow - height}q0 8 8 8h12` },
  'overview-search-in': { cy: overviewLeafTop + 32 },
  'overview-temporary-edge': { d: `M290 ${overviewFirstRow + Math.ceil(height / 2)}h36` },
  'overview-message-dot': { cy: overviewFirstRow + Math.ceil(height / 2) },
  'overview-root-message-dot': { cy: overviewFirstRow - 20 },
  'overview-blackboard-bubble': { cy: overviewFirstRow - 8 },
  'overview-blackboard-icon': { y: overviewFirstRow - 18 },
  'overview-folded-label': { cy: overviewLeafTop + 19 },
  'overview-folded-label-text': { y: overviewLeafTop + 25 },
  'overview-folded-label-line': { d: `M370 ${overviewLeafTop + 19}h14` },
  'overview-indent-dimension': { d: `M72 ${overviewLeafTop + height + 21}v10h32v-10` },
  'overview-indent-label': { y: overviewLeafTop + height + 37 },
}
const responsiveGeometry = {
  'wide-group': { y: wideFirstRow - 24, height: height + 48 },
  'wide-group-label-bg': { y: wideFirstRow - 35 },
  'wide-group-label': { y: wideFirstRow - 19 },
  'wide-root-edge': { d: `M580 ${184 + height}v14a6 6 0 0 1-6 6H274a6 6 0 0 0-6 6v14M556 ${wideFirstRow - 20}v20M580 ${wideFirstRow - 20}h258a6 6 0 0 1 6 6v14` },
  'wide-child-edge': { d: `M176 ${wideFirstRow + height}v${wideLeafTop + 26 - wideFirstRow - height}a6 6 0 0 0 6 6h10` },
  'wide-root-out': { cy: 184 + height },
  'wide-research-in': { cy: wideFirstRow },
  'wide-writer-in': { cy: wideFirstRow },
  'wide-developer-in': { cy: wideFirstRow },
  'wide-search-in': { cy: wideLeafTop + 32 },
  'wide-temporary-edge': { d: `M378 ${wideFirstRow + Math.ceil(height / 2)}h68` },
  'wide-message-dot': { cy: wideFirstRow + Math.ceil(height / 2) },
  'wide-message-label': { y: wideFirstRow + Math.ceil(height / 2) - 12 },
  'wide-blackboard-bubble': { cy: wideFirstRow - 8 },
  'wide-blackboard-icon': { y: wideFirstRow - 18 },
  'wide-child-gap': { d: `M424 ${wideFirstRow + height}h16m-16 32h16m-8-32v32` },
  'wide-child-gap-label': { y: wideFirstRow + height + 25 },
  'wide-root-gap': { d: `M704 ${184 + height}h16m-16 40h16m-8-40v40` },
  'wide-root-gap-label': { y: 184 + height + 25 },
  'narrow-group': { y: narrowFirstRow - 24, height: narrowLeafTop + height - narrowFirstRow + 48 },
  'narrow-group-label-bg': { y: narrowFirstRow - 35 },
  'narrow-group-label': { y: narrowFirstRow - 19 },
  'narrow-tree-edge': { d: `M90 ${882 + height}v58a6 6 0 0 0 6 6h10M122 ${narrowFirstRow + height}v38a6 6 0 0 0 6 6h10` },
  'narrow-research-in': { cy: narrowFirstRow + 32 },
  'narrow-search-in': { cy: narrowLeafTop + 32 },
  'narrow-message-dot': { cy: narrowLeafTop + 14 },
  'narrow-child-gap': { d: `M362 ${narrowFirstRow + height}h18m-18 12h18m-9-12v12` },
  'narrow-child-gap-label': { y: narrowLeafTop },
}

function detailIdentity(id, x, y, statusX) {
  return `<g data-design-detail-identity="${id}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;stroke:none"><use href="#deepseek-logo" x="${x}" y="${y}" width="33" height="33"/><text x="${x + 45}" y="${y + 18}" style="font-size:19.5px;font-weight:500">研究者</text><g transform="translate(${statusX} ${y}) scale(1.5)">${statusBadge({ state: 'running' }, 0, 0)}</g><use href="#deepseek-logo" x="${x}" y="${y + 42}" width="18" height="18"/><text x="${x + 24}" y="${y + 57}" style="font-size:16.5px;fill:rgba(0,0,0,.45)">deepseek-chat</text></g>`
}

function replaceDetailIdentity(svg, id, rendered) {
  const start = svg.indexOf(`<g data-design-detail-identity="${id}"`)
  if (start < 0) throw new Error(`Missing detail identity: ${id}`)
  let depth = 0
  const tags = /<\/?g\b[^>]*>/g
  tags.lastIndex = start
  for (let match; (match = tags.exec(svg));) {
    depth += match[0].startsWith('</') ? -1 : match[0].endsWith('/>') ? 0 : 1
    if (depth === 0) return svg.slice(0, start) + rendered + svg.slice(tags.lastIndex)
  }
  throw new Error(`Unclosed detail identity: ${id}`)
}

for (const [file, cards] of Object.entries(diagrams)) {
  const path = imageDirectory + file
  let svg = fs.readFileSync(path, 'utf8')
  for (const [id, x, y, card] of cards) svg = replaceCard(svg, id, renderCard({ ...card, id, x, y }))
  const geometry = file === 'overview.svg' ? overviewGeometry : responsiveGeometry
  for (const [id, attributes] of Object.entries(geometry)) svg = updateLayout(svg, id, attributes)
  const identity = file === 'overview.svg'
    ? ['overview', 898, 252, 1111]
    : ['responsive', 648, 891, 987]
  svg = replaceDetailIdentity(svg, identity[0], detailIdentity(...identity))
  fs.writeFileSync(path, svg)
}
console.log(`Rendered ${Object.values(diagrams).flat().length} cards; base height ${height}px, folded height ${foldedHeight}px.`)
