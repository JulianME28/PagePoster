const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const {resolveDesktopPaths} = require('../desktop/runtime.cjs');
const {normalizeDesktopConfig, createBackendOptions, startDesktopBackend} = require('../desktop/backend.cjs');

const KEY = Buffer.alloc(32, 76).toString('base64');
const TOKEN = 'a7'.repeat(32);
const APP_ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(APP_ROOT, 'desktop', 'backend.cjs');
const beforeRemoval = new WeakMap();
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-'));
  const cleanups = [];
  beforeRemoval.set(t, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    fs.rmSync(root, {recursive:true, force:true});
  });
  return root;
}
function configuration(root) {
  return {appRoot:APP_ROOT, dataDir:path.join(root, 'data'), keyDir:path.join(root, 'keys'), legacyEnvFile:path.join(root, '.env'), port:0};
}
function childProcess(t, config, extraEnv = {}) {
  const child = fork(BACKEND, [], {execPath:process.execPath, cwd:APP_ROOT, env:{...process.env, PAGEPOSTER_MASTER_KEY:KEY, PAGEPOSTER_ACCESS_TOKEN:TOKEN, PAGEPOSTER_DESKTOP_CONFIG:JSON.stringify(config), ...extraEnv}, stdio:['ignore','pipe','pipe','ipc'], windowsHide:true});
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const messages = [];
  child.on('message', message => messages.push(message));
  beforeRemoval.get(t).push(async () => {
    if (child.exitCode === null) {
      if (child.connected) child.send({type:'shutdown'});
      await once(child, 'exit');
    }
    assert.doesNotMatch(output, new RegExp(TOKEN));
  });
  return {child, messages, output:() => output};
}
async function nextMessage(child) {
  const [message] = await once(child, 'message', {signal:AbortSignal.timeout(15000)});
  return message;
}
function auth() { return {'Authorization':'Basic '+Buffer.from('pageposter:'+TOKEN).toString('base64')}; }
async function saveProject(base, name) {
  const response = await fetch(base+'/api/lifecycle/projects', {method:'POST', headers:{...auth(), Origin:base, 'Content-Type':'application/json', 'X-PagePoster-Request':'1'}, body:JSON.stringify({name})});
  assert.equal(response.status, 201);
  return (await response.json()).project;
}

test('development paths retain source data and the existing DPAPI directory', t => {
  const root = temporary(t);
  const appRoot = path.join(root, 'source');
  const result = resolveDesktopPaths({appRoot, userDataPath:path.join(root, 'user'), resourcesPath:path.join(root, 'resources'), isPackaged:false, env:{PAGEPOSTER_NODE_PATH:path.join(root, 'node.exe')}});
  assert.deepEqual(result, {nodePath:path.join(root, 'node.exe'), dataDir:path.join(appRoot, '.pageposter', 'data'), keyDir:path.join(appRoot, '.pageposter', 'keys'), legacyEnvFile:path.join(appRoot, '.env')});
});

test('packaged paths reuse an existing workspace without changing its key', t => {
  const root = temporary(t), workspaceRoot = path.join(root, 'source'), keyDir = path.join(workspaceRoot, '.pageposter', 'keys');
  fs.mkdirSync(keyDir, {recursive:true});
  fs.writeFileSync(path.join(keyDir, 'master.dpapi'), 'existing-encrypted-key');
  const result = resolveDesktopPaths({appRoot:path.join(root, 'app'), resourcesPath:path.join(root, 'resources'), userDataPath:path.join(root, 'user'), isPackaged:true, bootstrap:{workspaceRoot}, env:{}});
  assert.deepEqual(result, {nodePath:path.join(root, 'resources', 'node', 'node.exe'), dataDir:path.join(workspaceRoot, '.pageposter', 'data'), keyDir, legacyEnvFile:path.join(workspaceRoot, '.env')});
  assert.equal(fs.readFileSync(path.join(keyDir, 'master.dpapi'), 'utf8'), 'existing-encrypted-key');
  assert.equal(fs.existsSync(path.join(root, 'user')), false);
});

