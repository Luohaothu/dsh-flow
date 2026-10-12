/** Scoped layout using host color, typography and native controls. */
export const TEAM_CSS = `
.flow-agent-session-header,.flow-row,.flow-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.flow-team{width:min(1100px,100%);margin:auto;padding:28px 24px 48px;box-sizing:border-box;color:inherit;overflow-wrap:anywhere}
.flow-team-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}
.flow-team h1{font-size:25px;font-weight:650;line-height:1.3;margin:6px 0 0}
.flow-team h2{font-size:17px;font-weight:600;margin:0 0 16px}.flow-team h2>span{font-size:13px;font-weight:400;opacity:.55;margin-left:7px}
.flow-team h3{font-size:17px;font-weight:600;margin:0}.flow-team h4{font-size:14px;font-weight:600;margin:22px 0 10px}
.flow-team p,.flow-team li{font-size:14px;line-height:1.65}.flow-team p{margin:9px 0}
.flow-eyebrow,.flow-muted,.flow-updated,.flow-team small{opacity:.6}.flow-eyebrow{font-size:12px;letter-spacing:.08em}
.flow-summary{font-size:13px;margin:18px 0}.flow-summary>span{white-space:nowrap}
.flow-section{margin-top:32px}.flow-objective,.flow-events{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;padding:14px 18px;margin-top:16px}
.flow-team summary{cursor:pointer;font-size:13px;line-height:1.6}.flow-prose{white-space:pre-wrap}
.flow-member-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.flow-member-card{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;padding:17px;min-width:0}
.flow-member-card p{font-size:13px;opacity:.75}.flow-member-card>.flow-row:last-child{margin-top:16px}
.flow-task-layout{display:grid;grid-template-columns:minmax(200px,28%) minmax(0,1fr);border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;overflow:hidden}
.flow-task-list{padding:8px;border-right:1px solid color-mix(in srgb,currentColor 13%,transparent)}
.flow-task-button{display:flex;flex-direction:column;gap:6px;text-align:left;width:100%;padding:13px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.flow-task-button:hover{background:color-mix(in srgb,currentColor 5%,transparent)}.flow-task-button[aria-current=true]{background:color-mix(in srgb,currentColor 9%,transparent)}
.flow-task-button span{font-size:14px;line-height:1.5}.flow-task-button small{font-size:12px}.flow-task-button:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.flow-task-details{padding:22px;min-width:0}.flow-facts{display:flex;gap:14px 28px;flex-wrap:wrap;font-size:12px;margin:16px 0}.flow-facts div{min-width:0}.flow-facts dt{opacity:.55;margin-bottom:5px}.flow-facts dd{margin:0}
.flow-result{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding:16px 0}.flow-result .flow-row{font-size:12px}.flow-review{margin-top:16px;padding:12px 16px;border-left:2px solid color-mix(in srgb,currentColor 25%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)}
.flow-message{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding:15px 0}.flow-message .flow-row{font-size:12px}.flow-message small{font-size:11px}
.flow-run-select{display:flex;gap:10px;align-items:center;font-size:12px;margin:12px 0}.flow-run-select select{background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:7px;max-width:75%}
.flow-events>details{padding:8px 0}.flow-events pre{font-size:12px;white-space:pre-wrap}.flow-updated{font-size:11px!important;text-align:right;margin-top:24px!important}
.flow-error{color:#c54639}.flow-empty{padding:40px 10px;text-align:center;opacity:.7}.flow-session-record{padding:20px;display:flex;flex-direction:column;gap:8px;font-size:13px;opacity:.65}
.flow-sidebar-chat,.flow-reader{height:100%;min-height:0;display:flex;flex-direction:column}.flow-reader>p{padding:12px}.flow-reader-actions{padding:12px;text-align:right}
@media(max-width:650px){.flow-team{padding:18px 12px 32px}.flow-team h1{font-size:21px}.flow-member-grid{grid-template-columns:1fr}.flow-task-layout{grid-template-columns:1fr}.flow-task-list{border-right:0;border-bottom:1px solid color-mix(in srgb,currentColor 13%,transparent);max-height:230px;overflow:auto}.flow-task-details{padding:16px}.flow-summary{gap:8px;font-size:12px}.flow-team-heading{align-items:flex-start}}
`;
