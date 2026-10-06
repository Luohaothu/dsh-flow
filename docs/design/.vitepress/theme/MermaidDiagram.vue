<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { renderDiagram } from './mermaid';

const props = defineProps<{ source: string }>();
const { isDark } = useData();
const svg = ref('');
const error = ref('');
const isSequence = computed(() => /^\s*sequenceDiagram\b/m.test(props.source));
const naturalSize = ref(isSequence.value);
const naturalWidth = ref(0);
let revision = 0;
let dispose: (() => void) | undefined;

watch(() => props.source, () => {
  naturalSize.value = isSequence.value;
});

async function render() {
  const current = ++revision;
  error.value = '';
  try {
    const rendered = await renderDiagram(props.source, isDark.value);
    if (current === revision) {
      const document = new DOMParser().parseFromString(rendered, 'image/svg+xml');
      const viewBox = document.documentElement.getAttribute('viewBox')?.split(/\s+/);
      naturalWidth.value = Number(viewBox?.[2]) || 800;
      svg.value = rendered;
    }
  } catch (cause) {
    if (current === revision) {
      svg.value = '';
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

onMounted(() => {
  dispose = watch([() => props.source, isDark], render, { immediate: true });
});
onBeforeUnmount(() => {
  revision++;
  dispose?.();
});
</script>

<template>
  <figure class="mermaid-diagram" :class="{ 'natural-size': naturalSize }" :style="{ '--diagram-width': `${naturalWidth}px` }" aria-label="智能体系统示意图">
    <div class="diagram-toolbar">
      <span>{{ isSequence ? (naturalSize ? '时序图 · 可横向滚动' : '时序图') : '系统图示' }}</span>
      <button v-if="svg" type="button" :aria-pressed="naturalSize" @click="naturalSize = !naturalSize">
        {{ naturalSize ? '适应宽度' : '原尺寸' }}
      </button>
    </div>
    <div v-if="svg" class="diagram-viewport" tabindex="0" aria-label="图形区域，可横向滚动" v-html="svg" />
    <p v-else-if="!error" class="diagram-loading" role="status">正在绘制图形…</p>
    <p v-if="error" class="diagram-error" role="alert">图形渲染失败：{{ error }}</p>
    <details>
      <summary>查看 Mermaid 源码</summary>
      <pre><code>{{ source }}</code></pre>
    </details>
  </figure>
</template>
