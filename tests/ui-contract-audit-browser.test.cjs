'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromePath, playwright } = require('./browser-runtime.cjs');

const options = { timeout: 20000 };
const origin = 'http://127.0.0.1:49151';
const dist = path.resolve(__dirname, '../dist');
const project = { id: 'p1', name: 'Проєкт', workflowType: 'ai' };
const sheet = { configured: true, authMode: 'user', spreadsheetId: 'fixture-sheet' };

async function workspace(t, { desktop = true, aiConfigured = true, accountConnected = true, preparation = 'awaiting_review', initialRuns = [] } = {}) {
 const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
 t.after(() => browser.close());
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 page.setDefaultTimeout(5000);
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 t.after(() => assert.deepEqual(errors, []));
 if (desktop) await page.addInitScript(() => { window.pageposterDesktop = {}; });

 let runs = initialRuns;
 await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (url.pathname === '/api/lifecycle/projects/p1/autopilot' && route.request().method() === 'POST') {
   const run = { id: 'run1', projectId: project.id, source: 'ai', title: 'Готова сторінка', state: 'queued', stage: 'generating' };
   runs = [preparation === 'failed'
    ? { ...run, state: 'failed', error: { code: 'AI_OUTPUT_INVALID' } }
    : { ...run, state: 'awaiting_review', stage: 'selecting', hasHtml: true, pageId: 'page1' }];
   return route.fulfill({ json: { run } });
  }
  if (url.pathname === '/api/lifecycle/autopilot/run1/approve') {
   const run = { ...runs[0], state: 'queued', stage: 'publishing' };
   runs = [{ ...run, state: 'completed', stage: 'completed', fullUrl: 'https://published.example.test/page/' }];
   return route.fulfill({ json: { run } });
  }
  const responses = {
   '/api/lifecycle/projects': { projects: [project] },
   '/api/lifecycle/autopilot/status': { aiConfigured, source: sheet, browserMode: 'hidden', visibleBrowser: desktop },
   '/api/lifecycle/project-queue': {
    manualPublishedReview: desktop,
    projects: [{ projectId: project.id, name: project.name, type: project.workflowType, items: [], counts: { total: 0 } }]
   },
   '/api/lifecycle/projects/p1/jobs': { jobs: [] },
   '/api/lifecycle/projects/p1/pages': { pages: [] },
   '/api/lifecycle/projects/p1/overview': { pages: [] },
   '/api/lifecycle/projects/p1/autopilot': { runs },
   '/api/lifecycle/autopilot/run1/html': { html: '<h1>Готова сторінка</h1>', reviewToken: 'fixture-review' },
   '/api/lifecycle/google/account': {
    account: { clientConfigured: true, connected: accountConnected, phase: accountConnected ? 'connected' : 'idle', email: 'author@example.test' }
   },
   '/api/lifecycle/autopilot/source/check': { candidateCount: 0, issueCount: 0, sample: [] }
  };
  if (responses[url.pathname]) return route.fulfill({ json: responses[url.pathname] });
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  const file = path.join(dist, url.pathname.slice(1) || 'index.html');
  return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
 });
 await page.goto(origin);
 if (desktop) {
  await page.locator('#pq-dashboard').getByText('Дії проєкту', { exact: true }).click();
  await page.locator('#pq-projects').getByRole('button', { name: 'Додати одну сторінку', exact: true }).click();
 }
 await page.locator('#ap-composer:visible').waitFor();
 return page;
}

test('the Google settings hint names the visible project requirements control', options, async t => {
 const page = await workspace(t);
 const control = page.locator('#ap-site-selection-open');
 assert.ok(await control.isVisible());
 const label = (await control.textContent()).trim();
 await page.locator('#ap-settings-open').click();
 await page.locator('#ap-source-advanced summary').first().click();
 const hint = page.locator('#ap-source-advanced').getByText(/мінімальний DR/i);
 assert.ok(await hint.isVisible());
 assert.ok((await hint.textContent()).includes(`«${label}»`), `The instructions must name «${label}»`);
});

