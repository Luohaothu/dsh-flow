/**
 * Browser capability smoke: a declared `browser` capability must really mount
 * Playwright's tools in a cluster worker's scope, and the calls must be
 * recorded as durable effect receipts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openLedger } from '../../../src/host/ledger.mjs';

export async function run({ report, layout, events }) {
  const checks = [];
  const push = (name, passed, evidence) => checks.push({ name, passed: passed === null ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500) });

  const missing = events.filter(event => event.type === 'turn-end' && (event.data.stop_detail?.message ?? '').includes('capability tools are not mounted'));
  const dbPath = join(layout.data, 'cluster.sqlite');
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (!dbPresent || !report.cluster_id) {
    return { checks, scenario_status: 'FAILED', failure_class: 'MECHANISM' };
  }
  const ledger = openLedger(dbPath);
  const effects = ledger.all('SELECT tool,status,call_id,args,body FROM effects WHERE cluster_id=? ORDER BY rowid', report.cluster_id);
  const browserEffects = effects.filter(row => row.tool.startsWith('mcp__playwright-mcp__browser_'))
    .map(row => {
      try {
        const body = JSON.parse(row.body);
        return { ...row, args: JSON.parse(row.args), body, ok: row.status === 'SETTLED' && body?.isError !== true && typeof body?.text === 'string' };
      } catch {
        return { ...row, body: null, ok: false };
      }
    });
  const tools = [...new Set(browserEffects.map(row => row.tool))];
  const navigation = browserEffects.find(row => row.ok && row.tool.endsWith('browser_navigate') && row.args?.url === report.web_url);
  const snapshot = browserEffects.find(row => row.ok && row.tool.endsWith('browser_snapshot') && row.body.text.length > 0);
  const navigatedAt = browserEffects.indexOf(navigation);
  const clickedAt = navigatedAt < 0 ? -1 : browserEffects.findIndex((row, index) => index > navigatedAt
    && row.ok && row.tool.endsWith('browser_click'));
  const panelSnapshot = clickedAt < 0 ? null : browserEffects.slice(clickedAt + 1).find(row => row.ok
    && row.tool.endsWith('browser_snapshot') && /heading "Hierarchical agent cluster"/i.test(row.body.text));
  push('browser-tools-mounted', browserEffects.length > 0,
    `${browserEffects.length} browser tool calls recorded: ${tools.join(', ') || 'none'}${missing.length ? ` (${missing.length} turns reported unmounted capability tools)` : ''}`);
  push('browser-navigate-called', Boolean(navigation), navigation
    ? `authenticated host URL ${report.web_url} navigated successfully` : `no successful navigation to the host URL; calls: ${tools.join(', ') || 'none'}`);
  push('browser-snapshot-called', Boolean(snapshot), snapshot
    ? 'native browser snapshot returned page content' : `no successful browser snapshot; calls: ${tools.join(', ') || 'none'}`);
  push('browser-click-called', clickedAt >= 0,
    clickedAt >= 0 ? 'browser clicked a control after authenticating' : 'no successful click after navigation');
  push('cluster-panel-visible', Boolean(panelSnapshot),
    panelSnapshot ? 'native post-click snapshot contains the Hierarchical agent cluster heading'
      : 'no successful post-click snapshot contains the cluster panel heading');
  push('browser-effects-settled', browserEffects.length > 0 && browserEffects.every(row => row.status === 'SETTLED'),
    JSON.stringify(browserEffects.map(row => ({ tool: row.tool, status: row.status, isError: row.body?.isError ?? null }))));

  const workerTurns = events.filter(event => event.type === 'turn-end' && event.data.role === 'worker');
  push('worker-turn-completed', workerTurns.some(event => event.data.stop_reason === 'completed'),
    workerTurns.map(event => event.data.stop_reason).join(', ') || 'no worker turn');

  // The page the case names is the host's own authenticated panel, so the
  // result must name *that* page (its title or the panel heading) — a token
  // from an external site would measure the public internet instead.
  const results = ledger.all("SELECT result FROM transactions WHERE cluster_id=? AND result IS NOT NULL", report.cluster_id);
  const title = panelSnapshot?.body.text.match(/^-\s*Page Title:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const named = Boolean(navigation && title && results.some(row => {
    const result = String(row.result).toLowerCase();
    return result.includes(title.toLowerCase()) && result.includes('hierarchical agent cluster');
  }));
  push('result-names-the-page', named,
    title ? `native snapshot title ${JSON.stringify(title)}; result ${String(results[0]?.result ?? '').slice(0, 200)}` : 'no native page title observed');
  push('snapshot-recorded-as-evidence', Boolean(snapshot),
    `successful snapshot calls recorded: ${browserEffects.filter(row => row.ok && row.tool.endsWith('browser_snapshot')).length}`);
  ledger.close();

  const failed = checks.filter(entry => entry.passed === false);
  const environmentFailed = browserEffects.some(row => row.body?.isError && /Socket path too long|Target page, context or browser has been closed|Executable doesn't exist/.test(row.body.text ?? ''))
    || failed.some(entry => entry.name === 'browser-tools-mounted');
  const mechanismFailed = failed.some(entry => entry.name === 'cluster-database-present');
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : environmentFailed ? 'ENVIRONMENT' : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}
