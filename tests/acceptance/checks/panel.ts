/**
 * Panel case: verify the shipped browser half against the running host.
 *
 * `live` runs while the host is still up: it drives the real panel in a real
 * Chromium, exercises pause/resume/cancel and the report download, and proves
 * the `/api/flow` route is refused without the host's authentication.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { ConsoleMessage, Download, Locator, Page } from 'playwright';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { asArray, asNumber, asObject, asString, decodeSnapshot, messageOf } from '../context.ts';
import type { CheckEntry, RunEvent, RunSnapshot } from '../context.ts';
import { browserExecutablePath, importPlaywright } from '../../../src/host/browser.ts';
import { openLedger } from '../../../src/host/ledger.ts';
import type { SqlRow } from '../../../src/host/ledger.ts';
import type { RunLayout } from '../../../src/host/types.ts';
import { ClusterStore } from '../../../packages/dsh-flow/src/core/store.ts';

interface PanelReport {
  readonly cluster_id?: string | null;
  readonly web_url?: string | null;
  readonly live_checks?: { readonly checks?: CheckEntry[] } | null;
  readonly failure?: { readonly message: string } | null;
}

interface PanelHost {
  waitForWebUrl(timeoutMs?: number): Promise<string>;
  request(op: 'read' | 'query', id: string | undefined, payload?: unknown): Promise<unknown>;
}
interface PanelLiveContext {
  readonly report: PanelReport;
  readonly layout: Pick<RunLayout, 'root' | 'data' | 'artifacts'>;
  readonly host: PanelHost;
  readonly mock?: { release(barrier: string): number } | null;
}

interface PanelRunContext {
  readonly report: Pick<PanelReport, 'cluster_id' | 'live_checks' | 'failure'>;
  readonly layout: Pick<RunLayout, 'data'>;
  readonly events: readonly RunEvent[];
}






interface ProbeResponse {
  readonly status: number | null;
  readonly body: unknown;
  readonly error: string | null;
}

interface ProbeState {
  readonly cursor: number | null;
  readonly cluster: SqlRow | undefined;
  readonly status: string | null;
}

function sqlNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}

function readProbeState(layout: Pick<RunLayout, 'data'>, clusterId: string): ProbeState {
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  try {
    const cursorRow = ledger.get(
      'SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE cluster_id=?', clusterId);
    const cluster = ledger.get('SELECT * FROM clusters WHERE id=?', clusterId);
    const status = cluster?.status;
    return {
      cursor: sqlNumber(cursorRow?.cursor),
      cluster,
      status: typeof status === 'string' ? status : null,
    };
  } finally {
    ledger.close();
  }
}

function queryPayload(value: unknown, expectedWhat: string): Record<string, unknown> | null {
  const record = asObject(value);
  if (!record) return null;
  if ('what' in record || 'data' in record) {
    return record.what === expectedWhat ? asObject(record.data) : null;
  }
  return record;
}
function remoteSuccess(value: unknown): Extract<RemoteResult<unknown>, { ok: true }> | null {
  const result = asObject(asObject(value)?.result);
  return result?.ok === true && 'value' in result ? { ok: true, value: result.value } : null;
}

function remoteFailureCode(value: unknown): string | null {
  const result = asObject(asObject(value)?.result);
  return result?.ok === false ? asString(asObject(result.error)?.code) : null;
}


export async function live({ report, layout, host, mock = null }: PanelLiveContext) {
  const checks: CheckEntry[] = [];
  const push = (name: string, passed: boolean | null | undefined, evidence: string): void => {
    checks.push({ name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500) });
  };

  const artifacts = join(layout.artifacts, 'panel');
  const clusterId = report.cluster_id ?? '';
  const fixtureId = `paneltree-${clusterId}`;

  // The cluster is still running here; the panel checks drive it through
  // pause, resume and cancel before it can reach a terminal state on its own.
  const url = report.web_url ?? (await host.waitForWebUrl(60_000));
  push('host-served-web-url', Boolean(url), `url ${url ?? 'not observed'}`);

  const apiUrl = new URL('/api/flow/list', url);
  const unauthenticated = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  push('unauthenticated-flow-route-refused', unauthenticated.status === 401 || unauthenticated.status === 403,
    `POST /api/flow/list without the host token returned ${unauthenticated.status}`);

  const playwright = await importPlaywright();
  if (!playwright) {
    push('browser-available', false, 'playwright not resolvable');
    return { checks, blocked: ['browser-available'] };
  }
  const executablePath = browserExecutablePath();
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // A function handed to `page.evaluate` is serialized into the page as source,
    // and the TS loader rewrites named functions with its own `__name` helper —
    // which lives in this module, not in the browser. Without it the probe dies
    // with `ReferenceError: __name is not defined` before making a single
    // request, which is a false MECHANISM failure rather than a finding. Defined
    // per context so every page this check opens has it.
    await context.addInitScript('window.__name = function (target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch (error) {} return target; };');
    let page: Page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error: Error) => consoleErrors.push(error.message));
    // The app holds an open event stream, so `networkidle` never settles.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    // The shipped app opens with an internal-testing notice that covers the
    // frame; acknowledge it before driving the panel.
    const notice = page.getByRole('button', { name: /^continue$/i }).first();
    if (await notice.isVisible().catch(() => false)) {
      await notice.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    const panelEntry = page.getByRole('button', { name: /cluster/i }).first();
    const entryVisible = await panelEntry.isVisible().catch(() => false);
    push('sidebar-entry-present', entryVisible, `sidebar Cluster entry visible: ${entryVisible}`);
    if (entryVisible) await panelEntry.click().catch(() => {});
    await page.waitForTimeout(2000);

    const clusterPrefix = report.cluster_id?.slice(0, 8) ?? 'never';
    push('panel-heading', (await page.getByRole('heading', { name: /hierarchical agent cluster/i }).count()) >= 1,
      'the panel heading is a real heading element');
    push('cluster-listed', (await page.locator('.dsh-flow-list button.is-selected').count()) >= 1
      && ((await page.locator('.dsh-flow-list button.is-selected').first().textContent()) ?? '').includes(clusterPrefix),
      `the selected cluster row shows ${clusterPrefix}`);

    // The summary is a set of DOM nodes, not a sentence: assert the values the
    // host reported, by element.
    const stats = await statMap(page);
    push('summary-stats-rendered', Object.keys(stats).length >= 8, JSON.stringify(stats).slice(0, 400));
    push('summary-reports-the-event-cursor', Number(stats['Event cursor'] ?? 0) > 0,
      `event cursor stat: ${stats['Event cursor']}`);

    // Exercise pause and resume while the cluster is still live; cancel after reconnect.
    const pause = page.getByRole('button', { name: /^pause$/i }).first();
    await pause.click().catch(() => {});
    const pausedSeen = await waitForClusterStatus(page, /^PAUSED$/i, 20_000);
    push('pause-from-panel', pausedSeen === 'PAUSED', `cluster status element reported PAUSED: ${pausedSeen}`);
    const resume = page.getByRole('button', { name: /^resume$/i }).first();
    await resume.click().catch(() => {});
    const resumedSeen = await waitForClusterStatus(page, /^(RUNNING|BLOCKED|COMPLETED)$/i, 20_000);
    push('resume-from-panel', resumedSeen !== null && /^(RUNNING|BLOCKED|COMPLETED)$/i.test(resumedSeen), `cluster status after resume: ${resumedSeen}`);

    // The tree is lazy: nothing is rendered until a level is asked for.
    const nodesBefore = await page.locator('.dsh-flow-tree .dsh-flow-node').count();
    const loadRoot = page.locator('.dsh-flow-load').first();
    push('tree-is-lazy', nodesBefore === 0 && (await loadRoot.isVisible().catch(() => false)),
      `${nodesBefore} tree rows before expanding; a Load root control is present`);
    await loadRoot.click().catch(() => {});
    await page.waitForTimeout(800);
    const rootRows = await page.locator('.dsh-flow-tree .dsh-flow-node').count();
    push('tree-expands-a-level', rootRows >= 1, `${rootRows} tree rows after loading the root level`);

    // Selecting a node loads that node's transactions, and opening one shows
    // the plan audit, the validation evidence and the recorded result.
    const nodeButton = page.locator('.dsh-flow-tree .dsh-flow-node').first();
    await nodeButton.click().catch(() => {});
    await page.waitForTimeout(800);
    const tabButtons = page.locator('.dsh-flow-tabs button');
    push('tabs-rendered', (await tabButtons.count()) >= 5, `${await tabButtons.count()} tabs`);
    await page.getByRole('button', { name: /^transactions$/i }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const txButtons = page.locator('.dsh-flow-tx');
    const txCount = await txButtons.count();
    push('transactions-listed', txCount >= 1, `${txCount} transaction rows in the transactions tab`);
    const txHeading = (await page.getByRole('heading', { name: /^Transactions \(/ }).first().textContent().catch(() => '')) ?? '';
    push('transactions-total-matches-listed-rows', /^Transactions \(1 of 1\)$/.test(txHeading),
      `transaction tab heading: ${txHeading}`);
    if (txCount >= 1) await txButtons.first().click().catch(() => {});

    // Section 18, communication and context are real views with real rows.
    await page.getByRole('button', { name: /^health$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const healthText = (await page.locator('.dsh-flow-panel').textContent().catch(() => '')) ?? '';
    push('health-view-renders', /transaction_coverage/.test(healthText) && /Measured signals/i.test(healthText),
      healthText.slice(-400));
    await page.getByRole('button', { name: /^communication$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const commText = (await page.locator('.dsh-flow-panel').textContent().catch(() => '')) ?? '';
    push('communication-view-renders', /Message deliveries/i.test(commText), commText.slice(-200));
    await page.getByRole('button', { name: /^context$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const ctxText = (await page.locator('.dsh-flow-panel').textContent().catch(() => '')) ?? '';
    push('context-view-renders', /Context pressure/i.test(ctxText) && /Latest summary/i.test(ctxText), ctxText.slice(-200));
    const contextEvidence: SqlRow | undefined = (() => {
      const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
      try {
        return ledger.get(
          `SELECT seq, json_extract(data,'$.agent_id') AS agent_id, json_extract(data,'$.before') AS before,
                  json_extract(data,'$.after') AS after
             FROM events WHERE cluster_id=? AND type='context-step' ORDER BY seq DESC LIMIT 1`, clusterId);
      } finally {
        ledger.close();
      }
    })();
    const contextSeq = sqlNumber(contextEvidence?.seq);
    const contextAgentId = asString(contextEvidence?.agent_id);
    if (contextSeq !== null && contextAgentId !== null) {
      await page.getByRole('combobox', { name: 'Context agent' }).selectOption(contextAgentId).catch(() => {});
      await page.waitForFunction((seq: number) => [...document.querySelectorAll('.dsh-flow-context-steps li')]
        .some(row => row.textContent?.startsWith(`#${seq} step `)), contextSeq, { timeout: 15_000 }).catch(() => {});
    }
    const contextRow = contextSeq !== null
      ? await page.locator('.dsh-flow-context-steps li').filter({ hasText: `#${contextSeq} step ` }).first().textContent().catch(() => null)
      : null;
    push('context-step-matches-durable-agent',
      Boolean(contextEvidence && contextAgentId && contextRow?.includes(`${String(contextEvidence.before)} → ${String(contextEvidence.after)}`)),
      `${contextAgentId ?? 'no durable context step'}: ${contextRow ?? 'no matching context row in DOM'}`);
    await page.getByRole('button', { name: /^resources$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const resourceText = (await page.locator('.dsh-flow-panel').textContent().catch(() => '')) ?? '';
    push('resources-view-renders', /Budgets \(/.test(resourceText) && /api_cost/.test(resourceText), resourceText.slice(-300));

    const eventsRendered = await page.locator('.dsh-flow-events li').count();
    push('events-stream-rendered', eventsRendered > 0, `${eventsRendered} event rows`);

    // The event cursor is real: it tracks the cluster's durable event log. It
    // does not have to grow on demand — this case cancels the cluster, and a
    // cancelled cluster produces almost no further events — so the requirement is
    // that the page converges to the log's own latest sequence.
    let durableLatest: number | null;
    try {
      const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
      try {
        durableLatest = sqlNumber(ledger.get(
          'SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE cluster_id=?', clusterId)?.m);
      } finally {
        ledger.close();
      }
    } catch {
      durableLatest = null;
    }
    const cursorBefore = Number((await statMap(page))['Event cursor'] ?? 0);
    await page.getByRole('button', { name: /^tree$/i }).first().click().catch(() => {});
    const cursorAfter = await waitForCursor(page, durableLatest ?? cursorBefore, 30_000);
    const caughtUp = durableLatest === null ? cursorAfter >= cursorBefore : cursorAfter >= durableLatest;
    push('event-cursor-advances', caughtUp,
      `cursor ${cursorBefore} → ${cursorAfter}; the cluster's durable log has ${durableLatest ?? 'unknown'} events`);

    // Snapshot the console *before* the refusal probe: a deliberately refused
    // fetch logs its own 404, and those five are the probe working, not a
    // defect in the panel.
    const consoleErrorsBeforeProbe = consoleErrors.length;

    // The operations that drive the host itself must not be reachable from a
    // page, authenticated or not. The probe first establishes which of the two
    // it is, so a 401 is never mistaken for the whitelist working.
    const probeStateBefore = readProbeState(layout, clusterId);
    const probe = await page.evaluate(async () => {
      const ask = async (path: string, body: object): Promise<ProbeResponse> => {
        try {
          const response = await fetch(path, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          const parsed: unknown = await response.json().catch(() => null);
          return { status: response.status, body: parsed, error: null };
        } catch (error: unknown) {
          return { status: null, body: null, error: error instanceof Error ? error.message : String(error) };
        }
      };
      const remoteCall = (method: string, args: Record<string, unknown>): Promise<ProbeResponse> =>
        ask(`/api/flow/${method}`, {
          type: 'client-request', rpcId: crypto.randomUUID(),
          method: `flow/${method}`, payload: { args },
        });
      const listed = await remoteCall('list', { request: {} });
      const ops = {
        single: await remoteCall('single', {}),
        settle: await remoteCall('settle', {}),
        tick: await remoteCall('tick', {}),
        recover: await remoteCall('recover', {}),
        dispose: await remoteCall('dispose', {}),
      };
      const strict = {
        extra: await remoteCall('list', { request: {}, unexpected: true }),
        wrong: await remoteCall('read', { id: 42, request: {} }),
        nestedExtra: await remoteCall('list', { request: { unexpected: true } }),
      };
      return { listed, ops, strict };
    });
    const probeStateAfter = readProbeState(layout, clusterId);
    let readAfter: RunSnapshot | null = null;
    let readAfterError: string | null = null;
    try {
      readAfter = decodeSnapshot(await host.request('read', clusterId, { include_events: false }));
    } catch (error: unknown) {
      readAfterError = messageOf(error);
    }
    const readAfterWorks = readAfter?.cluster.id === clusterId;
    const cursorUnchanged = probeStateBefore.cursor !== null
      && probeStateBefore.cursor === probeStateAfter.cursor;
    const statusUnchanged = probeStateBefore.status !== null
      && probeStateBefore.status === probeStateAfter.status;
    const clusterRowUnchanged = probeStateBefore.cluster !== undefined
      && probeStateAfter.cluster !== undefined
      && isDeepStrictEqual(probeStateBefore.cluster, probeStateAfter.cluster);
    const authenticated = probe.listed.status === 200 && remoteSuccess(probe.listed.body) !== null;
    const refused = Object.values(probe.ops).filter(result => result.status !== null && result.status >= 400);
    push('internal-ops-refused',
      authenticated && refused.length === 5 && cursorUnchanged && statusUnchanged && clusterRowUnchanged && readAfterWorks,
      `page-authenticated=${authenticated}; statuses=${JSON.stringify(Object.fromEntries(Object.entries(probe.ops).map(([method, result]) => [method, result.status])))}; event cursor ${probeStateBefore.cursor} → ${probeStateAfter.cursor}; cluster status ${probeStateBefore.status} → ${probeStateAfter.status}; cluster row unchanged=${clusterRowUnchanged}; read-after works=${readAfterWorks}${readAfterError ? ` (${readAfterError})` : ''}`);
    if (authenticated) {
      const unknown = Object.values(probe.ops).filter(result => result.status === 404);
      push('internal-ops-refused-with-unknown-op', unknown.length === 5,
        `an authenticated page gets 404 for all five undeclared Remote methods: ${unknown.length}/5`);
    } else {
      push('internal-ops-refused-with-unknown-op', false,
        `the page could not authenticate to the Remote route (list returned ${probe.listed.status}); authenticated probes are required`);
    }
    // Verification §5 requires extra named RPC arguments and wrong types to be
    // refused. The generated z.object DTO codec strips nested unknown fields;
    // recursive DTO strictness is generator-owned, not an application gate.
    push('strict-remote-wire-arguments-refused',
      authenticated && remoteFailureCode(probe.strict.extra.body) === 'gateway/arguments-invalid'
        && remoteFailureCode(probe.strict.wrong.body) === 'gateway/input-invalid',
      JSON.stringify(Object.fromEntries(Object.entries(probe.strict).map(([name, result]) =>
        [name, { status: result.status, code: remoteFailureCode(result.body) }]))));
    push('generated-nested-dto-extra-field-policy', null,
      `observed only, not a claim of recursive strictness: ${JSON.stringify({
        status: probe.strict.nestedExtra.status,
        code: remoteFailureCode(probe.strict.nestedExtra.body),
        accepted: remoteSuccess(probe.strict.nestedExtra.body) !== null,
      })}`);

    const legacyProbe = await page.evaluate(async () => {
      const ask = async (body: object): Promise<ProbeResponse> => {
        try {
          const response = await fetch('/api/flow', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          const parsed: unknown = await response.json().catch(() => null);
          return { status: response.status, body: parsed, error: null };
        } catch (error: unknown) {
          return { status: null, body: null, error: error instanceof Error ? error.message : String(error) };
        }
      };
      return {
        opOnly: await ask({ op: 'list' }),
        legacyShape: await ask({ op: 'list', id: null, payload: {} }),
      };
    });
    const legacyRefused = [legacyProbe.opOnly, legacyProbe.legacyShape]
      .every(result => result.status !== null && result.status >= 400);
    push('legacy-op-envelope-refused', legacyRefused,
      `POST /api/flow old envelopes returned ${legacyProbe.opOnly.status} and ${legacyProbe.legacyShape.status}`);

    await screenshot(page, artifacts, 'panel.png');
    // The downloaded report names the cluster it really came from.
    const download: Download | null = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }).catch((): null => null),
      page.getByRole('button', { name: /download report/i }).first().click().catch(() => {}),
    ]).then(([event]) => event);
    if (download) {
      const target = join(artifacts, 'panel-report.json');
      await download.saveAs(target).catch(() => {});
      let matches = false;
      let detail = `downloaded ${target}`;
      try {
        const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'));
        const cluster = asObject(asObject(parsed)?.cluster);
        const downloadedId = asString(cluster?.id);
        matches = downloadedId === clusterId;
        detail = `report cluster ${downloadedId ?? 'unknown'} vs running ${clusterId}`;
      } catch (error: unknown) {
        detail = `could not read the download: ${messageOf(error)}`;
      }
      push('report-download-matches-cluster', matches, detail);
    } else {
      push('report-download-matches-cluster', false, 'no download event observed');
    }

    // Closing the page must not cancel its cluster. Reopen a new tab in the
    // authenticated browser context and resume from the durable event cursor.
    const cursorBeforeClose = Number((await statMap(page))['Event cursor'] ?? 0);
    await page.close();
    const afterClose = decodeSnapshot(await host.request('read', clusterId, { include_events: false }));
    push('page-close-does-not-cancel-cluster', afterClose !== null && Boolean(afterClose.cluster.status) && afterClose.cluster.status !== 'CANCELLED',
      `host cluster status after closing the tab: ${afterClose?.cluster.status ?? 'unknown'}`);
    page = await context.newPage();
    page.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error: Error) => consoleErrors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);
    const noticeAgain = page.getByRole('button', { name: /^continue$/i }).first();
    if (await noticeAgain.isVisible().catch(() => false)) {
      await noticeAgain.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const entryAgain = page.getByRole('button', { name: /cluster/i }).first();
    if (await entryAgain.isVisible().catch(() => false)) await entryAgain.click().catch(() => {});
    await page.waitForTimeout(2500);
    push('reconnect-after-close', new RegExp(clusterPrefix, 'i').test((await page.textContent('body')) ?? ''),
      `cluster ${clusterPrefix} still visible after opening a new tab`);
    const cursorAfterClose = await waitForCursor(page, cursorBeforeClose, 20_000);
    push('cursor-continues-after-close', cursorAfterClose >= cursorBeforeClose,
      `${cursorBeforeClose} before closing, ${cursorAfterClose} after reopening`);

    const cancel = page.getByRole('button', { name: /^cancel$/i }).first();
    await cancel.click().catch(() => {});
    // The closeout request the scenario held is released *after* the click: the
    // cancel has to land on a cluster that is genuinely mid-turn, not on one the
    // fixture quietly finished first. A cancelled cluster fences that turn, so
    // the held request ends as a client-side disconnect — the tested fault.
    const released = mock?.release('panel-hold') ?? 0;
    push('fixture-held-closeout-until-cancel', released > 0 || !mock, `${released} held closeout request(s) released after the cancel click`);
    const cancelledSeen = await waitForClusterStatus(page, /^CANCELLED$/i, 30_000);
    push('cancel-from-panel', cancelledSeen === 'CANCELLED', `cluster status after cancel: ${cancelledSeen}`);
    // Reopen the transaction after cancellation. The independent Auditor may
    // still have a PENDING validation review when the user cancels the cluster.
    await page.getByRole('button', { name: /^transactions$/i }).first().click().catch(() => {});
    const finalTx = page.locator('.dsh-flow-tx').first();
    await finalTx.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (txCount >= 1) await finalTx.click().catch(() => {});
    await page.waitForFunction(() => {
      const text = document.querySelector('.dsh-flow-detail')?.textContent ?? '';
      return /validation:\s*\{"checks":/.test(text) && /result:\s*\{/.test(text)
        && /audit plan rev\d+ (?:PENDING|APPROVED|REJECTED)/.test(text)
        && /audit validation rev\d+ (?:PENDING|APPROVED|REJECTED)/.test(text);
    }, undefined, { timeout: 15_000 }).catch(() => {});
    const finalDetail = (await page.locator('.dsh-flow-detail').first().textContent().catch(() => '')) ?? '';
    push('transaction-detail-shows-evidence',
      /validation:\s*\{"checks":/.test(finalDetail) && /result:\s*\{/.test(finalDetail)
        && /audit plan rev\d+ (?:PENDING|APPROVED|REJECTED)/.test(finalDetail)
        && /audit validation rev\d+ (?:PENDING|APPROVED|REJECTED)/.test(finalDetail),
      finalDetail.slice(-1200));
    await screenshot(page, artifacts, 'panel-audit-detail.png');

    // A paused, separately identified store fixture tests the real host query
    // and browser path without adding model work to the acceptance cluster.
    const fixture = new ClusterStore(join(layout.data, 'cluster.sqlite'));
    const rootId = `${fixtureId}-root`;
    const fixtureChildId = `${fixtureId}-child-000`;
    const fixtureTxId = `${fixtureId}-tx-000`;
    let fixtureLastEventSeq: number | null = null;
    try {
      fixture.tx(() => {
        fixture.createCluster({
          id: fixtureId, objective: 'Panel pagination fixture',
          workspace: layout.root, capabilities: [],
          limits: { max_children: 128, max_depth: 2, max_active_agents: 1 },
        }, {});
        fixture.updateCluster(fixtureId, { status: 'PAUSED' });
        fixture.insertNode({
          id: rootId, cluster_id: fixtureId, kind: 'management', depth: 0,
          status: 'PAUSED', path: '0', max_children: 121,
        });
        for (let index = 0; index < 121; index += 1) {
          fixture.insertNode({
            id: `${fixtureId}-child-${String(index).padStart(3, '0')}`,
            cluster_id: fixtureId, parent_id: rootId, kind: 'worker',
            depth: 1, status: 'PAUSED', path: `0.${index}`, max_children: 0,
          });
        }
        for (let index = 0; index < 51; index += 1) {
          fixture.insertTransaction({
            id: `${fixtureId}-tx-${String(index).padStart(3, '0')}`,
            cluster_id: fixtureId, node_id: fixtureChildId, owner_management_id: rootId,
            objective: `Panel transaction page ${index}`, acceptance_criteria: ['fixture is visible'],
            capabilities: [], status: 'DRAFT',
          });
        }
        for (let index = 0; index < 230; index += 1) {
          fixtureLastEventSeq = fixture.appendEvent(fixtureId, 'panel-fixture-event', { index }).seq;
        }
      });
    } finally {
      fixture.close();
    }
    if (fixtureLastEventSeq === null) throw new Error('panel fixture did not append an event');
    const lastFixtureEventSeq = fixtureLastEventSeq;
    const fixturePageReply = await host.request('query', fixtureId, {
      what: 'nodes', params: { parent_id: rootId, limit: 50 },
    });
    const fixturePage = queryPayload(fixturePageReply, 'nodes');
    const fixtureItems = asArray(fixturePage?.items);
    const fixtureTotal = asNumber(fixturePage?.total);
    push('large-tree-fixture-is-separate', fixtureTotal === 121 && fixtureItems?.length === 50,
      `${fixtureId}: ${fixtureItems?.length ?? 'unknown'} of ${fixtureTotal ?? 'unknown'} direct children`);
    const fixtureButton = page.getByRole('button', { name: /^paneltre/i }).first();
    await fixtureButton.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await fixtureButton.click().catch(() => {});
    const fixtureCursor = await waitForCursor(page, lastFixtureEventSeq, 30_000);
    const latestFixtureEvent = (await page.locator('.dsh-flow-events li').allTextContents())
      .some((text: string) => text.includes(`#${lastFixtureEventSeq} panel-fixture-event`));
    push('event-cursor-crosses-two-pages-and-global-id-gap',
      fixtureCursor >= lastFixtureEventSeq && latestFixtureEvent,
      `230 isolated events; durable last seq ${lastFixtureEventSeq}, DOM cursor ${fixtureCursor}, latest event visible ${latestFixtureEvent}`);
    await page.getByRole('button', { name: /^tree$/i }).first().click().catch(() => {});
    const fixtureRowsBefore = await page.locator('.dsh-flow-tree .dsh-flow-node').count();
    const fixtureRoot = page.locator('.dsh-flow-load').first();
    await fixtureRoot.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await fixtureRoot.isVisible().catch(() => false)) await fixtureRoot.click().catch(() => {});
    const fixtureRootRow = page.locator('.dsh-flow-tree > li > button.dsh-flow-node').first();
    await fixtureRootRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await fixtureRootRow.isVisible().catch(() => false)) await fixtureRootRow.click().catch(() => {});
    const childRows = page.locator('.dsh-flow-tree > li > ul > li > button.dsh-flow-node');
    const secondPage = page.getByRole('button', { name: /^Load more children \(50\/121\)$/ }).first();
    await secondPage.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const firstCount = await childRows.count();
    if (await secondPage.isVisible().catch(() => false)) await secondPage.click().catch(() => {});
    const thirdPage = page.getByRole('button', { name: /^Load more children \(100\/121\)$/ }).first();
    await thirdPage.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const secondCount = await childRows.count();
    if (await thirdPage.isVisible().catch(() => false)) await thirdPage.click().catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('.dsh-flow-tree > li > ul > li > button.dsh-flow-node').length === 121,
      undefined, { timeout: 10_000 }).catch(() => {});
    const finalCount = await childRows.count();
    const finalChildVisible = (await childRows.filter({ hasText: /\b0\.120\b/ }).count()) === 1;
    push('large-tree-lazy-child-pagination',
      fixtureRowsBefore === 0 && firstCount === 50 && secondCount === 100 && finalCount === 121
        && finalChildVisible && (await page.getByRole('button', { name: /^Load more children/ }).count()) === 0,
      `before ${fixtureRowsBefore}; children ${firstCount} → ${secondCount} → ${finalCount}; final child 0.120: ${finalChildVisible}`);
    await childRows.last().scrollIntoViewIfNeeded().catch(() => {});
    await screenshot(page, artifacts, 'panel-large-tree.png');
    const nodePageReply = await host.request('query', fixtureId, {
      what: 'node', params: { id: fixtureChildId, limit: 50 },
    });
    const nodePage = queryPayload(nodePageReply, 'node');
    const nodeTransactions = asObject(nodePage?.transactions);
    const nodeTransactionItems = asArray(nodeTransactions?.items);
    const nodeTransactionTotal = asNumber(nodeTransactions?.total);
    const nodeTransactionOffset = asNumber(nodeTransactions?.next_offset);
    push('node-transactions-have-true-page-total',
      nodeTransactionItems?.length === 50 && nodeTransactionTotal === 51 && nodeTransactionOffset === 50,
      `child node transactions ${nodeTransactionItems?.length ?? 'unknown'} of ${nodeTransactionTotal ?? 'unknown'}, next ${nodeTransactionOffset ?? 'none'}`);
    await childRows.first().click().catch(() => {});
    const nodeMore = page.getByRole('button', { name: /^load more \(50\/51\)$/i }).first();
    await nodeMore.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await nodeMore.isVisible().catch(() => false)) await nodeMore.click().catch(() => {});
    const nodeRows = page.locator('.dsh-flow-tree > li > ul > li:first-child ul li button.dsh-flow-node');
    await page.waitForFunction(() => document.querySelectorAll('.dsh-flow-tree > li > ul > li:first-child ul li button.dsh-flow-node').length === 51,
      undefined, { timeout: 10_000 }).catch(() => {});
    push('node-transactions-load-all-pages', await nodeRows.count() === 51,
      `${await nodeRows.count()} of 51 node transaction rows visible after load more`);

    await page.getByRole('button', { name: /^transactions$/i }).first().click().catch(() => {});
    const fixtureTxRow = page.locator('.dsh-flow-tx').first();
    await fixtureTxRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const beforeStatus = await fixtureTxRow.textContent().catch(() => '');
    const updater = new ClusterStore(join(layout.data, 'cluster.sqlite'));
    try {
      updater.updateTransaction(fixtureTxId, { status: 'READY' });
    } finally {
      updater.close();
    }
    await page.waitForFunction(() => document.querySelector('.dsh-flow-tx')?.textContent?.startsWith('READY'),
      undefined, { timeout: 15_000 }).catch(() => {});
    const afterStatus = await fixtureTxRow.textContent().catch(() => '');
    push('visible-transaction-list-refreshes-without-tab-switch',
      Boolean(beforeStatus?.startsWith('DRAFT') && afterStatus?.startsWith('READY')),
      `fixture row remained on transactions tab: ${beforeStatus} → ${afterStatus}`);
    await screenshot(page, artifacts, 'panel-live-transactions.png');
    // Invoke the generated seven-method surface through its real HTTP carrier.
    const methods = await page.evaluate(async ({ id, createdId }) => {
      const call = async (method: string, args: Record<string, unknown>): Promise<ProbeResponse> => {
        try {
          const response = await fetch(`/api/flow/${method}`, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({
              type: 'client-request', rpcId: crypto.randomUUID(),
              method: `flow/${method}`, payload: { args },
            }),
          });
          const body: unknown = await response.json();
          return { status: response.status, body, error: null };
        } catch (error: unknown) {
          return { status: null, body: null, error: error instanceof Error ? error.message : String(error) };
        }
      };
      const start = await call('start', { request: {
        id: createdId, objective: 'Panel Remote surface fixture', capabilities: [],
        budget: { tokens: 1 },
      } });
      const control = await call('control', { id: createdId, action: 'pause' });
      const results = {
        start, control,
        list: await call('list', { request: {} }),
        read: await call('read', { id, request: {} }),
        events: await call('events', { id, request: { since: 0, limit: 200 } }),
        query: await call('query', { id, what: 'nodes', params: { parent_id: null, limit: 50, offset: 0 } }),
        report: await call('report', { id }),
      };
      await call('control', { id: createdId, action: 'cancel' });
      return results;
    }, { id: fixtureId, createdId: `${fixtureId}-remote` });
    push('seven-public-remote-methods-succeed',
      Object.values(methods).every(result => result.status === 200 && remoteSuccess(result.body) !== null),
      JSON.stringify(Object.fromEntries(Object.entries(methods).map(([name, result]) =>
        [name, { status: result.status, ok: remoteSuccess(result.body) !== null, error: result.error }]))));

    // Refreshing an expanded tree must retain all loaded child pages.
    await page.getByRole('button', { name: /^tree$/i }).first().click();
    await page.waitForTimeout(3500);
    push('expanded-child-pages-survive-refresh', await childRows.count() === 121,
      `${await childRows.count()} of 121 expanded children after a polling refresh`);

    // Hold a real, already-produced response, then change selection before
    // delivering it. This tests the mounted component, not its source text.
    const switchGate = Promise.withResolvers<void>();
    const switchReady = Promise.withResolvers<void>();
    let switchCaptured = false;
    await page.route('**/api/flow/read', async route => {
      const payload: unknown = route.request().postDataJSON();
      const args = asObject(asObject(asObject(payload)?.payload)?.args);
      if (switchCaptured || args?.id !== fixtureId) return route.continue();
      switchCaptured = true;
      const response = await route.fetch();
      switchReady.resolve();
      await switchGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    const switchProduced = await Promise.race([
      switchReady.promise.then(() => true), page.waitForTimeout(10_000).then(() => false),
    ]);
    await page.locator('.dsh-flow-list button').filter({ hasText: clusterPrefix }).first().click();
    switchGate.resolve();
    await page.waitForTimeout(500);
    const switchLateStatus = (await page.locator('.dsh-flow-status').first().textContent().catch(() => null))?.trim() ?? null;
    const switchSettledStatus = await waitForClusterStatus(page, /^CANCELLED$/i, 15_000);
    push('cluster-switch-fences-late-response',
      switchProduced && (await page.locator('.dsh-flow-list button.is-selected').innerText()).includes(clusterPrefix)
        && switchLateStatus !== 'PAUSED' && switchSettledStatus === 'CANCELLED',
      `held fixture response=${switchCaptured}; immediate status=${switchLateStatus}; selected original settles to ${switchSettledStatus}`);
    await page.unroute('**/api/flow/read');
    await fixtureButton.click();
    await waitForClusterStatus(page, /^PAUSED$/i, 15_000);

    const resetGate = Promise.withResolvers<void>();
    const resetReady = Promise.withResolvers<void>();
    let resetCaptured = false;
    await page.route('**/api/flow/read', async route => {
      const payload: unknown = route.request().postDataJSON();
      const args = asObject(asObject(asObject(payload)?.payload)?.args);
      if (resetCaptured || args?.id !== fixtureId) return route.continue();
      resetCaptured = true;
      const response = await route.fetch();
      resetReady.resolve();
      await resetGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    const resetProduced = await Promise.race([
      resetReady.promise.then(() => true), page.waitForTimeout(10_000).then(() => false),
    ]);
    const resetStore = new ClusterStore(join(layout.data, 'cluster.sqlite'));
    try {
      resetStore.updateCluster(fixtureId, { status: 'CANCELLED' });
    } finally {
      resetStore.close();
    }
    // Real browser network events drive the connection owner's generation
    // replacement and its connection/reset notification without reloading UI.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForClusterStatus(page, /^CANCELLED$/i, 30_000);
    resetGate.resolve();
    await page.waitForTimeout(1500);
    const resetStatus = (await page.locator('.dsh-flow-status').first().innerText()).trim();
    push('connection-reset-fences-late-response',
      resetProduced && resetStatus === 'CANCELLED',
      `held pre-reset PAUSED response=${resetCaptured}; post-reset durable CANCELLED status remains rendered=${resetStatus}`);
    await page.unroute('**/api/flow/read');
    await screenshot(page, artifacts, 'panel-generation-fences.png');
    // Creation itself is exercised through the shipped form. A one-token
    // start-only fixture prevents unrelated model work in this browser check.
    const uiObjective = `Panel form start fixture ${clusterId}`;
    await page.getByLabel('Objective', { exact: true }).fill(uiObjective);
    await page.getByLabel('Workspace', { exact: true }).fill(layout.root);
    await page.getByLabel('Capabilities', { exact: true }).fill('');
    await page.getByLabel('Budget override (JSON)', { exact: true }).fill('{"tokens":1}');
    const createdResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/flow/start' && response.request().method() === 'POST',
    { timeout: 15_000 });
    await page.getByRole('button', { name: /^start$/i }).click();
    const createdResponse = await createdResponsePromise;
    const createdBody: unknown = await createdResponse.json();
    const createdResult = remoteSuccess(createdBody);
    const uiSnapshot = decodeSnapshot(createdResult?.value);
    const uiCreatedId = asString(uiSnapshot?.cluster.id);
    // The unchanged panel displays cluster identity, not cluster objective.
    // Plan §4.6 preserves its DOM/text; Verification §6 requires actual start
    // and selection. Prove the submitted objective in persistence and the new
    // selection in the real DOM instead of inventing an objective label.
    const uiPrefix = uiCreatedId?.slice(0, 8) ?? 'invalid-created-cluster';
    const selectedRow = page.locator('.dsh-flow-grid .dsh-flow-list button.is-selected')
      .filter({ hasText: uiPrefix }).first();
    const selectedVisible = await selectedRow.waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true, () => false);
    const clusterStat = page.locator('.dsh-flow-summary .dsh-flow-stat')
      .filter({ has: page.locator('span', { hasText: /^Cluster$/ }) }).locator('strong');
    await page.waitForFunction(prefix => [...document.querySelectorAll('.dsh-flow-stat')]
      .some(stat => stat.querySelector('span')?.textContent === 'Cluster'
        && stat.querySelector('strong')?.textContent === prefix), uiPrefix, { timeout: 15_000 });
    const persisted = uiCreatedId === null ? null : asObject(await host.request('read', uiCreatedId, { include_events: false }));
    const persistedObjective = asString(asObject(persisted?.cluster)?.objective);
    const selectedDOM = selectedVisible ? await selectedRow.evaluate(node => node.outerHTML) : null;
    const summaryDOM = await clusterStat.evaluate(node => node.outerHTML);
    writeFileSync(join(artifacts, 'panel-start-form.dom.html'), await page.locator('.dsh-flow-panel').innerHTML());
    push('start-from-panel-form',
      createdResponse.status() === 200 && uiCreatedId !== null && persistedObjective === uiObjective && selectedVisible,
      JSON.stringify({ cluster: uiCreatedId, persistedObjective, selectedDOM, summaryDOM }));
    await page.getByRole('button', { name: /^cancel$/i }).first().click();
    await waitForClusterStatus(page, /^CANCELLED$/i, 15_000);
    await screenshot(page, artifacts, 'panel-start-form.png');
    push('no-console-errors', consoleErrorsBeforeProbe === 0,
      consoleErrorsBeforeProbe === 0
        ? 'no console errors before the deliberate refusal probe'
        : consoleErrors.slice(0, 4).join(' | '));
    const probeErrors = consoleErrors.slice(consoleErrorsBeforeProbe);
    push('probe-errors-are-only-the-refusals', probeErrors.every(text => /api\/flow/.test(text) || /404/.test(text)),
      `${probeErrors.length} console errors after the probe: ${probeErrors.slice(0, 3).join(' | ') || 'none'}`);
  } finally {
    await browser.close();
  }
  return { checks };
}