test('Google sign-in instructions disappear when the only action is switching accounts', options, async t => {
 const page = await workspace(t);
 await page.locator('#ap-settings-open').click();
 await page.getByRole('button', { name: 'Вибрати інший акаунт', exact: true }).waitFor();
 assert.equal(await page.locator('#ga-sign-in-help').isVisible(), false);
});

test('Desktop tells the author to inspect the live page after publication', options, async t => {
 const page = await workspace(t);
 const footer = page.locator('.ap-footer');
 assert.ok(await footer.isVisible());
 assert.match(await footer.textContent(), /після публікації.*ручн/i);
});

test('WordPress settings describe a separate window only for visible mode', options, async t => {
 const page = await workspace(t);
 await page.locator('#ap-settings-open').click();
 await page.getByRole('button', { name: 'Додатково', exact: true }).click();
 assert.equal(await page.locator('#ap-browser-mode').inputValue(), 'hidden');
 const windowHelp = page.getByText(/окреме приватне вікно/i);
 assert.ok(await windowHelp.isVisible());
 assert.match(await windowHelp.textContent(), /у видимому режимі/i);
});

test('the missing OpenAI setup action opens the key editor on Desktop', options, async t => {
 const page = await workspace(t, { aiConfigured: false });
 await page.locator('#ap-setup-open').click();
 assert.equal(await page.locator('[data-settings-tab="ai"]').getAttribute('aria-pressed'), 'true');
 assert.ok(await page.locator('[name="apiKey"]').isVisible());
});

async function launchPreparation(page) {
 await page.getByRole('textbox', { name: 'Посилання', exact: true }).fill('https://offer.example.test/');
 await page.getByRole('textbox', { name: 'Анкор', exact: true }).fill('Текст');
 await page.getByRole('button', { name: 'Підготувати й переглянути', exact: true }).click();
}

test('a failed preparation points to the visible way back to the saved run on Desktop', options, async t => {
 const page = await workspace(t, { preparation: 'failed' });
 await launchPreparation(page);
 await page.locator('#ap-stage[data-status="error"]').waitFor();
 assert.equal(await page.locator('#ap-results').isVisible(), false);
 assert.ok(await page.getByRole('button', { name: /до списку сторінок/i }).isVisible());
 assert.match(await page.locator('#ap-stage-status').textContent(), /списк.*сторінок/i);
});

test('a published Desktop page without verification is ready for manual review', options, async t => {
 const page = await workspace(t);
 await launchPreparation(page);
 await page.getByRole('button', { name: 'Опублікувати сторінку', exact: true }).click();
 await page.locator('#ap-stage-status').getByText(/Сторінку опубліковано/).waitFor();
 assert.match(await page.locator('#ap-stage-status').textContent(), /ручн/i);
});

test('confirmed Trash takes precedence over link issues from an old publication', options, async t => {
 const run = {
  id: 'trashed', projectId: project.id, title: 'Видалена публікація', state: 'needs_attention', stage: 'publishing',
  publication: { state: 'trashed', lastEvidence: { observation: 'published' } },
  verification: { diagnostics: { linkSummary: { outsideUrls: 1 } } }
 };
 const waiting = { ...run, id: 'trashed-before-retry', publication: { ...run.publication, recovery: { state: 'waiting' } } };
 const page = await workspace(t, { desktop: false, initialRuns: [run, waiting] });
 for (const item of [run, waiting]) {
  const status = page.locator(`[data-run-id="${item.id}"] .ap-run-top .ap-badge`);
  await status.waitFor();
  assert.equal(await status.textContent(), 'Кошик підтверджено');
 }
});

test('a skipped donor displays a network timeout as a connection problem', options, async t => {
 const page = await workspace(t, { desktop: false, initialRuns: [{
  id: 'skip', projectId: project.id, title: 'Підбір донора', state: 'needs_attention', stage: 'selecting',
  skippedSites: [{ baseUrl: 'https://donor.example.test/', code: 'network_timeout' }]
 }] });
 const reason = page.locator('[data-run-id="skip"]').getByText(/Пропущено donor\.example\.test/);
 await reason.waitFor();
 assert.match(await reason.textContent(), /мереж|з’єдн|час/i);
 assert.doesNotMatch(await reason.textContent(), /плагін/i);
});