test('packaged installs without existing source state use the user workspace', t => {
  const root = temporary(t), userDataPath = path.join(root, 'user'), resourcesPath = path.join(root, 'resources');
  const result = resolveDesktopPaths({appRoot:path.join(root, 'app'), resourcesPath, userDataPath, isPackaged:true, bootstrap:{workspaceRoot:path.join(root, 'missing-source')}, env:{}});
  assert.equal(result.dataDir, path.join(userDataPath, 'workspace', 'data'));
  assert.equal(result.keyDir, path.join(userDataPath, 'workspace', 'keys'));
  assert.equal(result.nodePath, path.join(resourcesPath, 'node', 'node.exe'));
  assert.equal(fs.existsSync(userDataPath), false);
});

test('legacy .env data paths stay selected even without source or configured state directories', t => {
  const root = temporary(t), workspaceRoot = path.join(root, 'source');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, '.env'), 'PAGEPOSTER_DATA_DIR="../custom state/data"\nPAGEPOSTER_ACCESS_TOKEN=legacy-private-fixture\n');
  const result = resolveDesktopPaths({appRoot:path.join(root, 'app'), resourcesPath:path.join(root, 'resources'), userDataPath:path.join(root, 'user'), isPackaged:true, bootstrap:{workspaceRoot}, env:{}});
  assert.equal(result.dataDir, path.join(root, 'custom state', 'data'));
  assert.equal(result.keyDir, path.join(root, 'custom state', 'keys'));
  assert.equal(result.legacyEnvFile, path.join(workspaceRoot, '.env'));
  assert.equal(fs.existsSync(result.dataDir), false);
  assert.equal(fs.existsSync(path.join(root, 'user')), false);
});

test('inherited path variables take precedence over .env and resolve against the legacy workspace', t => {
  const root = temporary(t), workspaceRoot = path.join(root, 'source');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, '.env'), 'PAGEPOSTER_DATA_DIR=./wrong-data\nPAGEPOSTER_KEY_DIR=./wrong-keys\n');
  const env = {PAGEPOSTER_DATA_DIR:path.join(root, 'inherited-data'), PAGEPOSTER_KEY_DIR:'../inherited-keys'};
  const result = resolveDesktopPaths({appRoot:path.join(root, 'app'), resourcesPath:path.join(root, 'resources'), userDataPath:path.join(root, 'user'), isPackaged:true, bootstrap:{workspaceRoot}, env});
  assert.equal(result.dataDir, path.join(root, 'inherited-data'));
  assert.equal(result.keyDir, path.join(root, 'inherited-keys'));
  assert.deepEqual(env, {PAGEPOSTER_DATA_DIR:path.join(root, 'inherited-data'), PAGEPOSTER_KEY_DIR:'../inherited-keys'});
});

test('development .env supports a separate key path without mutating process environment', t => {
  const root = temporary(t), appRoot = path.join(root, 'source');
  fs.mkdirSync(appRoot);
  fs.writeFileSync(path.join(appRoot, '.env'), 'PAGEPOSTER_DATA_DIR=../data\nPAGEPOSTER_KEY_DIR="../protected keys"\n');
  const beforeData = process.env.PAGEPOSTER_DATA_DIR, beforeKey = process.env.PAGEPOSTER_KEY_DIR;
  const result = resolveDesktopPaths({appRoot, isPackaged:false, env:{PAGEPOSTER_NODE_PATH:path.join(root, 'node.exe')}});
  assert.equal(result.dataDir, path.join(root, 'data'));
  assert.equal(result.keyDir, path.join(root, 'protected keys'));
  assert.equal(process.env.PAGEPOSTER_DATA_DIR, beforeData);
  assert.equal(process.env.PAGEPOSTER_KEY_DIR, beforeKey);
});

test('empty inherited path values suppress .env overrides like process.loadEnvFile', t => {
  const root = temporary(t), appRoot = path.join(root, 'source');
  fs.mkdirSync(appRoot);
  fs.writeFileSync(path.join(appRoot, '.env'), 'PAGEPOSTER_DATA_DIR=./wrong-data\nPAGEPOSTER_KEY_DIR=./wrong-keys\n');
  const result = resolveDesktopPaths({appRoot, isPackaged:false, env:{PAGEPOSTER_NODE_PATH:path.join(root, 'node.exe'), PAGEPOSTER_DATA_DIR:'', PAGEPOSTER_KEY_DIR:''}});
  assert.equal(result.dataDir, path.join(appRoot, '.pageposter', 'data'));
  assert.equal(result.keyDir, path.join(appRoot, '.pageposter', 'keys'));
});

