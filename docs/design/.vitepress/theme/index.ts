import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import MermaidDiagram from './MermaidDiagram.vue';
import Layout from './Layout.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('MermaidDiagram', MermaidDiagram);
  },
} satisfies Theme;
