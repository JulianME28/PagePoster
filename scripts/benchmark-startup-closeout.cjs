'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { stopElectron, cleanupSmoke, assertEndpointClosed } = require('./desktop-smoke-control.cjs');
const { captureSourceIdentity, compareSources, summarizeSamples } = require('./startup-benchmark-evidence.cjs');

const root = path.resolve(__dirname, '..');
const { _electron: electron } = require('../.desktop-build/production/node_modules/playwright-core');
const executablePath = path.join(root, '.desktop-build/runtime/node_modules/electron/dist/electron.exe');
const datasetSizes = { 'synthetic-16-72-78': { projects: 16, pages: 72, runs: 78 }, 'synthetic-1000': { projects: 1, pages: 1000, runs: 1000 } };
const options = Object.create(null);
const args = process.argv.slice(2);
assert.equal(args.length, 6, 'Use --samples N --dataset NAME --mode MODE');
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--samples', '--dataset', '--mode'].includes(args[i]) && !Object.hasOwn(options, args[i]));
  options[args[i]] = args[i + 1];
}
const samples = Number(options['--samples']);
const dataset = options['--dataset'];
const mode = options['--mode'];
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
assert.ok(Object.hasOwn(datasetSizes, dataset));
assert.ok(['process-new', 'process-repeat', 'tray'].includes(mode));
const counts = datasetSizes[dataset];

