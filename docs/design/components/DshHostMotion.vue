<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { useData } from 'vitepress'
import { renderNavigationScene } from './dshNavigationDesign.mjs'
import { renderPanelScene } from './dshPanelsDesign.mjs'

type Scene = 'global' | 'session' | 'observer' | 'settings'
const props = defineProps<{ scene: Scene }>()
const { isDark } = useData()
const id = useId()
const duration = 4000
const scenes = {
  global: {
    label: '全局面板', initial: 3400,
    stages: [
      { at: 0, name: '侧栏入口', detail: '从侧栏选择智能体，中央区域打开全局面板。' },
      { at: 600, name: '面板展开', detail: '运行栏与画布同时出现，当前运行及所属会话保持清晰。' },
      { at: 1400, name: '选择运行', detail: '展开运行选择器，按运行列出任务和状态。' },
      { at: 2400, name: '切换运行', detail: '选择另一运行，画布、统计与详情一起更新。' },
      { at: 3400, name: '定位节点', detail: '选中成员后，蓝色描边与右侧详情对应同一实例。' },
    ],
  },
  session: {
    label: '会话内页签', initial: 3000,
    stages: [
      { at: 0, name: '会话对话', detail: '对话与智能体页签共用当前主会话身份。' },
      { at: 1200, name: '切换页签', detail: '激活智能体页签，显示本会话发起的团队运行。' },
      { at: 2000, name: '展开团队', detail: '顶部团队下拉按运行组织成员，行末箭头用于观察成员。' },
      { at: 3000, name: '定位成员', detail: '选择成员行后收起下拉，并在树中选中该成员；页签下划线与选择状态保持。' },
    ],
  },
  observer: {
    label: '成员观察侧栏', initial: 2100,
    stages: [
      { at: 0, name: '观察入口', detail: '从成员独立箭头打开右侧观察窗，树中保留当前成员的选择。' },
      { at: 1000, name: '侧栏滑入', detail: '观察窗从右侧进入，头部保持成员身份，内容区呈现加载占位。' },
      { at: 2100, name: '读取会话', detail: '显示用户、助手、思考与工具记录；位于末尾时跟随新记录。' },
      { at: 3100, name: '切换成员', detail: '在同一侧栏切换成员，头部与会话内容同步更新。' },
      { at: 4000, name: '关闭返回', detail: '关闭观察窗，焦点回到打开它的成员卡片，画布视点保持。' },
    ],
  },
  settings: {
    label: '插件设置', initial: 3200,
    stages: [
      { at: 0, name: '继承配置', detail: '字段展示继承值，未修改时保存按钮处于禁用状态。' },
      { at: 1400, name: '修改覆盖', detail: '编辑字段后显示覆盖标记，恢复继承箭头与保存按钮可用。' },
      { at: 2300, name: '保存中', detail: '保留字段与滚动位置，保存按钮内显示旋转进度。' },
      { at: 3200, name: '保存结果', detail: '成功显示对勾；失败保留草稿，冲突展示本地值与最新值供比较。' },
    ],
  },
} as const
const current = computed(() => scenes[props.scene])
const elapsed = ref<number>(scenes[props.scene].initial)
const playing = ref(false)
const speed = ref(1)
const reducedMotion = ref(false)
const outcome = ref<'success' | 'error' | 'conflict'>('success')
const expanded = ref(false)
const dialog = ref<HTMLDialogElement>()
const expandButton = ref<HTMLButtonElement>()
let frame = 0
let previousTime = 0
let started = false
let media: MediaQueryList | undefined
const activeStage = computed(() => [...current.value.stages].reverse().find(stage => elapsed.value >= stage.at) ?? current.value.stages[0])
function markup(suffix: string) {
  const options = { scene: props.scene, progress: elapsed.value / duration, theme: isDark.value ? 'dark' : 'light', logoId: `${id}-${suffix}-logo`, outcome: outcome.value }
  return props.scene === 'global' || props.scene === 'session' ? renderNavigationScene(options) : renderPanelScene(options)
}
const inlineMarkup = computed(() => markup('inline'))
const enlargedMarkup = computed(() => markup('enlarged'))
function pause() { playing.value = false; cancelAnimationFrame(frame); previousTime = 0 }
function tick(time: number) {
  if (!playing.value) return
  if (previousTime) elapsed.value = Math.min(duration, elapsed.value + (time - previousTime) * speed.value)
  previousTime = time
  if (elapsed.value >= duration) pause()
  else frame = requestAnimationFrame(tick)
}
function play() {
  if (playing.value) { pause(); return }
  if (!started || elapsed.value >= duration) elapsed.value = 0
  started = true
  playing.value = true
  frame = requestAnimationFrame(tick)
}
function replay() { pause(); started = false; play() }
function seek(value: number) { pause(); started = true; elapsed.value = value }
function scrub(event: Event) { seek(Number((event.target as HTMLInputElement).value)) }
function openLarge() { expanded.value = true; dialog.value?.showModal() }
function closeLarge() { dialog.value?.close(); expanded.value = false; expandButton.value?.focus() }
function updateMotionPreference() { reducedMotion.value = media?.matches ?? false; if (reducedMotion.value) pause() }
onMounted(() => { media = window.matchMedia('(prefers-reduced-motion: reduce)'); updateMotionPreference(); media.addEventListener('change', updateMotionPreference) })
onUnmounted(() => { pause(); media?.removeEventListener('change', updateMotionPreference) })
</script>

