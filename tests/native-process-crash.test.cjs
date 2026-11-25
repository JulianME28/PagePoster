'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const worker = path.join(__dirname, 'native-process-crash-worker.cjs');
const boundaries = ['before-send', 'after-dispatch', 'after-write', 'after-receipt'];
const expired = 181001;

function fixture(t, operation) {
 const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pp-native-crash-'));
 const ledgerPath = path.join(root, 'remote.json');
 const counts = { create: 0, publish: 0, trash: 0, update: 0, read: 0 };
 fs.writeFileSync(ledgerPath, JSON.stringify({ counts, post: null }));
 const read = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
 t.after(() => {
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(root), /^pp-native-crash-[a-zA-Z0-9]{6}$/);
  fs.rmSync(root, { recursive: true, force: true });
 });
 function applyRemote(action, value) {
  const ledger = read();
  assert.ok(Object.hasOwn(counts, action));
  ledger.counts[action]++;
  if (action === 'create') {
   assert.equal(ledger.post, null, 'A second remote create is forbidden');
   ledger.post = { ...value, status: 'draft' };
  } else {
   assert.equal(value.postId, ledger.post.postId);
   assert.equal(value.url, ledger.post.url);
   if (action === 'publish') {
    assert.equal(ledger.post.status, 'draft');
    ledger.post = value;
   } else if (action === 'trash') {
    assert.equal(ledger.post.status, 'publish');
    assert.equal(value.content, ledger.post.content);
    assert.equal(value.title, ledger.post.title);
    ledger.post.status = 'trash';
   } else if (action === 'update') {
    assert.equal(ledger.post.status, 'publish');
    assert.equal(value.status, 'publish');
    assert.equal(value.title, ledger.post.title);
    assert.notEqual(value.content, ledger.post.content);
    ledger.post = value;
   }
  }
  // The parent owns the simulated WordPress ledger. Flush it before sending
  // any response, including when that response will be lost to a hard kill.
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger), { flush: true });
  return ledger.post;
 }
 const launch = options => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
   /^(?:SystemRoot|WINDIR|TMP|TEMP|USERPROFILE|HOME)$/i.test(key)));
  const child = fork(worker, [], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  let output, hit, failure;
  const kill = () => {
   assert.ok(Number.isInteger(child.pid) && child.pid > 0 && child.pid !== process.pid);
   assert.equal(child.kill('SIGKILL'), true);
  };
  const timer = setTimeout(() => {
   failure ||= Error('Synthetic crash worker timed out');
   if (child.exitCode === null && child.signalCode === null) kill();
  }, 15000);
  child.on('error', error => { failure ||= error; });
  child.on('message', message => {
   try {
    if (message.type === 'result') output = message;
    if (message.type === 'failure') failure = Error(message.message);
    if (message.type === 'boundary') {
     assert.equal(message.boundary, options.boundary);
     hit = message.boundary;
     kill();
    }
    if (message.type === 'remote') {
     const result = applyRemote(message.action, message.value);
     if (options.boundary === message.action + ':after-write') {
      hit = options.boundary;
      kill();
     } else child.send({ type: 'remote-result', id: message.id, result });
    }
   } catch (error) {
    failure ||= error;
    if (child.exitCode === null && child.signalCode === null && !child.killed) kill();
   }
  });
  child.once('exit', (code, signal) => {
   clearTimeout(timer);
   try {
    if (failure) throw failure;
    if (options.boundary) {
     assert.equal(hit, options.boundary, 'Expected crash boundary must be reached');
     assert.equal(signal, 'SIGKILL');
     assert.equal(output, undefined, 'The worker must not complete or close its service');
    } else {
     assert.equal(code, 0);
     assert.ok(output);
    }
    resolve(output);
   } catch (error) { reject(error); }
  });
  child.send({ root, operation, ...options });
 });
 return { read, launch };
}

function preserve(output) {
 assert.equal(output.run.pageId, output.ids.pageId);
 assert.equal(output.run.requestId, output.ids.requestId);
 if (!output.run.destinationHistory?.length) assert.deepEqual(output.run.publicationApproval, output.ids.approval);
}

