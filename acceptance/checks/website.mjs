/**
 * Website case checks: build the produced site, serve it, and drive a real
 * browser through the acceptance criteria. Located by accessible role/name
 * where possible, never by a selector we handed the model.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserExecutablePath, importPlaywright } from '../lib/browser.mjs';

const REFERENCE_CLOCK = '2026-09-26T12:00:00Z';


export async function run({ workspace, report, snapshot, events, layout }) {
  const checks = [];
  const artifacts = join(layout.artifacts, 'website');
  const push = (name, passed, evidence) => checks.push({ name, passed: Boolean(passed), evidence: String(evidence).slice(0, 3000) });

  const build = spawnSync('npm', ['run', 'build'], { cwd: workspace, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000 });
  writeFileSync(join(layout.root, 'build.log'), `${build.stdout ?? ''}\n${build.stderr ?? ''}`);
  push('build-succeeds', build.status === 0, `exit ${build.status}: ${(build.stderr ?? '').slice(-1500)}`);

  if (build.status !== 0) {
    return { checks, scenario_status: 'FAILED', failure_class: 'MODEL_OUTPUT' };
  }

  const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', chunk => { serverOut += chunk; });
  server.stderr.on('data', chunk => { serverOut += chunk; });

  try {
    const url = await waitForUrl(() => /(http:\/\/127\.0\.0\.1:\d+\/?\S*)/u.exec(serverOut)?.[1], 60_000);
    push('dev-server-starts', Boolean(url), `url: ${url ?? 'not observed'} :: ${serverOut.slice(-800)}`);
    if (!url) return { checks, scenario_status: 'FAILED', failure_class: 'MODEL_OUTPUT' };

    const playwright = await importPlaywright();
    if (!playwright) {
      push('browser-automation-available', false, 'playwright is not resolvable from the project');
      return { checks, scenario_status: 'BLOCKED', failure_class: 'ENVIRONMENT' };
    }
    const executablePath = browserExecutablePath();
    const browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(String(error.message ?? error)));
    await page.clock.install({ time: REFERENCE_CLOCK });
    // The app holds an open event stream, so `networkidle` never settles.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const events = JSON.parse(readFileSync(join(workspace, 'src/events.json'), 'utf8'));
    const futureEvents = events.filter(entry => new Date(entry.start).getTime() > Date.parse(REFERENCE_CLOCK));
    const pastEvents = events.filter(entry => new Date(entry.start).getTime() <= Date.parse(REFERENCE_CLOCK));
    const fullFuture = futureEvents.filter(entry => entry.registered >= entry.capacity);

    const titles = entries => entries.map(entry => entry.title.en).concat(entries.map(entry => entry.title.zh));
    const visibleTitleCount = async () => {
      const body = (await page.textContent('body')) ?? '';
      return titles(futureEvents).filter(title => body.includes(title)).length;
    };

    await screenshot(page, artifacts, 'list-1440.png');
    push('list-renders-events', (await visibleTitleCount()) > 0, `${await visibleTitleCount()} future event titles visible`);

    // Category filter
    const category = futureEvents[0]?.category;
    const beforeFilter = await visibleTitleCount();
    const categoryApplied = await applyFilter(page, category);
    const afterFilter = await visibleTitleCount();
    push('category-filter-changes-list', categoryApplied && afterFilter < beforeFilter && afterFilter > 0,
      `category ${category}: ${beforeFilter} → ${afterFilter} visible titles`);
    await clearFilters(page);

    // Date filter
    const dateApplied = await applyFilter(page, 'date');
    const afterDate = await visibleTitleCount();
    push('date-filter-usable', dateApplied !== false, `date control found: ${dateApplied}, visible titles ${afterDate}`);
    await clearFilters(page);

    // Past event cannot be registered
    const past = pastEvents[0];
    const pastResult = await tryRegister(page, past, { name: 'Test User', email: 'past@example.test' });
    push('past-event-not-registrable', pastResult.registered === false,
      `past event ${past.id}: ${JSON.stringify(pastResult).slice(0, 600)}`);

    // Invalid email is rejected and writes nothing
    const invalid = await tryRegister(page, futureEvents[0], { name: 'Test User', email: 'not-an-email' });
    const afterInvalid = await readRegistrations(page);
    push('invalid-email-rejected', invalid.registered === false && invalid.validationShown === true && afterInvalid.length === 0,
      `validation: ${JSON.stringify(invalid).slice(0, 600)}; stored: ${JSON.stringify(afterInvalid).slice(0, 200)}`);

    // Full event refuses registration
    if (fullFuture.length) {
      const full = await tryRegister(page, fullFuture[0], { name: 'Test User', email: 'full@example.test' });
      push('full-event-rejected', full.registered === false, `full event ${fullFuture[0].id}: ${JSON.stringify(full).slice(0, 600)}`);
    } else {
      push('full-event-rejected', false, 'the seed has no full future event; cannot exercise the rule');
    }

    // Valid registration appears, survives a reload, and can be cancelled
    const target = futureEvents.find(entry => entry.registered < entry.capacity);
    const valid = await tryRegister(page, target, { name: 'Ada Lovelace', email: 'ada@example.test' });
    const stored = await readRegistrations(page);
    push('valid-registration-recorded', valid.registered === true && stored.length >= 1, `${JSON.stringify(valid).slice(0, 400)}; stored ${stored.length}`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    const afterReload = await readRegistrations(page);
    push('registration-survives-reload', afterReload.length >= 1, `after reload: ${afterReload.length} entries`);
    await screenshot(page, artifacts, 'my-registrations.png');
    const cancelled = await cancelRegistration(page);
    const afterCancel = await readRegistrations(page);
    push('registration-cancellable', cancelled && afterCancel.length < afterReload.length, `cancel=${cancelled}, entries ${afterReload.length} → ${afterCancel.length}`);

    // Language switch
    const switched = await switchLanguage(page);
    push('language-switch', switched, `language control toggled: ${switched}`);
    await screenshot(page, artifacts, 'language-switched.png');

    // Responsive
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      push(`no-horizontal-overflow-${width}`, overflow.scrollWidth <= overflow.clientWidth + 2,
        `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`);
      await screenshot(page, artifacts, `viewport-${width}.png`);
    }

    push('no-console-errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | ') || 'none');
    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  // `null` is "not measured": it is not a failure, and it must not make the case
  // look failed either.
  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => ['build-succeeds', 'dev-server-starts'].includes(entry.name));
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}



function waitForUrl(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolvePromise => {
    const tick = () => {
      const url = read();
      if (url) return resolvePromise(url);
      if (Date.now() > deadline) return resolvePromise(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function screenshot(page, dir, name) {
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, name), fullPage: true });
  } catch {
    /* screenshots are evidence, not a gate */
  }
}