test('unreadable legacy path configuration fails instead of silently opening fresh state', t => {
  const root = temporary(t);
  assert.throws(() => resolveDesktopPaths({appRoot:path.join(root, 'app'), resourcesPath:path.join(root, 'resources'), userDataPath:path.join(root, 'user'), isPackaged:true, bootstrap:{workspaceRoot:path.join(root, 'source')}, env:{}, readFileSync:() => {throw Object.assign(Error('private-env-content'), {code:'EACCES'});}}), error => error.code === 'DESKTOP_PATH_CONFIG_INVALID' && !error.message.includes('private-env-content'));
});

test('desktop configuration validates paths and keeps private bootstrap values authoritative', t => {
  const fixtureRoot = temporary(t);
  // Exercise an unbundled fixture, independent of the developer's real client.
  const config = {...configuration(fixtureRoot), appRoot:path.join(fixtureRoot, 'app')};
  assert.deepEqual(normalizeDesktopConfig(JSON.stringify(config)), config);
  for (const invalid of [null, 'broken', {...config,dataDir:'relative'}, {...config,port:4317}, {...config,extra:true}]) assert.throws(() => normalizeDesktopConfig(invalid), {code:'DESKTOP_CONFIG_INVALID'});
  assert.throws(() => createBackendOptions(config, {PAGEPOSTER_ACCESS_TOKEN:'private-invalid-token'}), {code:'DESKTOP_TOKEN_INVALID'});
  const options = createBackendOptions(config, {PAGEPOSTER_ACCESS_TOKEN:TOKEN, PAGEPOSTER_DATA_DIR:'wrong', PAGEPOSTER_KEY_DIR:'wrong', PAGEPOSTER_PUBLIC_ORIGIN:'https://wrong.example/', OPENAI_MODEL:'fixture-model'});
  assert.equal(options.env.PAGEPOSTER_ACCESS_TOKEN, TOKEN);
  assert.equal(options.env.PAGEPOSTER_DATA_DIR, config.dataDir);
  assert.equal(options.env.PAGEPOSTER_KEY_DIR, config.keyDir);
  assert.equal(options.env.PAGEPOSTER_PUBLIC_ORIGIN, undefined);
  assert.equal(options.env.OPENAI_MODEL, 'fixture-model');
  assert.deepEqual(options.lifecycle, {dataDir:config.dataDir, keyDir:config.keyDir, desktop:true, visibleBrowserEnabled:true});
});

test('desktop child reports one authenticated loopback endpoint and preserves projects across shutdown', {timeout:30000}, async t => {
  const config = configuration(temporary(t));
  fs.writeFileSync(config.legacyEnvFile, 'OPENAI_MODEL=fixture-from-legacy\nPAGEPOSTER_ACCESS_TOKEN=legacy-token-must-not-win\nPAGEPOSTER_DATA_DIR=wrong-path\nPAGEPOSTER_PUBLIC_ORIGIN=https://wrong.example/\n');
  const first = childProcess(t, config);
  const ready = await nextMessage(first.child);
  assert.deepEqual(Object.keys(ready).sort(), ['pid','port','type']);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.pid, first.child.pid);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  const base = 'http://127.0.0.1:'+ready.port;
  assert.equal((await fetch(base+'/api/lifecycle/status')).status, 401);
  const status = await (await fetch(base+'/api/lifecycle/status', {headers:auth()})).json();
  assert.equal(status.runtime, 'desktop');
  const ai = await (await fetch(base+'/api/ai/status', {headers:auth()})).json();
  assert.equal(ai.model, 'fixture-from-legacy');
  const project = await saveProject(base, 'Desktop persistence fixture');
  const exited = once(first.child, 'exit');
  first.child.send({type:'shutdown'});
  assert.deepEqual(await exited, [0,null]);
  assert.equal(first.messages.filter(message => message.type === 'ready').length, 1);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'pageposter.sqlite')), true);
  const second = childProcess(t, config);
  const restarted = await nextMessage(second.child);
  assert.equal(restarted.type, 'ready');
  const saved = await (await fetch('http://127.0.0.1:'+restarted.port+'/api/lifecycle/projects', {headers:auth()})).json();
  assert.equal(saved.projects.find(item => item.id === project.id).name, 'Desktop persistence fixture');
});

test('parent disconnect drains and exits without leaving the backend listening', {timeout:30000}, async t => {
  const {child} = childProcess(t, configuration(temporary(t)));
  const ready = await nextMessage(child);
  assert.equal(ready.type, 'ready');
  const exited = once(child, 'exit');
  child.disconnect();
  assert.deepEqual(await exited, [0,null]);
  await assert.rejects(fetch('http://127.0.0.1:'+ready.port+'/api/lifecycle/status', {headers:auth()}));
});