for (const operation of ['publish', 'trash', 'update']) {
 for (const boundary of boundaries) {
  test('hard process crash ' + operation + ' ' + boundary, { timeout: 35000 }, async t => {
   const f = fixture(t, operation);
   await f.launch({ start: true, boundary: operation + ':' + boundary });
   const interrupted = f.read();
   const wasWritten = boundary === 'after-write' || boundary === 'after-receipt';
   assert.equal(interrupted.counts.create, 1);
   assert.equal(interrupted.counts[operation], Number(wasWritten));
   if (operation === 'publish' && boundary === 'after-write') {
    const held = await f.launch({ ticks: 2 });
    assert.equal(held.owner.id, held.ids.runId);
    assert.deepEqual(f.read(), interrupted, 'An unexpired lease still owns its exact remote identity');
   }
   const unknown = boundary === 'after-dispatch';
   const recovered = await f.launch({
    elapsed: expired, reconcile: operation === 'update' && boundary !== 'before-send',
    // A read of the same draft after dispatch is still ambiguous. Exercise
    // Continue as well as automatic restart so it cannot trigger a replay.
    resume: operation === 'publish' && unknown,
   });
   preserve(recovered);
   const final = f.read();
   assert.equal(final.counts.create, 1);
   assert.equal(final.counts[operation], unknown ? 0 : 1);
   if (unknown) {
    assert.equal(recovered.owner.id, recovered.ids.updateId || recovered.ids.runId);
    assert.equal((recovered.update || recovered.run).state, 'uncertain');
    assert.equal(operation === 'update' ? recovered.update.phase :
     operation === 'trash' ? recovered.run.nativeCleanup.phase : recovered.run.nativePublication.phase, 'dispatching');
   } else if (operation === 'trash') {
    assert.equal(final.post.status, 'trash');
    assert.equal(final.post.content, recovered.ids.html);
    const history = recovered.run.destinationHistory.at(-1);
    assert.equal(history.nativeCleanup.postId, final.post.postId);
    assert.equal(history.nativeCleanup.phase, 'trashed');
    assert.equal(history.nativeSnapshot.materialHash, recovered.ids.approval.materialHash);
    assert.equal(recovered.page.wpId, null);
   } else {
    assert.equal(final.post.content, recovered.ids.updatedHtml || recovered.ids.html);
    assert.equal(recovered.page.remoteSnapshot.content, final.post.content);
    assert.equal(recovered.page.wpId, final.post.postId);
    assert.equal((recovered.update || recovered.run).state, 'completed');
    assert.equal(recovered.owner, null);
   }
  });
 }
}

test('hard crash after remote draft creation cannot create or guess a second post ID', { timeout: 35000 }, async t => {
 const f = fixture(t, 'publish');
 await f.launch({ start: true, boundary: 'create:after-write' });
 const recovered = await f.launch({ elapsed: expired, reconcile: true, resume: true });
 preserve(recovered);
 assert.deepEqual(recovered.run.nativePublication, { postId: null, phase: 'creating' });
 assert.equal(recovered.owner.id, recovered.ids.runId);
 assert.deepEqual(f.read().counts, { create: 1, publish: 0, trash: 0, update: 0, read: 0 });
});

for (const boundary of ['before-send', 'after-write']) {
 for (const tamper of ['id', 'source', 'material']) {
  test('hard crash ' + boundary + ' rejects altered native update ' + tamper, { timeout: 35000 }, async t => {
   const f = fixture(t, 'update');
   await f.launch({ start: true, boundary: 'update:' + boundary });
   const interrupted = f.read();
   const recovered = await f.launch({ elapsed: expired, reconcile: true, tamper });
   assert.equal(recovered.reconciliation.status, 409);
   assert.equal(recovered.update.state, 'uncertain');
   assert.equal(recovered.owner.id, recovered.ids.updateId);
   assert.deepEqual(f.read(), interrupted);
  });
 }
}

test('repeated process crashes before Update respect the same job attempt cap', { timeout: 35000 }, async t => {
 const f = fixture(t, 'update');
 await f.launch({ start: true, boundary: 'update:before-send' });
 await f.launch({ elapsed: expired, boundary: 'update:before-send' });
 await f.launch({ elapsed: expired * 2, boundary: 'update:before-send' });
 const recovered = await f.launch({ elapsed: expired * 3 });
 preserve(recovered);
 assert.equal(recovered.job.attempt, 3);
 assert.equal(recovered.job.state, 'uncertain');
 assert.equal(recovered.owner.id, recovered.ids.updateId);
 assert.equal(f.read().counts.update, 0);
});