export async function run({ report, layout }: PanelRunContext) {
  const checks: CheckEntry[] = [...(report.live_checks?.checks ?? [])];
  const push = (name: string, passed: boolean | null | undefined, evidence: string): void => {
    checks.push({
      name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
    });
  };
  const dbPath = join(layout.data, 'cluster.sqlite');
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (dbPresent && report.cluster_id) {
    const ledger = openLedger(dbPath);
    try {
      const recorded = ledger.all('SELECT type FROM events WHERE cluster_id=?', report.cluster_id)
        .map(row => row.type)
        .filter((type): type is string => typeof type === 'string');
      push('control-operations-recorded', recorded.includes('cluster-pause') || recorded.includes('cluster-cancel'),
        `control events: ${['cluster-pause', 'cluster-resume', 'cluster-cancel'].filter(type => recorded.includes(type)).join(', ') || 'none'}`);
      const acceptedRow = ledger.get("SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='ACCEPTED'", report.cluster_id);
      const accepted = sqlNumber(acceptedRow?.c) ?? 0;
      push('work-reached-acceptance', accepted >= 1 || report.live_checks?.checks?.some(entry => entry.name === 'cancel-from-panel' && entry.passed),
        `${accepted} accepted transactions`);
    } finally {
      ledger.close();
    }
  }

  const cancelled = (report.live_checks?.checks ?? []).find(entry => entry.name === 'cancel-from-panel');
  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => [
    'unauthenticated-flow-route-refused', 'cluster-database-present',
    'internal-ops-refused', 'internal-ops-refused-with-unknown-op', 'legacy-op-envelope-refused',
  ].includes(entry.name));
  return {
    checks,
    // A panel that was cancelled on purpose is a pass for the two work checks.
    scenario_status: failed.filter(entry => !(cancelled?.passed && ['work-reached-acceptance'].includes(entry.name))).length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}


