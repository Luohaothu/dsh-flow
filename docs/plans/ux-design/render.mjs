/** Re-render the reviewable design fixtures; uses the workspace's Playwright. */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const dir = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await mkdir(join(dir, 'screens'), { recursive: true });
await page.goto(pathToFileURL(join(dir, 'index.html')).href);
const screens = await page.evaluate(() => window.DESIGN_SCREENS);
const result = [];
for (const [id, title] of screens) {
  await page.evaluate(id => { selected = 'search'; navigate(id, true); }, id);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.app').screenshot({ path: join(dir, 'screens', id + '.png'), animations: 'disabled' });
  const bounds = await page.locator('.app').boundingBox();
  result.push({ id, title, width: bounds.width, height: bounds.height });
}
// Additional reference states are linked in the spec next to their primary view.
await page.evaluate(() => { selected = 'search'; navigate('13-mobile', true); mobileDetail('search', 'info'); });
await page.locator('.app').screenshot({ path: join(dir, 'screens', '13-mobile-detail.png') });
await page.evaluate(() => { selected = 'search'; navigate('05-topology', true); theme = 'light'; render(); });
await page.locator('.app').screenshot({ path: join(dir, 'screens', '05-topology-light.png') });
await browser.close();
const report = { generatedFrom: ['index.html', 'styles.css', 'app.js'], screens: result, browserErrors: errors };
await writeFile(join(dir, 'screens', 'render-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
