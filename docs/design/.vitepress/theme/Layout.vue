<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import PageActions from './PageActions.vue';
</script>

<template>
  <DefaultTheme.Layout>
    <template #doc-before><PageActions /></template>
  </DefaultTheme.Layout>
</template>
