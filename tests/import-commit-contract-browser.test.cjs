'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {chromePath, playwrightPath} = require('./browser-runtime.cjs');

const options = {timeout: 30000, skip: !chromePath || !playwrightPath};
const source = 'key,title,url,anchor\nfirst,First page,https://example.com/first,First link\nsecond,Second page,https://example.com/second,Second link\n';

async function workspace(t, replies) {
  const {chromium} = require(playwrightPath);
  const {createProjectImporter} = await import('../server/lifecycle/project-import.mjs');
  const importer = createProjectImporter();
  const root = path.resolve(__dirname, '../dist');
  const origin = 'http://localhost:4317';
  const project = {id:'project1', name:'Existing project', workflowType:'ai'};
  const projects = [project];
  const submissions = [];
  const writes = [];
  const browser = await chromium.launch({executablePath:chromePath, headless:true, args:['--disable-background-networking','--no-first-run']});
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.addInitScript(() => {window.pageposterDesktop = {};});
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) {
      const file = path.join(root, url.pathname);
      return file.startsWith(root + path.sep) && fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404});
    }
    const endpoint = url.pathname.replace('/api/lifecycle','');
    if (request.method() === 'POST') writes.push(endpoint);
    switch (endpoint) {
      case '/projects': return route.fulfill({json:{projects}});
      case '/autopilot/status': return route.fulfill({json:{aiConfigured:true}});
      case '/project-import/capabilities': return route.fulfill({json:{version:1, google:{mode:'none'}}});
      case '/project-queue': return route.fulfill({json:{projects:[{projectId:project.id, name:project.name, type:'ai', publicationPlan:{token:'plan', count:1}, items:[]}], generation:{}, publication:{}}});
      case '/project-import/preview': return route.fulfill({json:await importer.preview(request.postDataJSON())});
      case '/project-queue/import': {
        submissions.push(request.postDataJSON());
        const reply = replies[submissions.length - 1];
        if (!reply || reply.offline) return route.abort('failed');
        return route.fulfill(reply);
      }
      default: return route.fulfill({json:{pages:[], jobs:[], runs:[], overview:[]}});
    }
  });
  await page.goto(origin + '/autopilot.html');
  await page.locator('#pq-dashboard[open]').waitFor();
  return {page, submissions, writes};
}

async function openImport(page) {
  await page.getByRole('button',{name:'Імпорт проєкту',exact:true}).click();
  await page.locator('#pq-import-dialog[open]').waitFor();
  await page.locator('#pq-target option[value="project1"]').waitFor({state:'attached'});
}

async function manualImport(page) {
  await openImport(page);
  await page.locator('#pq-manual-import > summary').click();
  await page.locator('#pq-target').selectOption('project1');
  await page.locator('#pq-text').fill(source);
  await page.locator('#pq-preview-import').click();
  await page.locator('#pq-import-preview').getByText(/Сторінок: 2/).waitFor();
}

test('a rejected existing row key unlocks the import so a corrected submission has a fresh identity', options, async t => {
  const {page, submissions} = await workspace(t,[
    {status:409, json:{code:'IMPORT_DUPLICATE_KEY', error:'Виправте ключ рядка.'}},
    {status:201, json:{project:{id:'project1'}, batch:{id:'batch2',count:2,duplicateCount:0}, reused:false}}
  ]);
  await manualImport(page);
  await page.locator('#pq-commit-import').click();
  await page.getByText('Виправте ключ рядка.',{exact:true}).waitFor();
  assert.equal(await page.locator('#pq-text').isEnabled(),true);
  assert.equal(await page.locator('#pq-target').isEnabled(),true);
  await page.locator('#pq-text').fill(source.replace(/^first,/m,'changed,'));
  await page.locator('#pq-preview-import').click();
  await page.locator('#pq-import-preview').getByText(/Сторінок: 2/).waitFor();
  await page.locator('#pq-commit-import').click();
  await page.locator('#pq-import-dialog').waitFor({state:'hidden'});
  assert.equal(submissions.length,2);
  assert.notEqual(submissions[0].idempotencyKey,submissions[1].idempotencyKey);
  assert.deepEqual(submissions[1].items.map(item => item.key),['changed','second']);
});

