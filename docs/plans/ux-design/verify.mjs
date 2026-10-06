/** Checks design artifacts and supported preview interactions, not production acceptance. */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const dir = dirname(fileURLToPath(import.meta.url));
const checks = [];
const record = (name, detail) => checks.push({ name, result: 'pass', detail });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(pathToFileURL(join(dir, 'index.html')).href);
const scene = async (id) => page.evaluate(id => { selected = 'search'; navigate(id, true); }, id);
const spec = await readFile(join(dir, '..', 'ux-design.md'), 'utf8');
const figurePaths = [...spec.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
for (const file of figurePaths) assert((await stat(resolve(dir, '..', file))).size > 0);
assert.equal(figurePaths.length, 16);
assert(!/\]\(image(?:-\d+)?\.png\)/.test(spec));
record('Spec figure references', '16 generated figures exist; all six original screenshot references replaced.');

await page.getByRole('button', { name: '设置', exact: false }).last().click();
assert.equal(await page.locator('.settings-head h1').textContent(), 'dsh-flow');
assert.equal(await page.locator('[data-action="save-settings"]').isDisabled(), true);
await page.locator('[data-pref="view"]').selectOption('list');
assert.equal(await page.locator('[data-action="save-settings"]').isEnabled(), true);
await page.locator('.breadcrumb').click();
assert.equal(await page.getByRole('dialog').count(), 1);
assert.equal(await page.getByRole('button', { name: '保存并离开', exact: true }).count(), 1);
await page.getByRole('button', { name: '继续编辑', exact: true }).click();
await page.locator('[data-action="cancel-settings"]').click();
assert.equal(await page.locator('[data-pref="view"]').inputValue(), 'graph');
assert.equal(await page.locator('input[type="number"]').count(), 0);
record('Settings draft, leave and cancel', 'Saved state disables save; edits enable it; three-way leave; cancel restores values; no budget inputs.');

await scene('03-start');
await page.locator('.composer-field').fill('/agent-team');
await page.locator('.send-btn').click();
assert.equal(await page.locator('.start-page').count(), 1);
await page.locator('.composer-field').fill('/agent-team 为知识库增加全文检索');
await page.locator('.send-btn').click();
assert.equal(await page.locator('#team-button').count(), 1);
assert.equal(await page.locator('.tabs .tab').count(), 3);
record('Command and unique entry', 'Empty requirement remains in composer; valid sample navigates to one team button and three tabs.');

await page.locator('#team-button').click();
await page.locator('#team-button').focus();
await page.keyboard.press('Enter');
assert.equal(await page.locator('.tree-popover').count(), 1);
assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tree-item')), true);
await page.keyboard.press('ArrowDown');
assert.equal(await page.evaluate(() => document.activeElement.dataset.agentSession), 'research');
await page.keyboard.press('Escape');
assert.equal(await page.locator('.tree-popover').count(), 0);
assert.equal(await page.evaluate(() => document.activeElement.id), 'team-button');
record('Team popover keyboard', 'Enter opens with row focus; ArrowDown moves; Escape closes and returns focus.');

await scene('05-topology');
await page.locator('[data-node="search"]').click();
assert.equal(await page.locator('.detail-name').textContent(), '检索实现');
assert.equal(await page.locator('.dock-head h3').textContent(), '检索实现');
assert.equal(await page.locator('textarea').count(), 0);
assert((await page.locator('.inspector').textContent()).includes('120,000'));
await page.locator('[data-action="full-session"]').click();
assert.equal(await page.locator('.full-session-foot').count(), 1);
assert.equal(await page.locator('textarea').count(), 0);
await page.locator('.root-back').click();
assert.equal(await page.locator('.detail-name').textContent(), '检索实现');
record('Node and full conversation', 'Node opens matching read-only panels; full conversation has no composer; return restores selected agent.');

await scene('09-waiting');
assert.equal(await page.locator('.detail-name').textContent(), '界面实现');
assert(!(await page.locator('.inspector').textContent()).includes('派生质量验证'));
assert(!(await page.locator('.inspector').textContent()).includes('120,000'));
await page.locator('.info-strip [data-action="main-chat"]').click();
assert.equal(await page.locator('.composer-field').count(), 1);
assert.equal(await page.locator('.composer-field').inputValue(), '');
record('Waiting navigation and data isolation', 'UI agent has its own history and unknown budget; answer action navigates to an empty main composer.');

await scene('05-topology');
await page.locator('#agent-search').fill('qa');
assert.equal(await page.locator('.node[data-node="qa"]').evaluate(n => n.style.opacity), '1');
assert.equal(await page.locator('.node[data-node="search"]').evaluate(n => n.style.opacity), '1');
await page.locator('[data-action="list-mode"]').click();
assert.equal(await page.locator('.list-row').count(), 5);
record('Topology search and list', 'Search keeps the QA parent path; equivalent hierarchy list is available.');

await scene('08-communication');
assert((await page.locator('.comm-panel').textContent()).includes('检索实现的相关通信'));
assert.equal(await page.locator('.communication-item').count(), 2);
assert.equal(await page.locator('textarea').count(), 0);
record('Communication', 'Two incoming sample records are correctly scoped and read-only.');

await scene('12-compact');
assert.equal(await page.locator('.app').evaluate(n => n.clientWidth), 1078);
assert.equal(await page.locator('.inspector').isVisible(), false);
await page.locator('[data-action="compact-info"]').click();
assert.equal(await page.locator('.dock-content .detail-name').textContent(), '检索实现');
record('Compact layout', '1080 px artboard uses a single bottom dock with conversation/info switching.');

await scene('13-mobile');
await page.locator('[data-mobile-node="search"]').click();
assert.equal(await page.locator('.mobile-sheet').count(), 1);
await page.locator('[data-action="mobile-info"]').click();
assert.equal(await page.locator('.mobile-sheet .detail-name').textContent(), '检索实现');
assert.equal(await page.locator('textarea').count(), 0);
await page.locator('[data-action="close-mobile"]').click();
assert.equal(await page.locator('.mobile-sheet').count(), 0);
record('Mobile details', 'Node opens a full-page read-only detail with information tab and return to list.');

await page.setViewportSize({ width: 332, height: 960 });
await scene('13-mobile');
assert(await page.locator('.app').evaluate(n => n.scrollWidth <= n.clientWidth));
await page.setViewportSize({ width: 1500, height: 1100 });
await scene('05-topology');
await page.locator('#theme-toggle').click();
assert.equal(await page.locator('.app.light').count(), 1);
record('Small viewport and theme', 'Mobile frame has no horizontal overflow at 320 px content width; light theme applies semantic styles.');

assert.deepEqual(errors, []);
record('Browser JavaScript', 'No uncaught page errors during the checked navigation flows.');
await browser.close();
const report = { scope: 'Design artifact and supported preview checks; not production A01–A31 acceptance', checks, pageErrors: errors };
await writeFile(join(dir, 'screens', 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
