/** Scoped topology and detail layout using official host controls and theme tokens. */
export const TEAM_CSS = `
.flow-agent-session-header,.flow-row,.flow-status,.flow-actions,.flow-detail-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.flow-agent-session-header{display:inline-flex}.flow-status{display:inline-flex;gap:5px;white-space:nowrap;font-size:12px}
.flow-content,.flow-team-popup{font:inherit;color:var(--dsw-alias-label-primary);min-width:0;box-sizing:border-box}
.flow-content{position:relative;display:flex;flex-direction:column;flex:1;height:100%;min-height:0;overflow:hidden;container-type:inline-size;background:var(--dsw-alias-bg-base)}
.flow-content h1{font-size:14px;font-weight:500;line-height:20px;margin:0;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flow-content h3{font-size:15px;font-weight:500;margin:0}.flow-content h4{font-size:13px;font-weight:500;margin:20px 0 10px}
.flow-content p,.flow-content li{font-size:13px;line-height:1.65}.flow-content p{margin:8px 0}.flow-prose{white-space:pre-wrap;overflow-wrap:anywhere}
.flow-muted,.flow-content small,.flow-id{color:var(--dsw-alias-label-secondary)}.flow-id{overflow-wrap:anywhere;font-size:11px}
.flow-header{display:inline-flex}.flow-team-trigger{font-size:13px!important;color:var(--dsw-alias-label-secondary)!important;gap:6px!important;align-items:center!important}
.flow-trigger-state{font-size:12px;color:var(--dsw-alias-label-tertiary)}.flow-trigger-chevron{display:block;flex-shrink:0}.flow-team-trigger[aria-expanded=true]>.flow-trigger-chevron{transform:rotate(180deg)}
.flow-team-popup{position:fixed;z-index:var(--dsw-z-popover,50);width:min(360px,calc(100vw - 32px));max-height:min(440px,65dvh);overflow:auto;padding:8px;font-size:13px;line-height:18px;background:var(--dsw-specific-menu)}
.flow-team-footer{display:flex;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l3);padding-top:6px;margin-top:6px}
.flow-tree{display:flex;flex-direction:column;gap:2px;user-select:none}.flow-tree-row{display:grid;grid-template-columns:20px minmax(0,1fr) 28px;gap:4px;align-items:center;min-width:0;border-radius:var(--dsw-radius-md);padding:6px 2px}
.flow-tree-row:hover,.flow-tree-row[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.flow-tree-toggle,.flow-tree-leaf{width:20px!important;height:20px!important;min-width:20px!important;min-height:20px!important;padding:0!important;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.flow-tree-toggle>svg{display:block;transition:transform 160ms ease}.flow-tree-toggle[aria-expanded=true]>svg{transform:rotate(90deg)}
.flow-tree-open{display:flex!important;width:100%;height:auto!important;min-height:40px!important;padding:0 8px 0 0!important;text-align:start;white-space:normal;background:transparent!important;color:var(--dsw-alias-label-primary)!important}
.flow-tree-copy{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;width:100%}.flow-tree-name{font-size:13px;line-height:20px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.flow-tree-role{margin-left:6px;font-size:10px;color:var(--dsw-alias-label-tertiary)}.flow-tree-task{grid-column:1/-1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.flow-tree-aside{width:28px!important;height:28px!important;min-height:28px!important;padding:0!important;justify-content:center}
.flow-controls{position:absolute;z-index:3;top:12px;left:12px;right:12px;display:flex;pointer-events:none}.flow-controls>*{pointer-events:auto}
.flow-toolbar,.flow-zoom{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:0 3px 14px #0001;padding:8px 10px}
.flow-toolbar{max-width:100%;box-sizing:border-box}.flow-toolbar .flow-actions{margin-top:6px}.flow-team-heading{display:flex;align-items:center;gap:10px;min-width:0}
.flow-ended{display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}.flow-ended input{accent-color:var(--dsw-alias-state-business-primary)}
.flow-run-select{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0}.flow-run-select select{font:inherit;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:4px;max-width:210px;min-width:0}
.flow-structure{display:flex;flex-direction:column;flex:1;height:100%;min-height:0}.flow-graph-area{position:relative;flex:1;min-height:0;height:100%}
.flow-graph{position:absolute;inset:0;overflow:hidden;touch-action:none;background:radial-gradient(circle,var(--dsw-alias-border-l2) 1px,transparent 1px) 0 0/24px 24px}
.flow-graph-world{position:absolute;transform-origin:top left}.flow-lines{position:absolute;overflow:visible;color:var(--dsw-alias-label-secondary);pointer-events:none}.flow-lines>path{stroke-width:1.75;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.flow-node-group{position:absolute;width:220px;height:124px}.flow-node{box-sizing:border-box;width:220px;height:124px;display:flex;flex-direction:column;gap:5px;text-align:start;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:12px;font:inherit;cursor:pointer;user-select:none}
.flow-node[data-kind=member]{background:color-mix(in srgb,#9b7ee8 12%,var(--dsw-alias-bg-base));border-color:color-mix(in srgb,#9b7ee8 40%,var(--dsw-alias-border-l2))}
.flow-node[data-kind=main]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 48%,var(--dsw-alias-bg-base));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-base))}
.flow-node[aria-pressed=true]{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.flow-node strong,.flow-node small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.flow-node-person{display:flex;align-items:center;gap:8px;height:42px;max-width:130px;flex-shrink:0}.flow-node-person strong{font-size:14px;font-weight:500}.flow-avatar{display:inline-flex;width:32px;height:32px;border-radius:50%;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-3);font-size:23px;line-height:1;flex-shrink:0}
.flow-node-meta{position:absolute;top:12px;right:12px;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary)}.flow-node-meta .flow-status{font-size:10px}
.flow-node small{font-size:11px;line-height:16px}.flow-node-task{margin-top:4px}.flow-node-toggle{position:absolute;bottom:4px;right:4px}
.flow-zoom{position:absolute;z-index:5;bottom:12px;left:12px;font-size:12px}.flow-zoom>span{width:3em;text-align:center;font-variant-numeric:tabular-nums}
.flow-scroll{overflow:auto;scrollbar-gutter:stable;min-height:0}.flow-list{padding:calc(var(--flow-controls-height,100px) + 36px) 12px 24px;flex:1;box-sizing:border-box}.flow-list .flow-tree{max-width:800px}.flow-no-children{position:absolute;z-index:2;right:16px;top:12px;padding:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.flow-dock{position:absolute;z-index:4;right:12px;bottom:12px;display:flex;width:min(780px,calc(100% - 24px));height:45%;min-height:240px;max-height:calc(100% - 130px);box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:0 8px 28px #0002;overflow:hidden;resize:both}
.flow-conversation-detail,.flow-reader,.flow-sidebar-chat{display:flex;flex-direction:column;flex:1;min-height:0;height:100%}.flow-conversation-detail{overflow:hidden}.flow-information{padding:14px;box-sizing:border-box;height:100%;overflow-wrap:anywhere}
.flow-detail-heading{padding:8px;flex-shrink:0;border-bottom:1px solid var(--dsw-alias-border-l3);font-size:12px}.flow-reader>p{padding:12px}.flow-reader-actions{padding:8px;text-align:right;flex-shrink:0}
.flow-task-list{display:flex;flex-wrap:wrap;gap:6px}.flow-task-details{padding:12px 0;min-width:0}.flow-facts{display:flex;gap:14px 28px;flex-wrap:wrap;font-size:12px;margin:16px 0}.flow-facts dt{color:var(--dsw-alias-label-secondary);margin-bottom:5px}.flow-facts dd{margin:0}
.flow-result{border-top:1px solid var(--dsw-alias-border-l3);padding:14px 0}.flow-result .flow-row{font-size:12px}.flow-review{margin-top:12px;padding:10px 12px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.flow-message{border-top:1px solid var(--dsw-alias-border-l3);padding:12px 0}.flow-events{margin-top:20px}.flow-events summary{cursor:pointer;font-size:12px}.flow-events pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
.flow-error{color:var(--dsw-alias-state-error-primary,#c54639)}.flow-notices{position:absolute;z-index:6;top:110px;right:12px;max-width:min(400px,calc(100% - 24px));padding:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px}
.flow-empty{padding:140px 20px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}.flow-mobile-detail{flex:1;min-height:0;overflow:auto}.flow-mobile-detail>.flow-conversation-detail{height:100%}
.flow-session-record{padding:20px;display:flex;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}.flow-sidebar-chat{padding:8px;box-sizing:border-box}
.flow-node:focus-visible,.flow-team-popup [role=treeitem]:focus-visible,.flow-list [role=treeitem]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@container(max-width:700px){.flow-dock{height:55%}.flow-toolbar{width:100%}.flow-toolbar h1{max-width:230px}.flow-no-children{top:calc(var(--flow-controls-height,100px) + 24px);left:12px;right:auto}.flow-zoom{right:12px;width:fit-content;max-width:calc(100% - 24px)}.flow-zoom button,.flow-detail-heading button,.flow-tree-open{min-height:36px!important}.flow-run-select{max-width:100%}.flow-run-select select{max-width:190px}.flow-notices{top:160px}}
@media(prefers-reduced-motion:reduce){.flow-trigger-chevron,.flow-tree-toggle>svg{transition:none}}
`;
