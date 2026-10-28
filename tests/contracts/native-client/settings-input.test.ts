import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Native settings preserve real keyboard drafts until restore, discard or successful save', { timeout: 30_000 }, async t => {
  const compiled = await build({ stdin: {
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: String.raw`
      import {createRoot} from 'react-dom/client';
      import {FlowSettings} from './packages/dsh-flow/src/native/settings.tsx';
      const base={rootRole:'Inherited root',defaults:{skills:['inherited-skill'],model:{provider:'fixture',id:'fixture-model'},params:{version:1,temperature:.25}},patternSources:['inherited-directory'],maxConcurrentAgents:4};
      let current={ns:'input-fixture',revision:1,base:structuredClone(base),user:{},value:structuredClone(base),schema:{},autoGenerate:false,applies:'live',secrets:[]};
      const listeners=new Set(),mutations=[];
      let snapshot={status:'ready',view:{namespaces:[current],writable:true,hasDocument:true},error:null};
      const mirror={getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},async ensure(){},acceptView(view){current=view;snapshot={...snapshot,view:{...snapshot.view,namespaces:[view]}};for(const listener of listeners)listener();}};
      const merge=(left,right)=>{const result=structuredClone(left);for(const[key,value]of Object.entries(right)){result[key]=value&&typeof value==='object'&&!Array.isArray(value)?merge(result[key]??{},value):structuredClone(value);}return result;};
      function apply(target,path,value,unset){let object=target;for(const key of path.slice(0,-1))object=object[key]??={};if(unset)delete object[path.at(-1)];else object[path.at(-1)]=structuredClone(value);}
      const ctx={configForms:{describe:()=>mirror},remote:{session:{async modelCatalog(){return{ok:true,value:{groups:[],failures:[]}};}},settings:{async describe(){return{ok:true,value:snapshot.view};},async mutate(ns,ops,revision){mutations.push(structuredClone({ns,ops,revision}));const user=structuredClone(current.user);for(const op of ops)apply(user,op.path,op.value,op.op==='unset');const value={...current,user,value:merge(base,user),revision:current.revision+1};return{ok:true,value};}},flowDashboard:{async connection(){return{ok:true,value:{configuration:{entryId:'input-fixture',effective:current.value,requested:current.value,restartRequired:[],application:{revision:current.revision,status:'applied'}}}};}}}};
      window.__settingsInput={read:()=>({current,mutations}),refresh(value){mirror.acceptView({...current,base:merge(base,value),value:merge(merge(base,value),current.user),revision:current.revision+1});}};
      createRoot(document.getElementById('root')).render(<FlowSettings ctx={ctx} entryId='input-fixture'/>);
    `,
  }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = compiled.outputFiles[0]!.text;
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); }
    else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>'); }
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: !process.env.P6_SETTINGS_HEADED, ...(process.env.CI ? {} : { channel: 'chrome' }) });
  t.after(() => browser.close());
  const page = await browser.newPage(), pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const open = async () => { await page.goto(`http://127.0.0.1:${address.port}`); await page.getByRole('textbox', { name: /^根职责/ }).waitFor(); };
  const field = (label: string) => page.getByLabel(new RegExp(`^${label}.*生效$`));
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const clear = async (label: string) => { const input = field(label); await input.click(); await input.press('ControlOrMeta+A'); await input.press('Backspace'); await settle(); return input; };
  const capture = async (name: string) => {
    const directory = process.env.P6_SETTINGS_EVIDENCE_DIR; if (!directory) return;
    await mkdir(directory, { recursive: true });
    const state = await page.evaluate(() => ({ fields: [...document.querySelectorAll('input,textarea')].map(input => ({ id: input.id, type: input.getAttribute('type'), inputMode: input.getAttribute('inputmode'), value: (input as HTMLInputElement).value, invalid: input.getAttribute('aria-invalid') })), actions: [...document.querySelectorAll('footer button')].map(button => ({ text: button.textContent, disabled: (button as HTMLButtonElement).disabled })), probe: (window as unknown as { __settingsInput: { read(): unknown } }).__settingsInput.read() }));
    await writeFile(join(directory, `${name}.json`), JSON.stringify(state, null, 2));
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  };

  await t.test('Enter preserves the newline so a second line is typed separately', async () => {
    await open(); const skills = await clear('技能'); await skills.pressSequentially('first'); await skills.press('Enter'); await settle(); await capture('lines-after-enter');
    assert.equal(await skills.inputValue(), 'first\n');
    await skills.pressSequentially('second'); assert.equal(await skills.inputValue(), 'first\nsecond');
    await skills.press('Enter'); await settle(); assert.equal(await skills.inputValue(), 'first\nsecond\n');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
    await settle(); assert.equal(await skills.inputValue(), 'first\nsecond');
    const mutations = await page.evaluate<Array<{ ops: unknown[] }>>('window.__settingsInput.read().mutations');
    assert.deepEqual(mutations.at(-1)?.ops, [{ op: 'set', path: ['defaults', 'skills'], value: ['first', 'second'] }]);
  });
  await t.test('clearing an inherited field stays empty and permits new keyboard text', async () => {
    await open(); const role = await clear('根职责'); await capture('clear-inherited'); assert.equal(await role.inputValue(), '');
    await role.pressSequentially('New role'); assert.equal(await role.inputValue(), 'New role');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click(); await settle(); assert.equal(await role.inputValue(), 'Inherited root');
  });
  await t.test('decimal partial input survives each key before parsing and saving its final value', async () => {
    await open(); const temperature = await clear('温度'); await temperature.pressSequentially('0.'); await settle(); await capture('decimal-partial'); assert.equal(await temperature.inputValue(), '0.');
    assert.equal(await temperature.getAttribute('type'), 'text'); assert.equal(await temperature.getAttribute('inputmode'), 'decimal');
    await temperature.pressSequentially('5'); assert.equal(await temperature.inputValue(), '0.5');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
    const mutations = await page.evaluate<Array<{ ops: unknown[] }>>('window.__settingsInput.read().mutations');
    assert.deepEqual(mutations.at(-1)?.ops, [{ op: 'set', path: ['defaults', 'params', 'temperature'], value: .5 }]);
  });
  await t.test('restore inheritance resets raw invalid input and clears validation before save', async () => {
    await open(); const temperature = await clear('温度'); await temperature.pressSequentially('1e'); await settle(); await capture('invalid-number');
    assert.equal(await temperature.inputValue(), '1e'); assert.equal(await temperature.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '温度恢复继承', exact: true }).click(); await settle();
    assert.equal(await temperature.inputValue(), '0.25'); assert.equal(await temperature.getAttribute('aria-invalid'), 'false');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
    const mutations = await page.evaluate<Array<{ ops: unknown[] }>>('window.__settingsInput.read().mutations');
    assert.deepEqual(mutations.at(-1)?.ops, [{ op: 'unset', path: ['defaults', 'params', 'temperature'] }]);
  });
  await t.test('unrelated edits and external refresh keep active raw text until discard', async () => {
    await open(); const skills = field('技能'); await skills.fill('first'); await skills.press('End'); await skills.press('Enter');
    const role = field('根职责'); await role.fill('Local role');
    await page.evaluate('window.__settingsInput.refresh({rootRole:"New inherited root"})'); await settle();
    assert.equal(await skills.inputValue(), 'first\n'); assert.equal(await role.inputValue(), 'Local role');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click(); await settle();
    assert.equal(await skills.inputValue(), 'inherited-skill'); assert.equal(await role.inputValue(), 'New inherited root');
  });
  await t.test('pasting invalid text without a parsed operation remains discardable after external refresh', async () => {
    await open(); const temperature = field('温度'); await temperature.fill('1e'); await settle(); await capture('invalid-only-discard');
    assert.equal(await temperature.inputValue(), '1e'); assert.equal(await temperature.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '放弃修改', exact: true }).isEnabled(), true);
    await page.evaluate('window.__settingsInput.refresh({defaults:{params:{temperature:.75}}})'); await settle();
    assert.equal(await temperature.inputValue(), '1e');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click(); await settle();
    assert.equal(await temperature.inputValue(), '0.75'); assert.equal(await temperature.getAttribute('aria-invalid'), 'false');
    assert.equal(await page.getByRole('button', { name: '放弃修改', exact: true }).isDisabled(), true);
  });
  await t.test('invalid-only editing preserves the original revision until corrected and saved', async () => {
    await open(); const temperature = field('温度'); await temperature.fill('1e'); await settle();
    await page.evaluate('window.__settingsInput.refresh({defaults:{params:{temperature:.75}}})'); await settle();
    await temperature.fill('0.5'); await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
    await capture('invalid-only-revision');
    const mutations = await page.evaluate<Array<{ revision: number; ops: unknown[] }>>('window.__settingsInput.read().mutations');
    assert.equal(mutations.at(-1)?.revision, 1);
    assert.deepEqual(mutations.at(-1)?.ops, [{ op: 'set', path: ['defaults', 'params', 'temperature'], value: .5 }]);
  });
  await t.test('switching setting groups preserves raw newlines and decimal partial text', async () => {
    await open(); const skills = field('技能'); await skills.fill('first'); await skills.press('End'); await skills.press('Enter');
    await field('温度').fill('0.'); await settle();
    await page.getByRole('button', { name: '模式包来源', exact: true }).click();
    await page.getByRole('button', { name: '运行与角色默认值', exact: true }).click(); await settle(); await capture('group-raw-text');
    assert.equal(await field('技能').inputValue(), 'first\n'); assert.equal(await field('温度').inputValue(), '0.');
    await field('技能').click(); await field('技能').press('ControlOrMeta+A'); await field('技能').press('ArrowRight');
    await field('技能').pressSequentially('second'); assert.equal(await field('技能').inputValue(), 'first\nsecond');
  });
  await t.test('saving or discarding a hidden field removes its cached raw draft', async () => {
    await open(); let skills = field('技能'); await skills.fill('first'); await skills.press('End'); await skills.press('Enter'); await settle();
    await page.getByRole('button', { name: '模式包来源', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
    await page.getByRole('button', { name: '运行与角色默认值', exact: true }).click(); await settle();
    skills = field('技能'); assert.equal(await skills.inputValue(), 'first');
    await skills.click(); await skills.press('ControlOrMeta+A'); await skills.press('ArrowRight'); await skills.press('Enter'); await settle(); assert.equal(await skills.inputValue(), 'first\n');
    await page.getByRole('button', { name: '模式包来源', exact: true }).click(); await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('button', { name: '运行与角色默认值', exact: true }).click(); await settle();
    assert.equal(await field('技能').inputValue(), 'first');
  });
  await t.test('numeric paste retains malformed text and accepts finite decimal exponents', async () => {
    for (const text of ['0x10', '0b10', 'Infinity', '-Infinity', '1e309', '1e', '1.2.3']) {
      await open(); const temperature = field('温度'); await temperature.fill(text); await settle();
      assert.equal(await temperature.inputValue(), text); assert.equal(await temperature.getAttribute('aria-invalid'), 'true');
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
    }
    for (const [text, expected] of [['1e-2', .01], ['+.5', .5], ['-2.5e+1', -25]] as const) {
      await open(); const temperature = field('温度'); await temperature.fill(text); await settle();
      assert.equal(await temperature.inputValue(), text); assert.equal(await temperature.getAttribute('aria-invalid'), 'false');
      await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
      const mutations = await page.evaluate<Array<{ ops: Array<{ value: number }> }>>('window.__settingsInput.read().mutations');
      assert.equal(mutations.at(-1)?.ops.at(-1)?.value, expected);
    }
  });
  assert.deepEqual(pageErrors, []);
});
