<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { useData } from 'vitepress'
import { CARD, cardLayout as sharedCardLayout, renderCard } from './agentCardDesign.mjs'

const { isDark } = useData()

type SceneKey = 'enter' | 'collapse' | 'transfer' | 'stop' | 'communication'
type CommunicationMode = 'direct' | 'temporary' | 'blackboard'
type NodeState = 'running' | 'completed' | 'stopped'
type Card = {
  id: string
  name: string
  task: string
  timestamp: string
  input: number
  output: number
  seconds: number
  state: NodeState
  x: number
  y: number
  opacity: number
  count?: number
  angle?: number
  cleanup?: string
  marker?: number
  selected?: boolean
  branchInput?: number
  branchOutput?: number
  folded?: boolean
}
type Link = { id: string; fromX: number; fromY: number; toX: number; toY: number; draw: number; opacity: number }

const communicationModes = {
  direct: {
    label: '实线投递', duration: 1000,
    stages: [
      { at: 0, label: '圆点沿线移动', detail: '圆点从发送者沿已有父子实线移动到接收者，反向发送时沿同一条线返回。' },
      { at: 800, label: '投递到达', detail: '圆点到达接收者，收件箱新增消息卡片；到达圆点开始淡出。' },
      { at: 1000, label: '投递完成', detail: '已有父子实线保持，消息留在接收者自己的收件箱。' },
    ],
  },
  temporary: {
    label: '临时通信', duration: 1800,
    stages: [
      { at: 0, label: '绘制虚线箭头', detail: '从发送者向接收者绘制临时虚线箭头，持续 240ms。' },
      { at: 240, label: '圆点沿线移动', detail: '虚线箭头绘制完成，圆点从研究 Agent 移动到写作 Agent。' },
      { at: 1400, label: '到达并收线', detail: '圆点到达时收件箱新增消息卡片，临时虚线箭头在 400ms 内收回并淡出。' },
      { at: 1800, label: '投递完成', detail: '临时通信线消失，群成员范围与接收者的消息卡片持续保留。' },
    ],
  },
  blackboard: {
    label: '黑板写入', duration: 2000,
    stages: [
      { at: 0, label: '写入开始', detail: '研究 Agent 写入群 G-01 的黑板，右上角圆形气泡在 200ms 内缩放淡入。' },
      { at: 200, label: '写入期间', detail: '气泡中的绿板图形保持可见，气泡以轻微呼吸提示写入正在进行。' },
      { at: 1820, label: '写入完成', detail: '黑板写入完成，气泡在 180ms 内缩小并淡出。' },
      { at: 2000, label: '气泡消失', detail: '写入提示气泡消失，群成员卡片与浅黄色群框保持。' },
    ],
  },
} as const

const scenes = {
  enter: {
    label: '节点新增', duration: 580,
    stages: [
      { at: 0, label: '连线开始', detail: '从父卡片向新节点绘制连线，持续 420ms。' },
      { at: 140, label: '卡片进入', detail: '首张卡片从下方 8px 上移并淡入，持续 360ms。' },
      { at: 220, label: '同批错峰', detail: '第二张卡片错峰 80ms 进入，连线与卡片各自连续推进。' },
      { at: 500, label: '首张到位', detail: '首张卡片到位，第二张卡片继续完成淡入。' },
      { at: 580, label: '进入完成', detail: '两张卡片完整显示，输入、输出累计值随调用更新。' },
    ],
  },
  collapse: {
    label: '分支折叠', duration: 280,
    stages: [
      { at: 0, label: '点击折叠', detail: '折叠研究与验证分支，保留协调 Agent 卡片。' },
      { at: 140, label: '淡出与回撤', detail: '后代卡片逐渐淡出，连线同步向父级回撤。' },
      { at: 280, label: '折叠完成', detail: '标题显示协调 Agent · +2 子代理，分支输入 7.2k、输出 2.6k。' },
    ],
  },
  transfer: {
    label: '父级转移', duration: 400,
    stages: [
      { at: 0, label: '关系更新', detail: '将 agent-07 从研究 Agent 转入写作 Agent。' },
      { at: 200, label: '平移与连线', detail: '卡片平移到新分支；连线端点持续跟随卡片位置。' },
      { at: 400, label: '转移完成', detail: 'agent-07 的身份与运行中状态保持，父级更新为写作 Agent。' },
    ],
  },
  stop: {
    label: '停止与收尾', duration: 1800,
    stages: [
      { at: 0, label: '点击停止', detail: '提交停止 agent-07 的请求，按钮进入提交状态。' },
      { at: 200, label: '请求已提交', detail: '请求接收后显示已提交，卡片继续显示当前运行状态。' },
      { at: 500, label: '逻辑已停止', detail: '主徽标更新为已停止，同时显示清理收尾中。' },
      { at: 1800, label: '清理与操作完成', detail: '清理完成、操作完成；主徽标持续显示已停止。' },
    ],
  },
  communication: {
    ...communicationModes.direct, label: '通信与群聊',
  },
} as const

