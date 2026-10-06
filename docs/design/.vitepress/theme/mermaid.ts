// Mermaid has shared configuration. Serialize theme changes and rendering so
// multiple diagrams mounting together cannot render with each other's theme.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const result = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(`flow-diagram-${++sequence}`, source);
    return svg;
  });
  queue = result.catch(() => undefined);
  return result;
}