test('the import notice uses the confirmed batch count and identifies duplicate rows', options, async t => {
  const {page} = await workspace(t,[
    {status:201, json:{project:{id:'project1'}, batch:{id:'batch1',count:1,duplicateCount:1}, reused:false}}
  ]);
  await manualImport(page);
  await page.locator('#pq-commit-import').click();
  await page.locator('#pq-import-dialog').waitFor({state:'hidden'});
  await page.locator('#pq-dashboard-note').waitFor();
  const message = await page.locator('#pq-dashboard-note').textContent();
  assert.match(message,/Додано сторінок: 1\b/);
  assert.match(message,/дублікатів: 1\b/i);
});

test('uncertain automatic imports keep the exact payload until a confirmed replay receipt', options, async t => {
  const {page, submissions} = await workspace(t,[
    {offline:true},
    {status:408, json:{code:'IMPORT_VALIDATION',error:'Минув час очікування.'}},
    {status:503, json:{code:'IMPORT_VALIDATION',error:'Сервер тимчасово недоступний.'}},
    {status:200, json:{project:{id:'project1'}}},
    {status:200, json:{project:{id:'project1'}, batch:{id:'batch1',count:2}, reused:true}}
  ]);
  await openImport(page);
  await page.locator('#pq-auto-file').setInputFiles({name:'import.csv', mimeType:'text/csv', buffer:Buffer.from(source)});
  const failures = [/Failed to fetch/,/Минув час очікування/,/Сервер тимчасово недоступний/,/Сервер не підтвердив імпорт/];
  for (const [index, failure] of failures.entries()) {
    await page.locator('#pq-import-note').getByText(failure).waitFor();
    const retry = page.locator('#pq-auto-retry');
    await retry.waitFor();
    assert.equal(submissions.length,index + 1);
    assert.equal(await page.locator('#pq-target').isEnabled(),false);
    await retry.click();
  }
  await page.locator('#pq-import-dialog').waitFor({state:'hidden'});
  await page.locator('#pq-dashboard-note').waitFor();
  assert.equal(submissions.length,5);
  for (const submission of submissions) assert.deepEqual(submission,submissions[0]);
  const message = await page.locator('#pq-dashboard-note').textContent();
  assert.match(message,/Імпорт уже виконано/i);
  assert.doesNotMatch(message,/Додано сторінок: 2/i);
});

test('an unconfirmed restore freezes an import retry and project publication', options, async t => {
  const {page, writes} = await workspace(t,[{offline:true}]);
  await openImport(page);
  await page.locator('#pq-auto-file').setInputFiles({name:'import.csv', mimeType:'text/csv', buffer:Buffer.from(source)});
  await page.locator('#pq-auto-retry').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('pageposter:recovery-restart-required')));
  assert.equal(await page.locator('#pq-auto-retry').isEnabled(),false);
  assert.equal(await page.locator('#pq-auto-file').isEnabled(),false);
  assert.match(await page.locator('#pq-import-note').textContent(),/Відновлення не підтверджено\. Перезапустіть PagePoster/);
  await page.locator('#pq-import-close').click();
  assert.equal(await page.locator('[data-action=start-project]').isEnabled(),false);
  assert.match(await page.locator('#pq-dashboard-note').textContent(),/Відновлення не підтверджено\. Перезапустіть PagePoster/);
  await page.locator('[data-action=start-project]').evaluate(button => button.click());
  await page.locator('#pq-auto-retry').evaluate(button => button.click());
  assert.deepEqual(writes,['/project-import/preview','/project-queue/import']);
});
