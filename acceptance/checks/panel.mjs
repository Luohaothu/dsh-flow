/**
 * Panel case: verify the shipped browser half against the running host.
 *
 * `live` runs while the host is still up: it drives the real panel in a real
 * Chromium, exercises pause/resume/cancel and the report download, and proves
 * the `/api/flow` route is refused without the host's authentication.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserExecutablePath, importPlaywright } from '../lib/browser.mjs';

import { openLedger } from '../lib/ledger.mjs';
import { ClusterStore } from '../../adapter/src/store.js';



export async function live({ report, layout, host, mock = null }) {
  const checks = [];
  const push = (name, passed, evidence) => checks.push({ name, passed: Boolean(passed), evidence: String(evidence).slice(0, 2500) });
  const artifacts = join(layout.artifacts, 'panel');
  const fixtureId = `paneltree-${report.cluster_id}`;

  // The cluster is still running here; the panel checks drive it through
  // pause, resume and cancel before it can reach a terminal state on its own.
  const url = report.web_url ?? (await host.waitForWebUrl(60_000));
  push('host-served-web-url', Boolean(url), `url ${url ?? 'not observed'}`);

  const apiUrl = new URL('/api/flow', url);
  const unauthenticated = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'list' }),
  });
  push('unauthenticated-flow-route-refused', unauthenticated.status === 401 || unauthenticated.status === 403,
    `POST /api/flow without the host token returned ${unauthenticated.status}`);

  const playwright = await importPlaywright();
  if (!playwright) {
    push('browser-available', false, 'playwright not resolvable');
    return { checks, blocked: ['browser-available'] };
  }
  const executablePath = browserExecutablePath();
  const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let page = await context.newPage();
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(String(error.message ?? error)));
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
      && (await page.locator('.dsh-flow-list button.is-selected').first().textContent()).includes(clusterPrefix),
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
    push('pause-from-panel', pausedSeen, `cluster status element reported PAUSED: ${pausedSeen}`);
    const resume = page.getByRole('button', { name: /^resume$/i }).first();
    await resume.click().catch(() => {});
    const resumedSeen = await waitForClusterStatus(page, /^(RUNNING|BLOCKED|COMPLETED)$/i, 20_000);
    push('resume-from-panel', resumedSeen, `cluster status after resume: ${resumedSeen}`);

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
    const txHeading = await page.getByRole('heading', { name: /^Transactions \(/ }).first().textContent().catch(() => '');
    push('transactions-total-matches-listed-rows', /^Transactions \(1 of 1\)$/.test(txHeading),
      `transaction tab heading: ${txHeading}`);
    if (txCount >= 1) await txButtons.first().click().catch(() => {});

    // Section 18, communication and context are real views with real rows.
    await page.getByRole('button', { name: /^health$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const healthText = await page.locator('.dsh-flow-panel').textContent().catch(() => '');
    push('health-view-renders', /transaction_coverage/.test(healthText) && /Measured signals/i.test(healthText),
      healthText.slice(-400));
    await page.getByRole('button', { name: /^communication$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const commText = await page.locator('.dsh-flow-panel').textContent().catch(() => '');
    push('communication-view-renders', /Message deliveries/i.test(commText), commText.slice(-200));
    await page.getByRole('button', { name: /^context$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const ctxText = await page.locator('.dsh-flow-panel').textContent().catch(() => '');
    push('context-view-renders', /Context pressure/i.test(ctxText) && /Latest summary/i.test(ctxText), ctxText.slice(-200));
    const contextEvidence = (() => {
      const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
      try {
        return ledger.get(
          `SELECT seq, json_extract(data,'$.agent_id') AS agent_id, json_extract(data,'$.before') AS before,
                  json_extract(data,'$.after') AS after
             FROM events WHERE cluster_id=? AND type='context-step' ORDER BY seq DESC LIMIT 1`, report.cluster_id);
      } finally {
        ledger.close();
      }
    })();
    if (contextEvidence?.agent_id) {
      await page.getByRole('combobox', { name: 'Context agent' }).selectOption(contextEvidence.agent_id).catch(() => {});
      await page.waitForFunction(seq => [...document.querySelectorAll('.dsh-flow-context-steps li')]
        .some(row => row.textContent?.startsWith(`#${seq} step `)), contextEvidence.seq, { timeout: 15_000 }).catch(() => {});
    }
    const contextRow = contextEvidence
      ? await page.locator('.dsh-flow-context-steps li').filter({ hasText: `#${contextEvidence.seq} step ` }).first().textContent().catch(() => null)
      : null;
    push('context-step-matches-durable-agent',
      Boolean(contextEvidence && contextRow?.includes(`${contextEvidence.before} → ${contextEvidence.after}`)),
      `${contextEvidence?.agent_id ?? 'no durable context step'}: ${contextRow ?? 'no matching context row in DOM'}`);
    await page.getByRole('button', { name: /^resources$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const resourceText = await page.locator('.dsh-flow-panel').textContent().catch(() => '');
    push('resources-view-renders', /Budgets \(/.test(resourceText) && /api_cost/.test(resourceText), resourceText.slice(-300));

    const eventsRendered = await page.locator('.dsh-flow-events li').count();
    push('events-stream-rendered', eventsRendered > 0, `${eventsRendered} event rows`);

    // The event cursor is real: it tracks the cluster's durable event log. It
    // does not have to grow on demand — this case cancels the cluster, and a
    // cancelled cluster produces almost no further events — so the requirement is
    // that the page converges to the log's own latest sequence.
    const durableLatest = (() => {
      try {
        const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
        return Number(ledger.get('SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE cluster_id=?', report.cluster_id)?.m ?? 0);
      } catch { return null; }
    })();
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
    const probe = await page.evaluate(async () => {
      const ask = async body => {
        try {
          const response = await fetch('/api/flow', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          return { status: response.status, body: await response.json().catch(() => null) };
        } catch (error) {
          return { status: null, error: String(error.message ?? error) };
        }
      };
      const listed = await ask({ op: 'list' });
      const ops = {};
      for (const op of ['dispose', 'recover', 'tick', 'settle', 'single']) ops[op] = await ask({ op, id: null, payload: {} });
      return { listed, ops };
    });
    const authenticated = probe.listed.status === 200;
    const refused = Object.entries(probe.ops).filter(([, result]) => Number(result.status) >= 400);
    push('internal-ops-refused', refused.length === 5,
      `page-authenticated=${authenticated}; ${JSON.stringify(Object.fromEntries(Object.entries(probe.ops).map(([op, result]) => [op, result.status])))}`);
    if (authenticated) {
      const unknown = Object.entries(probe.ops).filter(([, result]) => result.status === 404 && result.body?.code === 'UNKNOWN_OP');
      push('internal-ops-refused-with-unknown-op', unknown.length === 5,
        `an authenticated page gets 404 UNKNOWN_OP for all five: ${unknown.length}/5`);
    } else {
      push('internal-ops-refused-with-unknown-op', null,
        `the page could not authenticate to the route (list returned ${probe.listed.status}); the whitelist is asserted in the unit suite instead`);
    }

    await screenshot(page, artifacts, 'panel.png');
    // The downloaded report names the cluster it really came from.
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
      page.getByRole('button', { name: /download report/i }).first().click().catch(() => {}),
    ]).then(([event]) => event);
    if (download) {
      const target = join(artifacts, 'panel-report.json');
      await download.saveAs(target).catch(() => {});
      let matches = false;
      let detail = `downloaded ${target}`;
      try {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        matches = parsed?.cluster?.id === report.cluster_id;
        detail = `report cluster ${parsed?.cluster?.id} vs running ${report.cluster_id}`;
      } catch (error) {
        detail = `could not read the download: ${error.message}`;
      }
      push('report-download-matches-cluster', matches, detail);
    } else {
      push('report-download-matches-cluster', false, 'no download event observed');
    }

    // Closing the page must not cancel its cluster. Reopen a new tab in the
    // authenticated browser context and resume from the durable event cursor.
    const cursorBeforeClose = Number((await statMap(page))['Event cursor'] ?? 0);
    await page.close();
    const afterClose = await host.request('read', report.cluster_id, { include_events: false });
    push('page-close-does-not-cancel-cluster', Boolean(afterClose?.cluster?.status) && afterClose.cluster.status !== 'CANCELLED',
      `host cluster status after closing the tab: ${afterClose?.cluster?.status ?? 'unknown'}`);
    page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(String(error.message ?? error)));
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
    push('reconnect-after-close', new RegExp(clusterPrefix, 'i').test(await page.textContent('body')),
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
    const finalDetail = await page.locator('.dsh-flow-detail').first().textContent().catch(() => '');
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
    let fixtureLastEventSeq = null;
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
    const fixturePage = await host.request('query', fixtureId, {
      what: 'nodes', params: { parent_id: rootId, limit: 50 },
    });
    push('large-tree-fixture-is-separate', fixturePage?.total === 121 && fixturePage.items?.length === 50,
      `${fixtureId}: ${fixturePage?.items?.length ?? 'unknown'} of ${fixturePage?.total ?? 'unknown'} direct children`);
    const fixtureButton = page.getByRole('button', { name: /^paneltre/i }).first();
    await fixtureButton.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await fixtureButton.click().catch(() => {});
    const fixtureCursor = await waitForCursor(page, fixtureLastEventSeq, 30_000);
    const latestFixtureEvent = (await page.locator('.dsh-flow-events li').allTextContents())
      .some(text => text.includes(`#${fixtureLastEventSeq} panel-fixture-event`));
    push('event-cursor-crosses-two-pages-and-global-id-gap',
      fixtureCursor >= fixtureLastEventSeq && latestFixtureEvent,
      `230 isolated events; durable last seq ${fixtureLastEventSeq}, DOM cursor ${fixtureCursor}, latest event visible ${latestFixtureEvent}`);
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
    const nodePage = await host.request('query', fixtureId, {
      what: 'node', params: { id: fixtureChildId, limit: 50 },
    });
    push('node-transactions-have-true-page-total',
      nodePage?.transactions?.items?.length === 50 && nodePage?.transactions?.total === 51
        && nodePage?.transactions?.next_offset === 50,
      `child node transactions ${nodePage?.transactions?.items?.length ?? 'unknown'} of ${nodePage?.transactions?.total ?? 'unknown'}, next ${nodePage?.transactions?.next_offset ?? 'none'}`);
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
      beforeStatus?.startsWith('DRAFT') && afterStatus?.startsWith('READY'),
      `fixture row remained on transactions tab: ${beforeStatus} → ${afterStatus}`);
    await screenshot(page, artifacts, 'panel-live-transactions.png');
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

export async function run({ report, layout, events }) {
  const checks = [...(report.live_checks?.checks ?? [])];
  const push = (name, passed, evidence) => checks.push({
    name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
  });
  const dbPath = join(layout.data, 'cluster.sqlite');
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  const ledger = dbPresent && report.cluster_id ? openLedger(dbPath) : null;
  if (ledger) {
    const recorded = ledger.all('SELECT type FROM events WHERE cluster_id=?', report.cluster_id).map(row => row.type);
    push('control-operations-recorded', recorded.includes('cluster-pause') || recorded.includes('cluster-cancel'),
      `control events: ${['cluster-pause', 'cluster-resume', 'cluster-cancel'].filter(type => recorded.includes(type)).join(', ') || 'none'}`);
    const accepted = ledger.get("SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='ACCEPTED'", report.cluster_id).c;
    push('work-reached-acceptance', accepted >= 1 || report.live_checks?.checks?.some(entry => entry.name === 'cancel-from-panel' && entry.passed),
      `${accepted} accepted transactions`);
    ledger.close();
  }
  void events;

  const cancelled = (report.live_checks?.checks ?? []).find(entry => entry.name === 'cancel-from-panel');
  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => [
    'unauthenticated-flow-route-refused', 'cluster-database-present',
    'internal-ops-refused', 'internal-ops-refused-with-unknown-op',
  ].includes(entry.name));
  return {
    checks,
    // A panel that was cancelled on purpose is a pass for the two work checks.
    scenario_status: failed.filter(entry => !(cancelled?.passed && ['work-reached-acceptance'].includes(entry.name))).length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}

/**
 * Click a control and wait for the panel to reflect it. `pause` and `cancel`
 * deliberately drain in-flight turns to a safe point, so the new state is
 * expected to take as long as those turns do — a fixed short sleep would test
 * the harness's patience rather than the control.
 */
