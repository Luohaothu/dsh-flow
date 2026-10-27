import { defineConfig } from 'vitepress';

const base = process.env.DOCS_BASE ?? '/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'dsh-flow',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  vite: { build: { assetsInlineLimit: 0 } },
  description: '树状 Agent 团队、结构化作业与协作运行时',
  themeConfig: {
    siteTitle: '<span class="flow-lockup">dsh-flow<span class="flow-tag">智能体团队</span></span>',
    socialLinks: [{ icon: 'github', link: 'https://github.com/Luohaothu/dsh-flow' }],
    editLink: { pattern: 'https://github.com/Luohaothu/dsh-flow/edit/main/docs/design/:path', text: '在 GitHub 上编辑此页' },
    lastUpdated: { text: '最后更新' },
    skipToContentLabel: '跳至内容',
    nav: [
      { text: '指南', link: '/quick-start' },
      { text: '模板', link: '/templates' },
      { text: '接口', link: '/api' },
      { text: '完整设计', link: '/design' },
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: 'Flow 智能体团队', link: '/' },
        { text: 'Agent 与组织关系', link: '/agents' },
        { text: '团队使用流程', link: '/quick-start' },
      ] },
      { text: '团队协作', items: [
        { text: '团队与运行', link: '/teams' },
        { text: '团队模板', link: '/templates' },
        { text: '作业与交付', link: '/assignments' },
        { text: '消息与协作', link: '/communication' },
      ] },
      { text: '运行与界面', items: [
        { text: '运行时与宿主适配', link: '/runtime' },
        { text: '配置与权限', link: '/configuration' },
        { text: '看板与宿主界面', link: '/dashboard' },
      ] },
      { text: '参考', items: [
        { text: '接口索引', link: '/api' },
        { text: '验证方法', link: '/validation' },
        { text: '完整设计文档', link: '/design' },
      ] },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    sidebarMenuLabel: '文档目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    search: { provider: 'local', options: { translations: {
      button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
      modal: { displayDetails: '显示详情', resetButtonTitle: '清除搜索', backButtonTitle: '返回', noResultsText: '没有找到相关内容', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } },
    } } },
  },
  markdown: {
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() === 'mermaid') {
          return `<MermaidDiagram source="${md.utils.escapeHtml(token.content)}" />\n`;
        }
        return fence(tokens, index, options, env, self);
      };
    },
  },
});
