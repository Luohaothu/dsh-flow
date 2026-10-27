import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderCard, cardLayout, statusBadge, icon, PALETTES } from '../components/agentCardDesign.mjs'

const imageDirectory = fileURLToPath(new URL('../public/images/agent-tree-design/', import.meta.url))
const source = readFileSync(`${imageDirectory}appearance.svg`, 'utf8')
const symbols = [...source.matchAll(/<symbol\b[\s\S]*?<\/symbol>/g)].map(match => match[0]).join('\n')
const style = `text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;fill:#253247;font-size:17px;stroke:none}.title{font-size:26px;font-weight:600}.heading{font-size:21px;font-weight:600}.label{font-size:18px;font-weight:500}.muted{fill:#718095}.small{font-size:16px}.blue{fill:#2468bf}.num{fill:#fff;font-size:17px;font-weight:600;text-anchor:middle}.guide{fill:none;stroke:#9cafc7;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}.rule{fill:none;stroke:#e7ecf3;stroke-width:1}`
const filters = `<filter id="soft" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#192f49" flood-opacity=".06"/></filter><filter id="hover" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#192f49" flood-opacity=".12"/></filter>`
const text = (x,y,value,cls='',attrs='') => `<text x="${x}" y="${y}" class="${cls}" ${attrs}>${value}</text>`
const frame = (width,height,title,desc,body,background='#f7f9fb') => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${title}</title><desc id="desc">${desc}</desc><defs><style>${style}</style>${filters}${symbols}</defs><rect width="${width}" height="${height}" rx="20" fill="${background}"/>${body}</svg>\n`
const number = (n,x,y) => `<circle cx="${x}" cy="${y}" r="15" fill="#2468bf"/>${text(x,y+6,n,'num')}`
const leader = path => `<path d="${path}" class="guide"/>`
const section = (letter,y,title) => `<rect x="32" y="${y}" width="28" height="28" rx="8" fill="#357abd"/>${text(46,y+20,letter,'num')}${text(72,y+21,title,'heading')}`
const bubble = (x,y,scale=1,theme='light') => `<g transform="translate(${x} ${y}) scale(${scale})"><title>正在写入群 G-01 的黑板</title><circle r="14" fill="${theme==='dark'?'#453e23':'#fff8d8'}" stroke="${theme==='dark'?'#927c3b':'#e6cc67'}"/><use href="#blackboard-emoji" x="-10" y="-10" width="20" height="20"/></g>`

const anatomy = { id:'anatomy',x:94,y:170,scale:2,name:'研究者',state:'running',marker:1,
  taskLines:['检索公开资料，核对关键结论','与证据，形成可追溯来源。'],input:'3.8k',output:'1.34k',duration:'2m06s',timestamp:'10:25:14',count:3,
  extras:[{icon:'waiting',text:'验证者',detail:'42s',background:'#fff8ed'},{icon:'assignment',text:'资料核查',detail:'↻1',background:'#f4f7fb'},{icon:'permission',text:'只读'}] }
const geometry=cardLayout(anatomy)
const callout=(n,x,y,path)=>number(n,x,y)+leader(path)
const note=(n,x,y,width,title,lines,height=118)=>`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="11" fill="#fff" stroke="#e1e7ef"/>${number(n,x+30,y+29)}${text(x+58,y+36,title,'heading')}${lines.map((line,i)=>text(x+26,y+67+i*26,line,i?'muted':'')).join('')}`
let cardBody=text(36,48,'Agent 卡片：信息层级与尺寸','title')+text(36,79,'卡片按 2 倍比例展示，尺寸标注均为 CSS 像素。','muted')
cardBody+=leader('M94 136v-12h432v12M94 124l8-4m-8 4 8 4M526 124l-8-4m8 4-8 4')+`<rect x="242" y="110" width="136" height="28" rx="6" fill="#f7f9fb"/>`+text(256,130,'宽度 216px','blue')
cardBody+=renderCard(anatomy)+bubble(542,154,2)
cardBody+=callout(1,73,202,'M88 202h26')+callout(2,552,208,'M506 208h31')
cardBody+=callout(3,73,170+geometry.taskTop*2+24,`M88 ${170+geometry.taskTop*2+24}h26`)
cardBody+=callout(4,73,170+geometry.metricsTop*2+22,`M88 ${170+geometry.metricsTop*2+22}h26`)
cardBody+=callout(5,552,170+geometry.footerTop*2+20,`M506 ${170+geometry.footerTop*2+20}h31`)
const extrasTop=170+geometry.extras[0].top*2, extrasBottom=170+(geometry.extras.at(-1).top+geometry.extras.at(-1).height)*2
cardBody+=callout(6,73,(extrasTop+extrasBottom)/2,`M88 ${(extrasTop+extrasBottom)/2}h12V${extrasTop}h8M100 ${(extrasTop+extrasBottom)/2}V${extrasBottom}h8`)
cardBody+=callout(7,552,254,'M537 254h-53v-28')+callout(8,580,120,'M565 120h-12l-6 9')
cardBody+=note(1,609,170,555,'模型标识与身份',['模型 Logo 22 × 22px；与名称间隔 8px。','名称 13px / 16px；模型 11px / 14px。'],110)
cardBody+=note(2,609,292,555,'右对齐的组合状态徽标',['距上、右各 10px；高 18px、圆角 4px。','状态图标 16px；增加清理或告警时向左扩展。'],110)
cardBody+=note(3,609,414,555,'两行任务摘要',['字号 12px、行高 16px；区域间隔 6px。','名称与模型单行省略；完整任务在详情展开。'],110)
cardBody+=note(4,609,536,555,'Token、运行时长与事件时间',['数字 11px；三角 8 × 6px、与数字间距 4px。','三角、数值、时长与次行时间采用同级灰度。'],110)
cardBody+=note(5,94,684,520,'展开状态的折叠入口',['3 表示直接子节点数量，向下箭头表示已展开。','视觉高度 20px；触控点击区域至少 32px。'])
cardBody+=note(6,638,684,526,'附加行随内容排列',['等待、作业与初始权限使用图标和值。','常规行高 14px，带底色行高 20px；行距 6px。'])
cardBody+=note(7,94,826,520,'持续标记并入状态徽标',['警示图标搭配数量，与主状态共用一个徽标。','在详情中展开对应事件、原因与发生时间。'])
cardBody+=note(8,638,826,526,'黑板写入气泡',['直径 28px，中心位于卡片右上角外侧。','绿板 Emoji 随写入开始出现，完成后消失。'])
cardBody+=`<rect x="94" y="968" width="1070" height="80" rx="11" fill="#eef4fc" stroke="#dbe7f6"/>`+text(118,1001,'圆角 8px','heading')+text(310,1001,'内边距 10 / 10 / 8 / 10px','heading')+text(736,1001,'内容行距 6px · 高度随内容累加','heading')+text(118,1030,'上 / 右 / 下 / 左；指标前留 6px、细分隔线和 6px，底部事件与折叠入口共用一行。','muted')
writeFileSync(`${imageDirectory}card.svg`,frame(1200,1080,'Agent 卡片解剖与尺寸规范','按二倍等比展示统一节点卡片，编号 1 至 8 对应身份、状态、任务、指标、折叠、附加行、告警和黑板气泡。所有间距和底部信息随实际内容累加。',cardBody))

let appearance=text(32,46,'状态、图标与选择','title')+text(1168,44,'尺寸标注均为 CSS 像素','muted','text-anchor="end"')
appearance+=section('K',78,'主状态：统一 18px 徽标的图标与底色 · 2×')
const states=[['running','运行中','蓝色 · 旋转指示'],['waiting','等待中','琥珀色 · 时钟'],['idle','空闲','中性灰 · 圆点'],['completed','完成','绿色 · 对勾'],['failed','失败','红色 · 警示'],['stopped','已停止','中性灰 · 方块']]
states.forEach(([state,label,detail],i)=>{const x=32+i*188;appearance+=`<g transform="translate(${x+70} 128) scale(2)">${statusBadge({state},0,0)}</g>`+text(x+92,196,label,'label','text-anchor="middle"')+text(x+92,223,detail,'muted','text-anchor="middle"')})
appearance+=`<path d="M32 246h1136" class="rule"/>`+section('L',270,'组合状态、清理阶段与图标语法')
appearance+=`<g transform="translate(32 318) scale(2)">${statusBadge({state:'stopped',cleanup:'清理失败',marker:2},0,0)}</g>`+text(222,335,'主状态图标 + 清理阶段图标 + 告警数量 · 2×')+text(222,362,'悬停或聚焦显示完整说明，详情展开原因与时间；下方清理图例按 1.5× 展示。','muted')
const cleanups=[['收尾中','扫帚 + 进度环'],['强制清理','扫帚 + 闪电'],['清理完成','扫帚 + 对勾'],['清理失败','扫帚 + 叉号'],['已放弃','扫帚 + 斜线']]
cleanups.forEach(([cleanup,detail],i)=>{const x=32+i*228;appearance+=`<g transform="translate(${x} 392)"><rect width="212" height="100" rx="8" fill="#f7f9fb"/><g transform="translate(14 17) scale(1.5)">${statusBadge({state:'stopped',cleanup},0,0)}</g>${text(96,37,cleanup)}${text(14,79,detail,'muted')}</g>`})
appearance+=text(32,528,'附加行：图标与值','label')
const extras=[['waiting','验证者 · 42s','等待目标与剩余时间'],['assignment','资料核查 · ↻1','作业名称与提交次数'],['permission','只读','初始权限'],['history','10:25:14','最近事件时间']]
extras.forEach(([glyph,value,label],i)=>{const x=32+i*228;appearance+=`<g transform="translate(${x} 552)">${icon(glyph,0,0,18,'#718095')}${text(26,15,value)}${text(0,46,label,'muted')}</g>`})
appearance+=`<rect x="32" y="624" width="1136" height="102" rx="10" fill="#f7f9fb"/>`+text(52,654,'运行统计','muted')
const statIcons=[['ui-agents',8,'#718095'],['ui-run',5,'#357cc7'],['ui-wait',1,'#aa7417'],['ui-tokens','38,420','#718095']]
statIcons.forEach(([glyph,value,color],i)=>{const x=154+i*80;appearance+=`<use href="#${glyph}" x="${x}" y="636" width="24" height="24" color="${color}"/>`+text(x+32,655,value)})
appearance+=`<rect x="574" y="636" width="34" height="30" rx="6" fill="#fff" stroke="#dce4ee"/><use href="#ui-fit" x="581" y="641" width="20" height="20" color="#718095"/>`+text(620,657,'适应视口')+`<rect x="744" y="636" width="34" height="30" rx="6" fill="#fff" stroke="#dce4ee"/><use href="#ui-expand" x="751" y="641" width="20" height="20" color="#718095"/>`+text(790,657,'展开全部')+text(52,703,'Token 三角 8 × 6px，数值间距 4px；三角、用量数字和时长使用黑 / 白 45% 的同级灰度。','muted')
appearance+=section('M',754,'主题与交互：使用同一节点卡片布局')
const specimen={name:'研究者',state:'running',marker:1,taskLines:['整理任务资料与分析结果','核对结论与相关证据。'],input:'3.8k',output:'1.34k',duration:'2m06s',timestamp:'10:25:14',count:2}
for(const [i,theme] of ['light','dark'].entries()) {
  const x=32+i*580, cardX=x+89, cardY=858, scale=1.75, p=PALETTES[theme]
  const h=cardLayout(specimen).height*scale
  appearance+=`<rect x="${x}" y="800" width="556" height="366" rx="12" fill="${theme==='dark'?'#202023':'#fafafa'}" stroke="${theme==='dark'?'#303036':'#e8eaee'}"/>`+text(x+20,831,theme==='dark'?'深色主题 · 1.75×':'浅色主题 · 1.75×','label',`style="fill:${p.text}"`)
  appearance+=`<path d="M${cardX+108*scale} ${cardY-16}v16m0 ${h}v16" fill="none" stroke="${theme==='dark'?'#4f8fdb':'#82bcff'}" stroke-width="${1.5*scale}"/>`
  appearance+=renderCard({...specimen,id:`theme-${theme}`,x:cardX,y:cardY,scale,theme})+bubble(cardX+224*scale,cardY-8*scale,scale,theme)
  appearance+=text(x+20,1142,theme==='dark'?'卡片 #1c1c1f · 画布 #202023 · 连线 #4f8fdb':'卡片 #ffffff · 画布 #fafafa · 连线 #82bcff','small',`style="fill:${p.muted}"`)
}
const interactions=[['hover','悬停',{hovered:true},'轻微增强阴影，维持卡片位置。'],['selected','选中',{selected:true},'蓝色边框，与详情中的身份对应。'],['focus','键盘聚焦',{selected:true,focused:true},'2px 外轮廓，与选中边框叠加。']]
interactions.forEach(([id,label,options,detail],i)=>{const x=32+i*388;appearance+=`<rect x="${x}" y="1190" width="360" height="330" rx="10" fill="#fafafa" stroke="#e8eaee"/>`+text(x+20,1222,`${label} · 1.3×`,'label')+renderCard({...specimen,...options,id:`interaction-${id}`,x:x+40,y:1250,scale:1.3})+text(x+20,1478,detail,'small muted')+text(x+20,1503,'字体、内边距、状态与底部信息保持一致。','small muted')
  if(id==='hover')appearance+=`<path d="m${x+310} 1290 1 22 5-7 8 2Z" fill="#fff" stroke="#6e7785" stroke-width="1.5"/>`
})
writeFileSync(`${imageDirectory}appearance.svg`,frame(1200,1552,'Agent Tree 状态图标、组合徽标与主题样式','K 展示统一主状态徽标；L 展示清理与持续标记、附加行和运行图标；M 的浅深色、悬停、选中与键盘聚焦卡片共用节点卡片的字体、间距、状态及底部布局。',appearance,'#fff'))
console.log(JSON.stringify({cardHeight:geometry.height,cardWidth:216,appearanceCards:5}))