const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pageposter-c03-'));
const reportFile = path.join(output, 'evidence.json');
const before = captureSourceIdentity(root);
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = {
  executableSha256: hashFile(executablePath),
  benchmarkSha256: hashFile(__filename),
  cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramBytes: os.totalmem(),
  os: os.release(), arch: os.arch(), node: process.versions.node,
};
const key = crypto.randomBytes(32).toString('base64');
const results = [];
function save(state) {
  const after = captureSourceIdentity(root);
  const values = results.filter(sample => sample.status === 'ready');
  const percentiles = field => {
    const sorted = values.map(sample => sample[field]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const at = p => sorted[Math.ceil(sorted.length * p) - 1];
    return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
  };
  const report = { state, identity, dataset, fixtureVersion: 1, counts, mode, samples,
    method: 'Source Electron. New process with fresh profile, new process after a warm-up on the same profile, or show via the tray menu after readiness. OS caches are retained. Fixture seeding and warm-up are outside the timed interval.',
    source: { before, after, ...compareSources(before, after) },
    summary: summarizeSamples(results),
    metrics: Object.fromEntries(['firstWindowMs', 'readyMs', 'trayMs', 'filterMs', 'queueBytes'].map(field => [field, percentiles(field)])),
    results };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function seed(profile) {
  const realProfile = fs.realpathSync(profile);
  assert.equal(path.dirname(realProfile), fs.realpathSync(output));
  assert.ok(!realProfile.toLowerCase().split(path.sep).includes('.pageposter'));
  const directory = path.join(realProfile, 'workspace', 'data');
  fs.mkdirSync(directory, { recursive: true });
  const { createStore } = await import('../server/lifecycle/store.mjs');
  const store = createStore({ filename: path.join(directory, 'pageposter.sqlite'), masterKey: key });
  try {
    return store.atomic(() => {
      const projects = Array.from({ length: counts.projects }, (_, index) => {
        const project = store.createProject({ name: 'Synthetic project ' + index, workflowType: 'html', monitoringPolicy: { enabled: false } });
        store.createRecord(project.id, 'project_queue_control', { paused: true, priority: 5 }, 'queue-control:' + project.id);
        return project;
      });
      const html = '<main><p>' + 'Synthetic page body. '.repeat(950) + '</p></main>';
      for (let index = 0; index < counts.runs; index++) {
        const project = projects[index % projects.length];
        const title = (index % 10 ? 'Article ' : 'Guide ') + index;
        const page = index < counts.pages ? store.createPage(project.id, { title, config: { importHtml: html }, wpType: 'page', lifecycleState: 'draft' }) : null;
        store.createRecord(project.id, 'autopilot', {
          source: 'html', title, pageId: page?.id ?? null, state: 'awaiting_review', stage: 'selecting',
          language: 'pl', siteSelection: { geo: 'PL' }, links: [], reviewBeforePublish: true,
        });
      }
      return Object.fromEntries(projects.map((project, index) =>
        [project.id, Math.ceil((counts.runs - index) / projects.length)]));
    });
  } finally {
    store.close();
  }
}

function writeHarness(profile) {
  const wrapper = path.join(profile, 'offline-main.cjs');
  const guard = path.join(profile, 'offline-backend.cjs');
  fs.writeFileSync(guard, `
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const [address] = net._normalizeArgs(args);
  if (address.path || !['127.0.0.1', '::1', 'localhost'].includes(address.host || 'localhost')) {
    throw Error('Benchmark backend may only connect to loopback');
  }
  return connect.apply(this, args);
};
const udp = require('node:dgram');
udp.createSocket = () => { throw Error('Benchmark backend cannot use UDP'); };
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
for (const api of [dns, dnsPromises]) {
  const lookup = api.lookup;
  api.lookup = function(host, ...args) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw Error('Benchmark backend may only resolve loopback');
    }
    return lookup.call(this, host, ...args);
  };
}
for (const api of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(api)) {
    if (/^(?:resolve|reverse|lookupService)/.test(name) && typeof api[name] === 'function') {
      api[name] = () => { throw Error('Benchmark backend cannot query external DNS'); };
    }
  }
}
require('node:module').syncBuiltinESMExports();
`);
  fs.writeFileSync(wrapper, `
const { app, Menu } = require('electron');
const child = require('node:child_process');
const fork = child.fork;
child.fork = (module, args, options) => fork(module, args, { ...options, execArgv: ['--require', ${JSON.stringify(guard)}] });
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
app.on('session-created', session => {
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const local = ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1';
    callback({ cancel: !local && !['file:', 'data:', 'devtools:'].includes(url.protocol) });
  });
});
app.once('browser-window-created', (_, window) => window.once('show', () => { globalThis.c03FirstWindow = Date.now(); }));
const buildMenu = Menu.buildFromTemplate;
Menu.buildFromTemplate = template => {
  const menu = buildMenu(template);
  const entry = menu.items.find(item => item.label === 'Відкрити PagePoster');
  if (entry) globalThis.c03ShowFromTray = () => entry.click();
  return menu;
};
require(${JSON.stringify(path.join(root, 'desktop', 'main.cjs'))});
`);
  return wrapper;
}

async function launch(profile, wrapper, index, measured, projectRows) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OPENAI_|GOOGLE_|PAGEPOSTER_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(name)));
  Object.assign(env, { PAGEPOSTER_DESKTOP_TEST_ROOT: profile, PAGEPOSTER_NODE_PATH: process.execPath, PAGEPOSTER_MASTER_KEY: key });
  const diagnostics = path.join(profile, 'profile', 'startup-diagnostics.json');
  fs.rmSync(diagnostics, { force: true });
  const start = Date.now();
  let app, failure;
  try {
    app = await electron.launch({ executablePath, args: [wrapper], env, timeout: 45000 });
    const window = await app.firstWindow();
    await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    if (counts.projects === 1) {
      await window.waitForFunction(expected => document.querySelectorAll('#pq-projects [data-queue-item]').length === expected, counts.runs);
    } else {
      // A populated workspace opens its default project after loading the sidebar.
      await window.waitForFunction(expected => {
        const filter = document.getElementById('pq-project-filter');
        const rows = expected[filter.value];
        return filter.options.length === Object.keys(expected).length + 1 && rows > 0 &&
          document.querySelectorAll('#pq-projects [data-queue-item]').length === rows;
      }, projectRows);
    }
    const readyMs = Date.now() - start;
    const firstWindowMs = await app.evaluate(() => globalThis.c03FirstWindow) - start;
    assert.ok(Number.isFinite(firstWindowMs) && firstWindowMs >= 0 && firstWindowMs <= readyMs);
    await window.waitForFunction(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === '/api/lifecycle/project-queue'));
    let phases;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        phases = JSON.parse(fs.readFileSync(diagnostics, 'utf8')).phases;
        if (Object.hasOwn(phases, 'queue-response') && Object.hasOwn(phases, 'workspace-loaded')) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(Object.hasOwn(phases || {}, 'queue-response') && Object.hasOwn(phases, 'workspace-loaded'));
    const sample = { kind: mode, index, status: 'ready', wallMs: readyMs, firstWindowMs, readyMs, phases };
    sample.electron = await app.evaluate(() => process.versions.electron);
    sample.queueBytes = await window.evaluate(() => performance.getEntriesByType('resource')
      .find(entry => new URL(entry.name).pathname === '/api/lifecycle/project-queue').decodedBodySize);
    if (measured && mode === 'tray') {
      const origin = new URL(window.url()).origin;
      const elapsed = await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.close();
        if (window.isVisible()) throw Error('Window did not hide to tray');
        const begin = performance.now();
        const shown = new Promise(resolve => window.once('show', () => resolve(performance.now() - begin)));
        globalThis.c03ShowFromTray();
        return shown;
      });
      assert.equal(new URL(window.url()).origin, origin);
      sample.trayMs = elapsed;
      sample.wallMs = elapsed;
    }
    if (measured && dataset === 'synthetic-1000') {
      const timings = await window.evaluate(async () => {
        const search = document.getElementById('pq-search');
        const begin = performance.now();
        search.value = 'Article';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const handlerMs = performance.now() - begin;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { handlerMs, filterMs: performance.now() - begin, rows: document.querySelectorAll('[data-queue-item]').length };
      });
      assert.equal(timings.rows, 900);
      Object.assign(sample, timings);
    }
    const origin = new URL(window.url()).origin;
    await stopElectron(app);
    app = null;
    await assertEndpointClosed(origin);
    if (measured) results.push(sample);
  } catch (error) {
    failure = error;
    results.push({ kind: mode, index, status: 'failed', warmUp: !measured, wallMs: Date.now() - start, error: error.message });
    throw error;
  } finally {
    if (app) await cleanupSmoke(app, { failure });
  }
}

async function main() {
  console.log(reportFile);
  save('running');
  for (let index = 0; index < samples; index++) {
    const profile = fs.mkdtempSync(path.join(output, 'profile-'));
    const projectRows = await seed(profile);
    const wrapper = writeHarness(profile);
    if (mode === 'process-repeat') await launch(profile, wrapper, index, false, projectRows);
    await launch(profile, wrapper, index, true, projectRows);
    save('running');
  }
  const report = save('complete');
  assert.equal(report.source.stable, true);
  console.log(JSON.stringify({ reportFile, metrics: report.metrics, summary: report.summary }));
}
main().catch(error => {
  save('failed');
  console.error(error);
  process.exitCode = 1;
});
