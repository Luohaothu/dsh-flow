<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useData } from 'vitepress';

const { page } = useData();
const sources = import.meta.glob<string>('../../**/*.md', { query: '?raw', import: 'default' });
const sourceUrls = import.meta.glob<string>('../../**/*.md', { query: '?url', import: 'default', eager: true });
const status = ref('复制页面');
const sourceUrl = computed(() => sourceUrls[`../../${page.value.relativePath}`]);
watch(() => page.value.relativePath, () => { status.value = '复制页面'; });

async function copyPage() {
  const path = page.value.relativePath;
  try {
    const load = sources[`../../${path}`];
    if (!load) throw new Error('Page source unavailable');
    await navigator.clipboard.writeText(await load());
    if (page.value.relativePath === path) status.value = '已复制';
  } catch {
    if (page.value.relativePath === path) status.value = '复制失败，请查看源码';
  }
}
</script>

<template>
  <div v-if="!page.isNotFound" class="page-actions">
    <div class="page-actions-controls">
      <button type="button" @click="copyPage" aria-live="polite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="8" y="8" width="12" height="13" rx="2" />
          <path d="M16 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h1" />
        </svg>
        {{ status }}
      </button>
      <a :href="sourceUrl" target="_blank" rel="noreferrer">查看源码</a>
    </div>
  </div>
</template>