const scene = ref<SceneKey>('enter')
const communicationMode = ref<CommunicationMode>('direct')
const direction = ref<'down' | 'up'>('down')
const messagePriority = ref<'high' | 'normal' | 'low'>('normal')
const messageRead = ref(false)
const elapsed = ref(0)
const playing = ref(false)
const speed = ref(0.25)
const reducedMotion = ref(false)
const instanceId = useId()
const titleId = `${instanceId}-title`
const descriptionId = `${instanceId}-description`
const logoId = `${instanceId}-deepseek`
const arrowId = `${instanceId}-message-arrow`
const messageClipId = `${instanceId}-message-clip`
const blackboardId = `${instanceId}-blackboard`
const current = computed(() => scene.value === 'communication' ? communicationModes[communicationMode.value] : scenes[scene.value])
const activeStage = computed(() => {
  const stages = current.value.stages
  return [...stages].reverse().find(stage => elapsed.value >= stage.at) ?? stages[0]
})
const clamp = (value: number) => Math.min(1, Math.max(0, value))
function ease(value: number) {
  const progress = clamp(value)
  if (progress === 0 || progress === 1) return progress
  const coordinate = (t: number, first: number, second: number) =>
    3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const midpoint = (low + high) / 2
    if (coordinate(midpoint, 0.32, 0.24) < progress) low = midpoint
    else high = midpoint
  }
  return coordinate((low + high) / 2, 0.72, 1)
}
const phase = (start: number, duration: number) => clamp((elapsed.value - start) / duration)
const cardWidth = CARD.width
const levelGap = 40
function cardExtras(card: Card) {
  if (card.branchInput === undefined || card.branchOutput === undefined) return []
  return [
    { kind: 'branchCounts', running: 1, waiting: 0 },
    { kind: 'branchUsage', input: formatTokens(card.branchInput), output: formatTokens(card.branchOutput) },
  ]
}
function cardLayout(card: Card) {
  return sharedCardLayout({ ...card, extras: cardExtras(card) })
}
function renderMotionCard(card: Card) {
  return renderCard({ ...card, x: 0, y: 0, logoId, extras: cardExtras(card),
    input: formatTokens(card.input), output: formatTokens(card.output), duration: formatDuration(card.seconds),
    rotation: reducedMotion.value ? 0 : elapsed.value / 1000 * 360, theme: isDark.value ? 'dark' : 'light' })
}
const cardBottom = (card: Card) => card.y + cardLayout(card).height
function connectCards(id: string, parent: Card, child: Card, draw = 1, opacity = 1): Link {
  return { id, fromX: parent.x + cardWidth / 2, fromY: cardBottom(parent),
    toX: child.x + cardWidth / 2, toY: child.y, draw, opacity }
}
const formatTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
function formatDuration(seconds: number) {
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const remainder = total % 60
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m${String(remainder).padStart(2, '0')}s`
  return minutes ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${remainder}s`
}
const message = computed(() => {
  const direct = communicationMode.value === 'direct'
  const reverse = direct && direction.value === 'up'
  const arrival = direct ? 800 : 1400
  return {
    arrowOpacity: 1 - ease(phase(1400, 400)),
    draw: ease(phase(0, 240)) * (1 - ease(phase(1400, 400))),
    travel: phase(240, 1160),
    directY: reverse
      ? messageRoute.value.toY + (messageRoute.value.fromY - messageRoute.value.toY) * phase(0, 800)
      : messageRoute.value.fromY + (messageRoute.value.toY - messageRoute.value.fromY) * phase(0, 800),
    dotOpacity: (direct || elapsed.value >= 240 ? 1 : 0) * (1 - ease(phase(arrival, direct ? 200 : 180))),
    arrived: elapsed.value >= arrival,
    sender: reverse ? '写作 Agent' : '研究 Agent',
    recipient: reverse ? '研究 Agent' : '写作 Agent',
    summary: reverse ? '初稿已完成，请检查。' : '资料已整理，可开始撰写。',
  }
})
const blackboard = computed(() => {
  const fade = 1 - ease(phase(1820, 180))
  const entrance = ease(phase(0, 200))
  const breath = elapsed.value >= 200 ? 1 + 0.035 * Math.sin((elapsed.value - 200) / 620 * Math.PI * 2) : 1
  return {
    opacity: entrance * fade,
    scale: (0.78 + 0.22 * entrance) * breath * (0.84 + 0.16 * fade),
  }
})

const rootCard = (): Card => ({
  id: 'agent-01', name: '协调 Agent', task: '汇总研究与验证结果', timestamp: '10:25:14',
  input: 1800, output: 600, seconds: 3723 + elapsed.value / 1000,
  state: 'running', x: 236, y: 28, opacity: 1, count: 2, angle: 0,
})
const childCard = (second = false): Card => ({
  id: second ? 'agent-08' : 'agent-07', name: second ? '验证 Agent' : '研究 Agent',
  task: second ? '核验结果与设计约束' : '整理任务资料与结论',
  timestamp: second ? '10:25:12' : '10:25:14', input: second ? 1600 : 3800, output: second ? 800 : 1200,
  seconds: second ? 45 : 83 + elapsed.value / 1000,
  state: second ? 'completed' : 'running', x: second ? 392 : 80, y: 0, opacity: 1,
})

