<script setup lang="ts">
import { withBase } from 'vitepress';
defineProps<{ src: string; alt: string; caption: string }>();
</script>

<template>
  <figure class="agent-tree-figure">
    <div class="agent-tree-figure__viewport" tabindex="0" :aria-label="alt">
      <img :src="withBase(src)" :alt="alt" loading="lazy" />
    </div>
    <figcaption>
      <span>{{ caption }}</span>
      <a :href="withBase(src)" target="_blank" rel="noopener">查看大图 ↗</a>
    </figcaption>
  </figure>
</template>

<style scoped>
.agent-tree-figure { margin: 24px 0; }
.agent-tree-figure__viewport {
  overflow: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: #fafafa;
}
.agent-tree-figure__viewport:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
.agent-tree-figure__viewport img { display: block; width: 100%; height: auto; }
.agent-tree-figure figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--vp-c-text-2); font-size: 13px; line-height: 1.7; }
.agent-tree-figure figcaption a { white-space: nowrap; }
</style>