async function clickText(page, pattern) {
  const handles = await page.locator('button, a, [role="button"], [role="tab"], label').all();
  for (const handle of handles) {
    const text = ((await handle.textContent()) ?? '').trim();
    if (pattern.test(text) && await handle.isVisible().catch(() => false)) {
      await handle.click({ timeout: 3000 }).catch(() => {});
      return text;
    }
  }
  return null;
}

async function applyFilter(page, token) {
  if (!token) return false;
  const selects = await page.locator('select').all();
  for (const select of selects) {
    const options = await select.locator('option').allTextContents();
    if (options.some(option => option.toLowerCase().includes(String(token).toLowerCase()))) {
      await select.selectOption({ label: options.find(option => option.toLowerCase().includes(String(token).toLowerCase())) });
      await page.waitForTimeout(200);
      return true;
    }
    if (options.length > 1 && String(token).includes('2026')) {
      await select.selectOption({ index: 1 });
      await page.waitForTimeout(200);
      return true;
    }
  }
  const dates = await page.locator('input[type="date"]').all();
  if (dates.length) {
    await dates[0].fill('2026-10-15');
    await page.waitForTimeout(200);
    return true;
  }
  const buttons = await page.locator('button, [role="button"], [role="tab"]').all();
  for (const button of buttons) {
    const text = ((await button.textContent()) ?? '').trim();
    if (text && (text.toLowerCase() === String(token).toLowerCase() || text.toLowerCase().includes(String(token).toLowerCase()))) {
      await button.click().catch(() => {});
      await page.waitForTimeout(200);
      return true;
    }
  }
  return false;
}