const drawing = computed((): { cards: Card[]; links: Link[] } => {
  const root = rootCard()
  const children = [childCard(), childCard(true)].map(card => ({ ...card, y: cardBottom(root) + levelGap }))
  if (scene.value === 'enter') {
    const cards = children.map((card, index) => ({
      ...card, state: 'running' as const,
      input: elapsed.value >= 500 + index * 80 ? 128 : 0,
      output: elapsed.value >= 580 ? 24 : 0,
      seconds: Math.max(0, elapsed.value - index * 80) / 1000,
      y: card.y + 8 * (1 - ease(phase(140 + index * 80, 360))),
      opacity: ease(phase(140 + index * 80, 360)),
    }))
    return {
      cards: [root, ...cards],
      links: cards.map((card, index) => connectCards(card.id, root, card, ease(phase(index * 80, 420)))),
    }
  }
  if (scene.value === 'collapse') {
    const progress = ease(phase(0, 280))
    root.branchInput = 7200
    root.branchOutput = 2600
    root.name = elapsed.value >= 280 ? '协调 Agent · +2 子代理' : '协调 Agent'
    root.folded = elapsed.value >= 280
    root.count = 2
    root.angle = -90 * progress
    return {
      cards: [root, ...children.map(card => ({ ...card, y: cardBottom(root) + levelGap, opacity: 1 - progress }))],
      links: children.map(card => connectCards(card.id, root, { ...card, y: cardBottom(root) + levelGap }, 1 - progress, 1 - progress)),
    }
  }
  if (scene.value === 'transfer') {
    const progress = ease(phase(0, 400))
    const moving: Card = {
      ...children[0], name: '分析 Agent', task: '归纳研究结论', x: 80 + 312 * progress,
    }
    const parents: Card[] = [
      { ...root, id: 'agent-02', name: '研究 Agent', task: '收集资料并分析', x: 80, count: elapsed.value === 0 ? 1 : 0 },
      { ...root, id: 'agent-03', name: '写作 Agent', task: '编写结构化文档', x: 392, count: elapsed.value === 0 ? 0 : 1 },
    ]
    return {
      cards: [...parents, moving],
      links: [
        connectCards('old-parent', parents[0], moving, 1, 1 - progress),
        connectCards('new-parent', parents[1], moving, 1, progress),
      ],
    }
  }
  if (scene.value === 'communication') {
    if (communicationMode.value === 'direct') {
      const sender: Card = { ...root, id: 'agent-07', name: '研究 Agent', task: '整理任务资料与结论', x: 80, count: 1, selected: direction.value === 'up' }
      const recipient: Card = { ...children[1], name: '写作 Agent', task: '整合研究消息与结论', state: 'running', x: 80,
        y: cardBottom(sender) + levelGap, seconds: 45 + elapsed.value / 1000, selected: direction.value === 'down' }
      return {
        cards: [sender, recipient],
        links: [connectCards('direct-parent', sender, recipient)],
      }
    }
    return {
      cards: [
        { ...childCard(), y: 110 },
        { ...childCard(true), name: '写作 Agent', task: '整合研究消息与结论', state: 'running', y: 110,
          seconds: 45 + elapsed.value / 1000, selected: communicationMode.value === 'temporary' },
      ],
      links: [],
    }
  }
  return {
    cards: [{
      ...childCard(), x: 52, y: 102,
      state: elapsed.value >= 500 ? 'stopped' : 'running',
      seconds: 83 + Math.min(elapsed.value, 500) / 1000,
      cleanup: elapsed.value >= 1800 ? '清理完成' : elapsed.value >= 500 ? '收尾中' : undefined,
    }],
    links: [],
  }
})

const groupFrame = computed(() => {
  const cards = drawing.value.cards
  const left = Math.min(...cards.map(card => card.x))
  const top = Math.min(...cards.map(card => card.y))
  const right = Math.max(...cards.map(card => card.x + cardWidth))
  const bottom = Math.max(...cards.map(cardBottom))
  return { x: left - 24, y: top - 24, width: right - left + 48, height: bottom - top + 48 }
})
const messageRoute = computed(() => {
  if (scene.value === 'communication' && communicationMode.value === 'direct') return drawing.value.links[0]
  const [sender, recipient] = drawing.value.cards
  return { fromX: sender.x + cardWidth, fromY: sender.y + cardLayout(sender).height / 2,
    toX: recipient?.x ?? sender.x + cardWidth, toY: recipient ? recipient.y + cardLayout(recipient).height / 2 : sender.y }
})
const stopButtonY = computed(() => cardBottom(drawing.value.cards[0]) + 18)
const inboxY = computed(() => communicationMode.value === 'direct'
  ? drawing.value.cards[1]?.y ?? 0 : groupFrame.value.y + groupFrame.value.height + 16)