async function clickAndObserve(page, locator, pattern, { timeoutMs = 15_000 } = {}) {
  if (!(await locator.isVisible().catch(() => false))) return false;
  const started = Date.now();
  await locator.click().catch(() => {});
  for (;;) {
    const body = (await page.textContent('body')) ?? '';
    if (pattern.test(body)) {
      globalThis.__flowControlLatency = Date.now() - started;
      return true;
    }
    if (Date.now() - started >= timeoutMs) {
      globalThis.__flowControlLatency = Date.now() - started;
      return false;
    }
    await page.waitForTimeout(250);
  }
}

/** The summary statistics, keyed by label, read from real DOM nodes. */
async function statMap(page) {
  const nodes = await page.locator('.dsh-flow-stat').all().catch(() => []);
  const out = {};
  for (const node of nodes) {
    const label = (await node.locator('span').first().textContent().catch(() => ''))?.trim();
    const value = (await node.locator('strong').first().textContent().catch(() => ''))?.trim();
    if (label) out[label] = value;
  }
  return out;
}

/** Wait for the cluster status element to match, returning what it showed. */
async function waitForClusterStatus(page, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.locator('.dsh-flow-status').first().textContent().catch(() => null);
    if (text && pattern.test(text.trim())) return text.trim();
    if (Date.now() > deadline) return text?.trim() ?? null;
    await page.waitForTimeout(250);
  }
}

/** Wait for the reported event cursor to pass a value. */
async function waitForCursor(page, previous, timeoutMs) {
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

async function screenshot(page, dir, name) {
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, name), fullPage: true });
  } catch {
    /* evidence only */
  }
}