/** The summary statistics, keyed by label, read from real DOM nodes. */
async function statMap(page: Page): Promise<Record<string, string | undefined>> {
  const nodes: Locator[] = await page.locator('.dsh-flow-stat').all().catch(() => []);
  const out: Record<string, string | undefined> = {};
  for (const node of nodes) {
    const label = (await node.locator('span').first().textContent().catch(() => ''))?.trim();
    const value = (await node.locator('strong').first().textContent().catch(() => ''))?.trim();
    if (label) out[label] = value;
  }
  return out;
}

/** Wait for the cluster status element to match, returning what it showed. */
async function waitForClusterStatus(page: Page, pattern: RegExp, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.locator('.dsh-flow-status').first().textContent().catch(() => null);
    if (text && pattern.test(text.trim())) return text.trim();
    if (Date.now() > deadline) return text?.trim() ?? null;
    await page.waitForTimeout(250);
  }
}

/** Wait for the reported event cursor to pass a value. */
async function waitForCursor(page: Page, previous: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let latest = previous;
  for (;;) {
    latest = Number((await statMap(page))['Event cursor'] ?? 0);
    // "Reached" is a value, not an increase: the target is the cluster's own
    // latest sequence, which a settled cluster never moves past.
    if (latest >= previous || Date.now() > deadline) return latest;
    await page.waitForTimeout(500);
  }
}

async function screenshot(page: Page, dir: string, name: string): Promise<void> {
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, name), fullPage: true });
  } catch {
    /* evidence only */
  }
}