const inboxHeight = 114
const canvasHeight = computed(() => {
  const cardsBottom = Math.max(...drawing.value.cards.map(cardBottom)) + 28
  if (scene.value === 'enter') return cardBottom(rootCard()) + levelGap + cardLayout(childCard()).height + 8 + 28
  if (scene.value === 'stop') return Math.max(cardsBottom, stopButtonY.value + 34 + 28, 345)
  if (scene.value === 'communication') {
    if (communicationMode.value === 'blackboard') return groupFrame.value.y + groupFrame.value.height + 28
    return Math.max(cardsBottom, inboxY.value + inboxHeight + 18)
  }
  return cardsBottom
})

function linkPath(link: Link) {
  const { fromX: x1, fromY: y1, toX: x2, toY: y2 } = link
  const mid = (y1 + y2) / 2
  const direction = Math.sign(x2 - x1)
  const radius = Math.min(8, Math.abs(x2 - x1) / 2)
  if (radius < 0.1) return `M ${x1} ${y1} V ${y2}`
  return `M ${x1} ${y1} V ${mid - radius} Q ${x1} ${mid} ${x1 + direction * radius} ${mid} H ${x2 - direction * radius} Q ${x2} ${mid} ${x2} ${mid + radius} V ${y2}`
}

let frame: number | undefined
let previousTimestamp: number | undefined
let motionQuery: MediaQueryList | undefined

function pause() {
  playing.value = false
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  previousTimestamp = undefined
}

function tick(timestamp: number) {
  if (!playing.value) return
  if (previousTimestamp !== undefined) {
    elapsed.value = Math.min(current.value.duration, elapsed.value + (timestamp - previousTimestamp) * speed.value)
  }
  previousTimestamp = timestamp
  if (elapsed.value >= current.value.duration) pause()
  else frame = requestAnimationFrame(tick)
}

function play() {
  if (reducedMotion.value) return
  if (playing.value) return pause()
  if (elapsed.value >= current.value.duration) elapsed.value = 0
  playing.value = true
  previousTimestamp = undefined
  frame = requestAnimationFrame(tick)
}

function replay() {
  pause()
  elapsed.value = 0
  play()
}

function selectScene(key: SceneKey) {
  pause()
  scene.value = key
  elapsed.value = 0
}

function selectCommunication(mode: CommunicationMode) {
  pause()
  communicationMode.value = mode
  elapsed.value = 0
}

function selectDirection(value: 'down' | 'up') {
  pause()
  direction.value = value
  elapsed.value = 0
}

function seek(value: number) {
  pause()
  elapsed.value = value
}

function scrub(event: Event) {
  seek(Number((event.target as HTMLInputElement).value))
}

function syncMotionPreference() {
  reducedMotion.value = motionQuery?.matches ?? false
  if (reducedMotion.value) pause()
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotionPreference()
  motionQuery.addEventListener('change', syncMotionPreference)
})

onUnmounted(() => {
  pause()
  motionQuery?.removeEventListener('change', syncMotionPreference)
})
</script>