async function clearFilters(page) {
  const reset = await clickText(page, /^(all|全部|reset|清除|clear)$/i);
  if (!reset) {
    const selects = await page.locator('select').all();
    for (const select of selects) await select.selectOption({ index: 0 }).catch(() => {});
  }
  await page.waitForTimeout(200);
}

async function openEvent(page, event) {
  const title = event.title.en;
  const localized = event.title.zh;
  const links = await page.locator('button, a, [role="button"], li, article, h2, h3').all();
  for (const link of links) {
    const text = ((await link.textContent()) ?? '').trim();
    if ((text.includes(title) || text.includes(localized)) && await link.isVisible().catch(() => false)) {
      await link.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      return true;
    }
  }
  return false;
}

async function fillForm(page, { name, email }) {
  const inputs = await page.locator('input').all();
  let filledName = false;
  let filledEmail = false;
  for (const input of inputs) {
    const type = (await input.getAttribute('type')) ?? 'text';
    const descriptor = `${await input.getAttribute('name') ?? ''} ${await input.getAttribute('placeholder') ?? ''} ${await input.getAttribute('aria-label') ?? ''} ${await input.getAttribute('id') ?? ''}`.toLowerCase();
    if (type === 'email' || /mail|邮箱/.test(descriptor)) {
      await input.fill(email);
      filledEmail = true;
    } else if (!filledName && (type === 'text' || type === 'search') && !/date/.test(descriptor)) {
      await input.fill(name);
      filledName = true;
    }
  }
  return { filledName, filledEmail };
}

async function tryRegister(page, event, person) {
  if (!event) return { registered: false, reason: 'no candidate event' };
  const opened = await openEvent(page, event);
  if (!opened) return { registered: false, reason: `could not open event ${event.id}` };
  const filled = await fillForm(page, person);
  const clicked = await clickText(page, /(register|sign ?up|submit|报名|确认|提交)/i);
  await page.waitForTimeout(500);
  const body = (await page.textContent('body')) ?? '';
  const stored = await readRegistrations(page);
  const validationShown = /(invalid|required|错误|无效|请输入|格式)/i.test(body);
  return { registered: stored.some(entry => entry.includes(event.title.en) || entry.includes(event.title.zh)) || (Boolean(clicked) && stored.length > 0), filled, clicked, validationShown, reason: 'ok' };
}

async function readRegistrations(page) {
  const raw = await page.evaluate(() => {
    const out = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      out[key] = localStorage.getItem(key);
    }
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      out[`session:${key}`] = sessionStorage.getItem(key);
    }
    return out;
  });
  const merged = Object.entries(raw)
    .filter(([key]) => /regist|signup|booking|报名/i.test(key))
    .map(([, value]) => value ?? '')
    .join('\n');
  const parsed = [];
  for (const match of merged.matchAll(/\{[^{}]*\}/g)) parsed.push(match[0]);
  if (parsed.length) return parsed;
  return merged ? [merged.slice(0, 2000)] : [];
}

async function cancelRegistration(page) {
  const opened = await clickText(page, /(my registrations|我的报名|registrations)/i);
  await page.waitForTimeout(300);
  const clicked = await clickText(page, /(cancel|withdraw|取消|退订)/i);
  await page.waitForTimeout(400);
  return Boolean(clicked) || Boolean(opened);
}

async function switchLanguage(page) {
  const clicked = await clickText(page, /^(zh|cn|中文|english|en)$/i);
  await page.waitForTimeout(400);
  const body = (await page.textContent('body')) ?? '';
  return Boolean(clicked) && /[\u4e00-\u9fa5]/.test(body);
}
