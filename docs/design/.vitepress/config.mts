import { defineConfig } from 'vitepress';

const base = process.env.DOCS_BASE ?? '/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'dsh-flow',
  description: '层次化智能体集群的使用指南、系统设计与开发文档。',
  cleanUrls: true,
  lastUpdated: true,
  // Keep local viewing at / while allowing static hosting below a path prefix.
  base,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  // Markdown source links must remain navigable files, including short pages.
  vite: { build: { assetsInlineLimit: 0 } },
  themeConfig: {
    siteTitle: '<span class="flow-lockup">dsh-flow<span class="flow-tag">智能体集群</span></span>',
    nav: [
      { text: '入门', link: '/quick-start', activeMatch: '^/(quick-start|advanced|agents|hierarchy|dispatch|communication)' },
      { text: '开发', link: '/development/', activeMatch: '^/development/(?!api|action-catalog|compatibility)' },
      { text: '参考', link: '/configuration/agents', activeMatch: '^/(configuration|development/(api|action-catalog|compatibility))' },
    ],
    sidebar: [
      {
        text: '入门',
        items: [
          { text: '欢迎', link: '/' },
          { text: '快速上手', link: '/quick-start' },
          { text: '高级使用', link: '/advanced' },
        ],
      },
      {
        text: '智能体系统',
        items: [
          { text: '智能体分类', link: '/agents' },
          { text: '层次化智能体结构', link: '/hierarchy' },
          { text: '任务派发', link: '/dispatch' },
          { text: '智能体通信', link: '/communication' },
        ],
      },
      {
        text: '配置参数',
        items: [
          { text: '智能体配置参数', link: '/configuration/agents' },
          { text: '集群配置参数', link: '/configuration/cluster' },
        ],
      },
      {
        text: '开发文档',
        collapsed: false,
        items: [
          { text: '开发概览', link: '/development/' },
          { text: '开发环境搭建', link: '/development/setup' },
          { text: '代码结构', link: '/development/code-structure' },
          {
            text: '核心组件',
            collapsed: false,
            items: [
              { text: '控制平面与调度', link: '/development/components/control-plane' },
              { text: '任务单元与独立审计', link: '/development/components/transactions' },
              { text: '执行分配与组织调整', link: '/development/components/allocation' },
              { text: '智能体运行时', link: '/development/components/runtime' },
              { text: '持久化与恢复', link: '/development/components/persistence' },
              { text: '预算账本', link: '/development/components/budget' },
              { text: '通信与共享黑板', link: '/development/components/communication' },
              { text: '查询与可观测性', link: '/development/components/observability' },
            ],
          },
          { text: 'API 手册', link: '/development/api' },
          { text: '设计动作索引', link: '/development/action-catalog' },
          { text: 'dsh 兼容性', link: '/development/compatibility' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Luohaothu/dsh-flow' }],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    skipToContentLabel: '跳至内容',
    editLink: { pattern: 'https://github.com/Luohaothu/dsh-flow/edit/main/docs/design/:path', text: '在 GitHub 上编辑此页' },
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详情',
                resetButtonTitle: '清除查询',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到相关内容',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
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