<template>
  <section class="at-motion" aria-label="Agent Tree 动效示意">
    <div class="at-motion-scenes" aria-label="选择动效场景">
      <button v-for="(item, key) in scenes" :key="key" type="button"
        :aria-pressed="scene === key" @click="selectScene(key)">{{ item.label }}</button>
    </div>
    <div v-if="scene === 'communication'" class="at-motion-submodes">
      <div class="at-motion-mode-buttons" aria-label="通信演示模式">
        <button v-for="(item, key) in communicationModes" :key="key" type="button"
          :aria-pressed="communicationMode === key" @click="selectCommunication(key)">{{ item.label }}</button>
      </div>
      <div v-if="communicationMode === 'direct'" class="at-motion-direction" aria-label="投递方向">
        <button type="button" :aria-pressed="direction === 'down'" @click="selectDirection('down')">父 → 子</button>
        <button type="button" :aria-pressed="direction === 'up'" @click="selectDirection('up')">子 → 父</button>
      </div>
    </div>

    <div class="at-motion-canvas" tabindex="0" aria-label="动效画布，可横向滚动">
      <svg class="at-motion-svg" :viewBox="`0 0 688 ${canvasHeight}`" width="688" :height="canvasHeight"
        role="img" :aria-labelledby="`${titleId} ${descriptionId}`">
        <title :id="titleId">{{ current.label }}：{{ activeStage.label }}</title>
        <desc :id="descriptionId">{{ activeStage.detail }}</desc>
        <defs>
          <symbol :id="blackboardId" viewBox="0 0 24 24"><path d="M5 18 3.5 23M19 18l1.5 5" fill="none" stroke="#9b653c" stroke-width="2.2" stroke-linecap="round"/><rect x="1" y="2" width="22" height="17" rx="2" fill="#bc8551"/><rect x="3" y="4" width="18" height="13" rx=".8" fill="#286b55"/><path d="M5.5 7h7M5.5 10h11M5.5 13h5" fill="none" stroke="#f4f6da" stroke-width="1.3" stroke-linecap="round"/><rect x="14" y="16.2" width="5" height="1.8" rx=".6" fill="#f1cf87"/><rect x="6" y="17" width="4" height="1" rx=".5" fill="#fff8e6"/></symbol>
          <symbol :id="logoId" viewBox="0 0 24 24"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"/></symbol>
          <marker :id="arrowId" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path class="at-motion-message-arrow" d="M 1 1 L 7 4 L 1 7 Z" />
          </marker>
          <clipPath v-if="scene === 'communication' && communicationMode === 'temporary'" :id="messageClipId">
            <rect :x="messageRoute.fromX - 6" :y="messageRoute.fromY - 11"
              :width="(messageRoute.toX - messageRoute.fromX + 14) * message.draw" height="22" />
          </clipPath>
        </defs>
        <text x="24" y="28" class="at-motion-canvas-label">{{ current.label }}</text>
        <g v-if="scene === 'communication' && communicationMode !== 'direct'" class="at-motion-group" role="img" aria-label="通信群 G-01，2 位成员">
          <rect class="at-motion-group-frame" :x="groupFrame.x" :y="groupFrame.y" :width="groupFrame.width" :height="groupFrame.height" rx="12" />
          <rect class="at-motion-group-label-bg" :x="groupFrame.x + 12" :y="groupFrame.y - 9" width="76" height="18" rx="4" />
          <text class="at-motion-group-label" :x="groupFrame.x + 24" :y="groupFrame.y + 4">G-01</text>
          <rect class="at-motion-group-label-bg" :x="groupFrame.x + groupFrame.width - 84" :y="groupFrame.y - 9" width="72" height="18" rx="4" />
          <g class="at-motion-members-icon" :transform="`translate(${groupFrame.x + groupFrame.width - 65} ${groupFrame.y - 6})`">
            <circle cx="4" cy="3" r="2.5" /><circle cx="11" cy="4" r="2" />
            <path d="M 0 13 V 10 A 4 4 0 0 1 8 10 V 13 M 10 8 A 3 3 0 0 1 14 11 V 13" />
          </g>
          <text class="at-motion-group-label" :x="groupFrame.x + groupFrame.width - 33" :y="groupFrame.y + 4" text-anchor="middle">2</text>
        </g>
        <g v-for="link in drawing.links" :key="link.id" :opacity="link.opacity" class="at-motion-link">
          <path :d="linkPath(link)" pathLength="100" stroke-dasharray="100"
            :stroke-dashoffset="100 * (1 - link.draw)" />
          <circle :cx="link.fromX" :cy="link.fromY" r="3" :opacity="link.draw > 0 ? 1 : 0" />
          <circle :cx="link.toX" :cy="link.toY" r="3" :opacity="link.draw >= 0.99 ? 1 : 0" />
        </g>

        <g v-for="card in drawing.cards" :key="card.id" :opacity="card.opacity"
          :transform="`translate(${card.x} ${card.y})`" class="at-motion-card" v-html="renderMotionCard(card)" />

        <g v-if="scene === 'stop'" class="at-motion-stop-sequence">
          <line class="at-motion-stop-track" x1="326" y1="85" x2="326" y2="304" />
          <line class="at-motion-stop-progress" x1="326" y1="85" x2="326"
            :y2="elapsed >= 1800 ? 304 : elapsed >= 500 ? 231 : elapsed >= 200 ? 158 : 85" />
          <g v-for="(step, index) in scenes.stop.stages" :key="step.at"
            :transform="`translate(326 ${85 + index * 73})`" :class="{ 'is-reached': elapsed >= step.at }">
            <circle class="at-motion-step-dot" r="6" />
            <text class="at-motion-step-time" x="20" y="-7">{{ step.at }}ms</text>
            <text class="at-motion-step-label" x="20" y="13">{{ step.label }}</text>
            <text v-if="step.at === 500" class="at-motion-step-note" x="20" y="31">主徽标：已停止 · 清理：收尾中</text>
          </g>
          <rect class="at-motion-operation-bg" x="52" :y="stopButtonY" width="216" height="34" rx="6" />
          <text class="at-motion-operation" x="160" :y="stopButtonY + 22" text-anchor="middle">{{ elapsed >= 1800 ? '操作完成' : elapsed >= 200 ? '停止请求已提交' : '正在提交停止请求…' }}</text>
        </g>
        <g v-if="scene === 'communication'">
          <circle v-if="communicationMode === 'direct'" class="at-motion-message-pulse" :cx="messageRoute.fromX"
            :cy="message.directY" r="3" :opacity="message.dotOpacity" />
          <g v-if="communicationMode === 'temporary'" :opacity="message.arrowOpacity" :clip-path="`url(#${messageClipId})`">
            <path class="at-motion-message-line" :d="`M ${messageRoute.fromX} ${messageRoute.fromY} L ${messageRoute.toX} ${messageRoute.toY}`" stroke-dasharray="4 4"
              :marker-end="`url(#${arrowId})`" />
          </g>
          <circle v-if="communicationMode === 'temporary'" class="at-motion-message-pulse"
            :cx="messageRoute.fromX + (messageRoute.toX - messageRoute.fromX) * message.travel"
            :cy="messageRoute.fromY + (messageRoute.toY - messageRoute.fromY) * message.travel" r="3" :opacity="message.dotOpacity" />
          <g v-if="communicationMode === 'blackboard'" :opacity="blackboard.opacity"
            :transform="`translate(${drawing.cards[0].x + cardWidth + 8} ${drawing.cards[0].y - 8})`">
            <g :transform="`scale(${blackboard.scale})`">
              <circle class="at-motion-blackboard-bubble" r="14" />
              <use :href="`#${blackboardId}`" x="-10" y="-10" width="20" height="20" />
            </g>
          </g>
          <g v-if="communicationMode !== 'blackboard'" class="at-motion-inbox" :transform="`translate(0 ${inboxY - 324})`">
            <rect class="at-motion-inbox-surface" x="344" y="324" width="288" :height="inboxHeight" rx="10" />
            <text class="at-motion-inbox-heading" x="360" y="347">{{ message.recipient }} 的收件箱</text>
            <text class="at-motion-inbox-count" x="616" y="347" text-anchor="end"><title>{{ message.arrived ? '1 条消息' : '0 条消息' }}</title>{{ message.arrived ? 1 : 0 }}</text>
            <g v-if="message.arrived" :class="['at-motion-message', `at-motion-priority-${messagePriority}`, { 'is-read': messageRead }]"
              role="img" :aria-label="`${messagePriority} 优先级，${messageRead ? '已读' : '未读'}，${message.sender}：${message.summary}`">
              <title>{{ messagePriority }} 优先级 · {{ messageRead ? '已读' : '未读' }}</title>
              <rect class="at-motion-message-card" x="356" y="360" width="264" height="66" rx="8" />
              <text class="at-motion-message-sender" x="368" y="384">{{ message.sender }}</text>
              <text class="at-motion-message-meta" x="594" y="384" text-anchor="end">12:04:23</text>
              <g role="img" :aria-label="messageRead ? '已读' : '未读'">
                <title>{{ messageRead ? '已读' : '未读' }}</title>
                <path v-if="messageRead" class="at-motion-read-check" d="M 605 380 L 607 382 L 611 378" />
                <circle v-else class="at-motion-unread-dot" cx="608" cy="380" r="3" />
              </g>
              <foreignObject x="368" y="396" width="240" height="18">
                <div xmlns="http://www.w3.org/1999/xhtml" class="at-motion-message-summary">{{ message.summary }}</div>
              </foreignObject>
            </g>
            <text v-else class="at-motion-inbox-empty" x="488" y="394" text-anchor="middle">暂无收到的消息</text>
          </g>
        </g>
      </svg>
    </div>

    <div class="at-motion-stage" aria-live="polite" aria-atomic="true">
      <span class="at-motion-stage-name">{{ activeStage.label }}</span>
      <span>{{ activeStage.detail }}</span>
    </div>

    <div class="at-motion-controls">
      <fieldset v-if="scene === 'communication' && communicationMode !== 'blackboard'" class="at-motion-message-controls">
        <legend>消息样式示意</legend>
        <label>优先级
          <select v-model="messagePriority" aria-label="演示消息优先级颜色">
            <option value="high">high · 红</option>
            <option value="normal">normal · 绿</option>
            <option value="low">low · 蓝</option>
          </select>
        </label>
        <label>阅读状态
          <select v-model="messageRead" aria-label="演示消息阅读状态">
            <option :value="false">未读</option><option :value="true">已读</option>
          </select>
        </label>
      </fieldset>
      <div class="at-motion-actions">
        <button class="at-motion-play" type="button" :disabled="reducedMotion" @click="play">
          <span aria-hidden="true">{{ playing ? 'Ⅱ' : '▶' }}</span>{{ playing ? '暂停' : '播放' }}
        </button>
        <button type="button" @click="replay">重播</button>
        <label class="at-motion-speed">速度
          <select v-model.number="speed" aria-label="演示播放速度">
            <option :value="0.25">0.25×</option><option :value="1">1×</option>
          </select>
        </label>
        <output class="at-motion-clock" aria-label="当前设计时间">{{ Math.round(elapsed) }} / {{ current.duration }} ms</output>
      </div>
      <input class="at-motion-scrubber" type="range" min="0" :max="current.duration" step="1"
        :value="elapsed" aria-label="动效进度，单位毫秒" :aria-valuetext="`${Math.round(elapsed)} 毫秒，${activeStage.label}`" @input="scrub" />
      <div class="at-motion-milestones" aria-label="跳转到动效阶段">
        <button v-for="step in current.stages" :key="step.at" type="button"
          :class="{ 'is-current': activeStage.at === step.at }" @click="seek(step.at)">
          <span>{{ step.at }}ms</span>{{ step.label }}
        </button>
      </div>
      <p v-if="reducedMotion" class="at-motion-preference">减少动态效果已启用。拖动进度条或选择阶段查看静态画面。</p>
    </div>
  </section>