<template>
  <section class="dsh-motion" :aria-label="`${current.label}交互动效`">
    <header class="dsh-motion__header">
      <span>{{ current.label }} · 交互示意</span>
      <button ref="expandButton" type="button" @click="openLarge" :aria-label="`放大${current.label}动效`">放大 ↗</button>
    </header>
    <div class="dsh-motion__canvas" v-html="inlineMarkup" />
    <div class="dsh-motion__description"><strong>{{ activeStage.name }}</strong><span>{{ activeStage.detail }}</span></div>
    <div class="dsh-motion__controls">
      <label v-if="scene === 'settings'" class="dsh-motion__result">保存结果
        <select v-model="outcome" aria-label="演示设置保存结果" @change="seek(3200)"><option value="success">成功</option><option value="error">失败</option><option value="conflict">版本冲突</option></select>
      </label>
      <div class="dsh-motion__transport">
        <button type="button" class="dsh-motion__primary" @click="play">{{ playing ? 'Ⅱ 暂停' : '▶ 播放' }}</button>
        <button type="button" @click="replay" aria-label="重播当前宿主交互">重播</button>
        <label>速度 <select v-model.number="speed" aria-label="宿主动效播放速度"><option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select></label>
        <span class="dsh-motion__time">{{ Math.round(elapsed) }} / {{ duration }} ms</span>
      </div>
      <input type="range" min="0" :max="duration" step="10" :value="elapsed" :aria-label="`${current.label}动效进度，单位毫秒`" @input="scrub" />
      <div class="dsh-motion__stages"><button v-for="stage in current.stages" :key="stage.at" type="button" :class="{ active: activeStage.at === stage.at }" :aria-pressed="activeStage.at === stage.at" @click="seek(stage.at)">{{ stage.name }}</button></div>
      <p v-if="reducedMotion" class="dsh-motion__preference">已按系统偏好暂停动效，可逐阶段查看或手动播放。</p>
    </div>
    <dialog ref="dialog" class="dsh-motion__dialog" :aria-label="`${current.label}动效大图`" @close="expanded = false" @cancel="pause">
      <template v-if="expanded">
        <header class="dsh-motion__header"><span>{{ current.label }} · {{ activeStage.name }}</span><button type="button" @click="closeLarge" aria-label="关闭动效大图">关闭 ×</button></header>
        <div class="dsh-motion__canvas" v-html="enlargedMarkup" />
        <div class="dsh-motion__controls">
          <div class="dsh-motion__transport"><button type="button" class="dsh-motion__primary" @click="play">{{ playing ? 'Ⅱ 暂停' : '▶ 播放' }}</button><button type="button" @click="replay">重播</button><span>{{ activeStage.detail }}</span></div>
          <input type="range" min="0" :max="duration" step="10" :value="elapsed" :aria-label="`${current.label}大图动效进度，单位毫秒`" @input="scrub" />
          <div class="dsh-motion__stages"><button v-for="stage in current.stages" :key="stage.at" type="button" :class="{ active: activeStage.at === stage.at }" @click="seek(stage.at)">{{ stage.name }}</button></div>
        </div>
      </template>
    </dialog>
  </section>
</template>

<style scoped>
.dsh-motion { margin: 24px 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg); font-size: 13px; }
.dsh-motion__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--vp-c-divider); font-weight: 500; }
.dsh-motion button, .dsh-motion select { font: inherit; border: 1px solid var(--vp-c-divider); border-radius: 5px; padding: 5px 9px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); cursor: pointer; }
.dsh-motion button:hover { border-color: var(--vp-c-brand-1); }
.dsh-motion button:focus-visible, .dsh-motion select:focus-visible, .dsh-motion input:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.dsh-motion__canvas { line-height: 0; overflow: hidden; }
.dsh-motion__canvas :deep(> svg) { display: block; width: 100%; height: auto; }
.dsh-motion__description { display: flex; gap: 16px; align-items: baseline; padding: 12px 16px; border-top: 1px solid var(--vp-c-divider); color: var(--vp-c-text-2); line-height: 1.7; }
.dsh-motion__description strong { flex: 0 0 auto; font-weight: 500; color: var(--vp-c-brand-1); }
.dsh-motion__controls { padding: 12px 16px 16px; }
.dsh-motion__transport { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-motion__transport label { display: flex; align-items: center; gap: 6px; color: var(--vp-c-text-2); }
.dsh-motion .dsh-motion__primary, .dsh-motion .active { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border-color: transparent; }
.dsh-motion__time { margin-left: auto; color: var(--vp-c-text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-motion input[type=range] { display: block; width: 100%; margin: 16px 0; accent-color: var(--vp-c-brand-1); }
.dsh-motion__stages { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-motion__stages button { border-color: transparent; background: transparent; font-size: 12px; }
.dsh-motion__result { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; color: var(--vp-c-text-2); }
.dsh-motion__preference { margin: 12px 0 0; color: var(--vp-c-text-3); font-size: 12px; }
.dsh-motion__dialog { width: min(1120px, calc(100vw - 32px)); max-width: none; max-height: calc(100vh - 32px); margin: auto; padding: 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg); color: var(--vp-c-text-1); }
.dsh-motion__dialog::backdrop { background: #0f172a80; backdrop-filter: blur(3px); }
.dsh-motion__dialog .dsh-motion__header { position: sticky; top: 0; z-index: 1; background: var(--vp-c-bg); }
.dsh-motion__dialog .dsh-motion__canvas { height: min(700px, calc(100vh - 240px)); }
.dsh-motion__dialog .dsh-motion__canvas :deep(> svg) { width: 100%; height: 100%; }
.dsh-motion__dialog .dsh-motion__transport > span { color: var(--vp-c-text-2); }
@media (max-width: 640px) { .dsh-motion__description { flex-direction: column; gap: 4px; } .dsh-motion__dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); } .dsh-motion__time { font-size: 11px; } }
</style>