test('parent loss during initialization cannot leave a ready orphan backend', {timeout:30000}, async t => {
  const {child, messages} = childProcess(t, configuration(temporary(t)));
  const exited = once(child, 'exit');
  child.disconnect();
  assert.deepEqual(await exited, [0,null]);
  assert.equal(messages.some(message => message.type === 'ready'), false);
});

test('invalid startup reports a bounded generic IPC error without exposing private paths', {timeout:30000}, async t => {
  temporary(t);
  const {child, output} = childProcess(t, {appRoot:'private-path-secret'});
  const result = await nextMessage(child);
  assert.equal(result.type, 'error');
  assert.equal(result.code, 'DESKTOP_CONFIG_INVALID');
  assert.doesNotMatch(JSON.stringify(result), /private-path-secret/);
  const exited = await once(child, 'exit');
  assert.deepEqual(exited, [1,null]);
  assert.doesNotMatch(output(), /private-path-secret/);
});

test('shutdown stops new claims while an active job drains before closing storage', {timeout:30000}, async t => {
  const config = configuration(temporary(t));
  let release, entered;
  const activeJob = new Promise(resolve => entered = resolve);
  const remote = new Promise(resolve => release = resolve);
  const {createLocalServer} = require('../server/local.cjs');
  const runtime = await startDesktopBackend({config, env:{PAGEPOSTER_ACCESS_TOKEN:TOKEN, PAGEPOSTER_MASTER_KEY:KEY}, createServer:options => createLocalServer({...options, lifecycle:{...options.lifecycle, workerIntervalMs:60000, client:{checkSite:async () => {entered(); await remote; return {state:'ok',capabilities:{}};}}}}), attachProcessHandlers:false});
  beforeRemoval.get(t).push(() => runtime.shutdown());
  const lifecycle = runtime.server.lifecycle;
  await lifecycle.tick();
  const project = lifecycle.store.createProject({name:'Draining'});
  const site = lifecycle.store.createSite(project.id, {name:'Fixture',baseUrl:'https://fixture.example/'});
  const first = lifecycle.store.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'active-desktop-fixture'});
  const second = lifecycle.store.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'queued-desktop-fixture'});
  const active = lifecycle.tick();
  await activeJob;
  let stopped = false;
  const shutdown = runtime.shutdown().then(() => stopped = true);
  await lifecycle.tick();
  assert.equal(stopped, false);
  assert.equal(lifecycle.store.getJob(second.id).state, 'queued');
  release();
  await active;
  await shutdown;
  const {createStore} = await import('../server/lifecycle/store.mjs');
  const store = createStore({filename:path.join(config.dataDir,'pageposter.sqlite'),masterKey:KEY});
  beforeRemoval.get(t).push(() => store.close());
  assert.equal(store.getJob(first.id).state, 'completed');
  assert.equal(store.getJob(second.id).state, 'queued');
});

for (const waitingStage of ['campaigns', 'autopilot']) test('quiesce during '+waitingStage+' wait leaves the next job unclaimed', {timeout:30000}, async t => {
  const root = temporary(t);
  const {createLifecycleService} = await import('../server/lifecycle/service.mjs');
  const lifecycle = await createLifecycleService({dataDir:path.join(root, 'data'),masterKey:KEY,client:{checkSite:async () => ({state:'ok',capabilities:{}})}});
  beforeRemoval.get(t).push(() => lifecycle.close());
  const project = lifecycle.store.createProject({name:'Suspended before claim'});
  const site = lifecycle.store.createSite(project.id, {name:'Fixture',baseUrl:'https://fixture.example/'});
  const queued = lifecycle.store.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'quiesce-'+waitingStage});
  let enter, release;
  const entered = new Promise(resolve => enter = resolve);
  const gate = new Promise(resolve => release = resolve);
  const originalTick = lifecycle[waitingStage].tick;
  lifecycle[waitingStage].tick = async (...args) => { enter(); await gate; return originalTick(...args); };
  const active = lifecycle.tick();
  await entered;
  const quiesced = lifecycle.quiesce();
  release();
  await Promise.all([active,quiesced]);
  const saved = lifecycle.store.getJob(queued.id);
  assert.equal(saved.state, 'queued');
  assert.equal(saved.attempt, 0);
});