</template>

<style scoped>
.at-motion {
  --at-surface: #fff;
  --at-canvas: #fafbfc;
  --at-text: #20242d;
  --at-body: #566071;
  --at-muted: #70798a;
  --at-metric: rgb(0 0 0 / 45%);
  --at-border: #e4e8ee;
  --at-line: #82bcff;
  --at-accent: #286cbd;
  --at-accent-bg: #edf5ff;
  margin: 24px 0;
  overflow: hidden;
  border: 1px solid var(--at-border);
  border-radius: 14px;
  background: var(--at-surface);
  color: var(--at-text);
  font-family: var(--vp-font-family-base, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  font-size: 13px;
  line-height: 1.5;
}
.at-motion button, .at-motion select { font: inherit; }
.at-motion button { cursor: pointer; }
.at-motion button:focus-visible, .at-motion select:focus-visible, .at-motion input:focus-visible, .at-motion-canvas:focus-visible { outline: 2px solid var(--at-accent); outline-offset: 3px; }
.at-motion-scenes { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; border-bottom: 1px solid var(--at-border); }
.at-motion-scenes button { padding: 7px 12px; border: 1px solid transparent; border-radius: 7px; color: var(--at-body); font-weight: 500; }
.at-motion-scenes button[aria-pressed='true'] { border-color: #bdd9fa; background: var(--at-accent-bg); color: var(--at-accent); }
.at-motion-submodes { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--at-border); }
.at-motion-mode-buttons, .at-motion-direction { display: flex; flex-wrap: wrap; gap: 4px; }
.at-motion-submodes button { min-height: 32px; padding: 5px 9px; border-radius: 5px; color: var(--at-muted); font-size: 12px; }
.at-motion-submodes button[aria-pressed='true'] { background: var(--at-accent-bg); color: var(--at-accent); }
.at-motion-canvas { overflow-x: auto; background: var(--at-canvas); }
.at-motion-svg { display: block; width: 100%; min-width: 560px; height: auto; margin: 0 auto; font-family: inherit; stroke: none; }
.at-motion-svg text { font-size: 12px; stroke: none; }
.at-motion-canvas-label { fill: var(--at-muted); font-weight: 500; }
.at-motion-link path { fill: none; stroke: var(--at-line); stroke-width: 1.5; stroke-linecap: round; }
.at-motion-link circle { fill: var(--at-surface); stroke: var(--at-line); stroke-width: 1.5; }
.at-motion-stop-track { stroke: var(--at-border); stroke-width: 2; }
.at-motion-stop-progress { stroke: var(--at-line); stroke-width: 2; }
.at-motion-step-dot { fill: var(--at-canvas); stroke: var(--at-border); stroke-width: 2; }
.at-motion-step-time, .at-motion-step-label, .at-motion-step-note { fill: var(--at-muted); }
.at-motion-step-label { font-weight: 500; }
.is-reached .at-motion-step-dot { fill: var(--at-accent-bg); stroke: var(--at-accent); }
.is-reached .at-motion-step-label { fill: var(--at-text); }
.is-reached .at-motion-step-time { fill: var(--at-accent); }
.at-motion-operation-bg { fill: var(--at-accent-bg); stroke: var(--at-border); }
.at-motion-operation { fill: var(--at-accent); font-weight: 500; }
.at-motion-group-frame { fill: #fff8d8; stroke: #e6cc67; stroke-width: 1.5; }
.at-motion-group-label-bg { fill: var(--at-canvas); stroke: none; }
.at-motion-group-label { fill: #8b6d21; font-weight: 500; stroke: none; }
.at-motion-members-icon { fill: none; stroke: #8b6d21; stroke-width: 1.2; stroke-linecap: round; }
.at-motion-message-line { fill: none; stroke: var(--at-accent); stroke-width: 1.5; stroke-linecap: round; }
.at-motion-message-arrow, .at-motion-message-pulse { fill: var(--at-accent); }
.at-motion-blackboard-bubble { fill: #fff8d8; stroke: #e6cc67; stroke-width: 1; filter: drop-shadow(0 1px 2px #182e5518); }
.at-motion-inbox-surface { fill: var(--at-surface); stroke: var(--at-border); }
.at-motion-svg .at-motion-inbox-heading, .at-motion-svg .at-motion-message-sender { fill: var(--at-text); font-size: 13px; font-weight: 500; }
.at-motion-svg .at-motion-message-meta { font-size: 11px; }
.at-motion-inbox-count, .at-motion-message-meta { fill: var(--at-muted); font-variant-numeric: tabular-nums; }
.at-motion-priority-high { --at-message-unread: #fff0f0; --at-message-read: #f3eeee; --at-message-accent: #b85a64; }
.at-motion-priority-normal { --at-message-unread: #eef9f0; --at-message-read: #eef2ef; --at-message-accent: #4c8b60; }
.at-motion-priority-low { --at-message-unread: #eef5ff; --at-message-read: #eef0f3; --at-message-accent: #497eb4; }
.at-motion-message-card { fill: var(--at-message-unread); stroke: var(--at-border); transition: fill 180ms linear; }
.at-motion-message.is-read .at-motion-message-card { fill: var(--at-message-read); }
.at-motion-message-summary { width: 100%; min-width: 0; margin: 0; color: var(--at-body); font-family: inherit; font-size: 12px; line-height: 18px; text-align: justify; text-align-last: left; overflow-wrap: anywhere; word-break: normal; }
.at-motion-unread-dot { fill: var(--at-message-accent); stroke: none; }
.at-motion-read-check { fill: none; stroke: var(--at-muted); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.at-motion-inbox-empty { fill: var(--at-muted); }
.at-motion-stage { display: grid; grid-template-columns: 92px 1fr; gap: 12px; min-height: 66px; padding: 12px 16px; border-top: 1px solid var(--at-border); background: var(--at-surface); color: var(--at-body); }
.at-motion-stage-name { color: var(--at-accent); font-weight: 600; }
.at-motion-controls { padding: 0 16px 16px; }
.at-motion-message-controls { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 0 0 12px; padding: 8px 10px 10px; border: 1px solid var(--at-border); border-radius: 7px; }
.at-motion-message-controls legend { padding: 0 5px; color: var(--at-muted); font-size: 12px; }
.at-motion-message-controls label { display: flex; align-items: center; gap: 6px; color: var(--at-muted); font-size: 12px; }
.at-motion-message-controls select { min-height: 30px; padding: 3px 6px; border: 1px solid var(--at-border); border-radius: 5px; background: var(--at-surface); color: var(--at-text); }
.at-motion-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.at-motion-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 5px 12px; border: 1px solid var(--at-border); border-radius: 6px; color: var(--at-body); }
.at-motion-actions .at-motion-play { background: var(--at-accent); border-color: var(--at-accent); color: #fff; }
.at-motion-actions button:disabled { cursor: default; opacity: 0.45; }
.at-motion-speed { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; color: var(--at-muted); }
.at-motion-speed select { min-height: 34px; padding: 4px 6px; border: 1px solid var(--at-border); border-radius: 6px; background: var(--at-surface); color: var(--at-text); }
.at-motion-clock { margin-left: auto; color: var(--at-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.at-motion-scrubber { display: block; width: 100%; height: 24px; margin: 14px 0 7px; padding: 0; accent-color: var(--at-accent); cursor: ew-resize; }
.at-motion-milestones { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.at-motion-milestones button { display: flex; align-items: center; gap: 5px; min-height: 32px; padding: 3px 6px; border-radius: 4px; color: var(--at-muted); font-size: 12px; }
.at-motion-milestones button span { font-variant-numeric: tabular-nums; }
.at-motion-milestones button.is-current { color: var(--at-accent); background: var(--at-accent-bg); }
.at-motion .at-motion-preference { margin: 10px 0 0; color: var(--at-muted); font-size: 12px; }
:global(.dark .at-motion) { --at-surface: #1c1c1f; --at-canvas: #202023; --at-text: #f1f3f6; --at-body: #bdc3ce; --at-muted: #929cac; --at-border: #383c45; --at-line: #4f8fdb; --at-accent: #8bbaff; --at-accent-bg: #25354c; }
:global(.dark .at-motion) { --at-metric: rgb(255 255 255 / 45%); }
:global(.dark .at-motion-scenes button[aria-pressed='true']) { border-color: #436b9c; }
:global(.dark .at-motion-actions .at-motion-play) { color: #172335; }
:global(.dark .at-motion-group-frame) { fill: #312d20; stroke: #82703c; }
:global(.dark .at-motion-group-label) { fill: #dcc477; }
:global(.dark .at-motion-members-icon) { stroke: #dcc477; }
:global(.dark .at-motion-priority-high) { --at-message-unread: #3a2528; --at-message-read: #2d292b; --at-message-accent: #d88b93; }
:global(.dark .at-motion-priority-normal) { --at-message-unread: #22372a; --at-message-read: #282e2a; --at-message-accent: #82b791; }
:global(.dark .at-motion-priority-low) { --at-message-unread: #233248; --at-message-read: #292d33; --at-message-accent: #87acdb; }
@media (prefers-reduced-motion: reduce) {
  .at-motion-message-card { transition: none; }
}
@media (max-width: 480px) {
  .at-motion-scenes { gap: 4px; padding: 8px; }
  .at-motion-scenes button { padding: 6px 8px; font-size: 12px; }
  .at-motion-stage { grid-template-columns: 1fr; gap: 3px; padding: 12px; }
  .at-motion-controls { padding: 0 12px 12px; }
  .at-motion-clock { width: 100%; margin-left: 0; }
}
</style>
