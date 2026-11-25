'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');

const origin = 'https://crash-native.example/';
const postId = 801;
const publicUrl = origin + 'published/';
const html = '<h1>Crash page</h1><p><a href="https://old.example/?x=%2F&amp;x=2">Original</a></p>';
const forbidden = () => assert.fail('Process-crash fixture has no external provider or WordPress transport');
globalThis.fetch = forbidden;

async function main([options]) {
 const root = fs.realpathSync(options.root);
 assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
 assert.match(path.basename(root), /^pp-native-crash-[a-zA-Z0-9]{6}$/);
 const file = path.join(root, 'identity.json');
 const dataDir = path.join(root, 'workspace');
 const { createLifecycleService } = await import('../server/lifecycle/service.mjs');
 const { createAIBudget } = await import('../server/lifecycle/ai-budget.mjs');
 const clock = () => 1793700000000 + (options.elapsed || 0);
 fs.mkdirSync(dataDir, { recursive: true });
 const budget = createAIBudget({ filename: path.join(dataDir, 'ai-budget.sqlite'), clock });
 const paidRequest = {
  requestId: 'crash-fixture-paid-identity',
  request: { model: 'gpt-4.1-mini', store: false, input: 'Synthetic prior generation', max_output_tokens: 64 },
 };
 let callId = 0;
 const pending = new Map();
 process.on('message', message => {
  if (message.type !== 'remote-result') return;
  const resolve = pending.get(message.id);
  assert.ok(resolve);
  pending.delete(message.id);
  resolve(message.result);
 });
 const remote = (action, value) => new Promise(resolve => {
  const id = ++callId;
  pending.set(id, resolve);
  process.send({ type: 'remote', id, action, value });
 });
 const stopAt = async boundary => {
  if (options.boundary !== boundary) return;
  process.send({ type: 'boundary', boundary });
  await new Promise(() => {});
 };
 const savedIdentity = saved => {
  assert.equal(saved.postId, postId);
  if (saved.url) assert.equal(saved.url, publicUrl);
 };
 const checkpoint = (input, phase) => input.checkpoint({
  postId, phase, ...(phase === 'published' || input.operationId ? { url: publicUrl } : {}),
  ...(input.operationId ? { operationId: input.operationId } : {}),
 });
 async function dispatch(operation, input, value) {
  await stopAt(operation + ':before-send');
  await checkpoint(input, 'dispatching');
  await stopAt(operation + ':after-dispatch');
  input.beforeSend();
  const result = await remote(operation, value);
  await checkpoint(input, operation === 'trash' ? 'trashed' : 'published');
  await stopAt(operation + ':after-receipt');
  return result;
 }
 async function readPost(input) {
  savedIdentity(input.saved);
  return remote('read', { postId, url: publicUrl });
 }
 const uncertain = code => Object.assign(Error(code), { code, uncertain: true });
 const session = {
  baseUrl: origin, status: async () => {}, login: async () => {},
  ensureCleanLinks: async () => {
   if (options.operation === 'trash') throw Object.assign(Error(), { code: 'CLEAN_LINKS_NOT_INSTALLED' });
  },
  publishPage: async input => {
   if (!input.saved) {
    await input.checkpoint({ postId: null, phase: 'creating' });
    await remote('create', { postId, url: publicUrl });
    await checkpoint(input, 'draft');
   } else savedIdentity(input.saved);
   return dispatch('publish', input, { postId, url: publicUrl, title: input.title, content: input.html, status: 'publish' });
  },
  inspectPublished: async input => {
   const post = await readPost(input);
   if (post.status === 'draft') throw Object.assign(Error(), { code: 'NATIVE_NOT_PUBLISHED' });
   return post;
  },
  async inspectOwnedTrash(input) {
   const post = await readPost(input);
   if (post.title !== input.title || post.content !== input.html || post.postId !== postId) throw uncertain('NATIVE_TRASH_UNCERTAIN');
   return post;
  },
  async trashPublished(input) {
   if (['dispatching', 'trashed'].includes(input.cleanup.phase)) {
    const observed = await session.inspectOwnedTrash(input);
    if (observed.status !== 'trash') throw uncertain('NATIVE_TRASH_UNCERTAIN');
    await checkpoint(input, 'trashed');
    return observed;
   }
   return dispatch('trash', input, { postId, url: publicUrl, title: input.title, content: input.html });
  },
  async updatePublished(input) {
   const post = await readPost(input);
   assert.equal(post.content, input.before.content);
   await checkpoint(input, 'prepared');
   return dispatch('update', input, input.after);
  },
  async reconcileUpdate(input) {
   const post = await readPost(input);
   if (['postId', 'url', 'title', 'content', 'status'].some(field => post[field] !== input.after[field])) {
    throw uncertain('NATIVE_UPDATE_UNCERTAIN');
   }
   await checkpoint(input, 'published');
   return post;
  },
 };
 const browser = {
  nativeEditor: true, prepare: async () => {}, open: async (_, url) => {
   assert.equal(url, origin);
   return session;
  },
  assertOpen: () => {}, result: async () => {}, reset: async () => {},
  done: async () => {}, error: async () => {}, close: async () => {},
 };
 const service = await createLifecycleService({
  dataDir, masterKey: Buffer.alloc(32, 42).toString('base64'),
  clock, visibleBrowser: browser, ai: { handler: forbidden, budget },
  autopilotOptions: { bootstrapFactory: forbidden }, bridgeClient: { checkStatus: forbidden },
  client: {
   checkSite: forbidden,
   checkPage: async input => {
    assert.equal(input.publicOnly, true);
    assert.equal(input.page.wpId, postId);
    return ['public', 'content', 'noindex', 'robots', 'links'].map(kind => ({ kind, state: 'ok', evidence: 'synthetic' }));
   },
  },
  browserVerifier: { verifyPublished: async input => ({
   state: 'ok', viewports: [],
   ...(input.compareVisual ? { visual: { state: 'problem', code: 'fixture_visual_problem',
    viewports: [{ name: 'desktop', state: 'problem', code: 'fixture_visual_problem' }] } } : {}),
  }) },
 });
 const { store } = service;
 const q = async (route, body) => {
  const response = await service.handle(new Request('http://localhost/api/lifecycle' + route, {
   method: body === undefined ? 'GET' : 'POST',
   headers: { Origin: 'http://localhost', 'X-PagePoster-Request': '1', 'Content-Type': 'application/json' },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, ...await response.json() };
 };
 const ticks = async count => {
  for (let i = 0; i < count; i++) await service.tick();
 };
 let ids;
 try {
  if (options.start) {
   const project = store.createProject({ name: 'Crash fixture', monitoringPolicy: { enabled: false } });
   const input = { source: 'html', html, chromeMode: 'overlay-only' };
   const preview = await q('/autopilot/preview', input);
   const launched = await q('/projects/' + project.id + '/autopilot', {
    ...input, idempotencyKey: randomUUID(), reviewToken: preview.reviewToken, reviewBeforePublish: true,
   });
   assert.equal(launched.status, 202);
   const runId = launched.run.id;
   await ticks(1);
   const run = store.getRecord(runId);
   const reserved = budget.reserve(paidRequest);
   const receipt = budget.complete(paidRequest.requestId, reserved.reservationToken, {
    result: { title: 'Synthetic prior generation' }, usage: { input_tokens: 15, output_tokens: 9 },
   });
   store.updateRecord(run.id, { requestId: paidRequest.requestId }, run.revision);
   assert.equal((await q('/autopilot/' + runId + '/destination', { baseUrl: origin, username: 'fixture', password: 'fixture' })).status, 200);
   const ready = await q('/autopilot/' + runId + '/html');
   assert.equal((await q('/autopilot/' + runId + '/approve', { reviewToken: ready.reviewToken })).status, 202);
   const approved = store.getRecord(runId);
   ids = { runId, pageId: approved.pageId, projectId: project.id, requestId: approved.requestId, receipt, approval: approved.publicationApproval, html: ready.html };
   fs.writeFileSync(file, JSON.stringify(ids));
   if (options.operation === 'update') {
    await ticks(10);
    assert.equal(store.getRecord(runId).state, 'completed', JSON.stringify(store.getRecord(runId).error));
    const page = store.getPage(ids.pageId);
    const place = service.nativeReplacements.placements(page).placements[0];
    assert.ok(place);
    const proposal = service.nativeReplacements.prepareReplacement(page.id, {
     expectedRevision: page.revision,
     changes: [{ id: place.id, url: 'https://new.example/?b=%2F&a=2', expectedUrl: place.url, expectedAnchor: place.anchor, expectedBinding: place.binding }],
    });
    const job = service.nativeReplacements.confirmReplacement(proposal.id, { expectedRevision: proposal.revision, confirmed: true });
    Object.assign(ids, { jobId: job.id, updateId: job.payload.nativeUpdateId, updatedHtml: job.payload.after.content });
    fs.writeFileSync(file, JSON.stringify(ids));
   }
  } else {
   ids = JSON.parse(fs.readFileSync(file, 'utf8'));
   if (options.tamper === 'source') {
    const run = store.getRecord(ids.runId);
    store.updateRecord(run.id, { destinationRevision: (run.destinationRevision || 0) + 1 }, run.revision);
   } else if (options.tamper === 'material') {
    const page = store.getPage(ids.pageId);
    store.updatePage(page.id, { title: 'Changed local title' }, page.revision);
   } else if (options.tamper === 'id') {
    const page = store.getPage(ids.pageId);
    store.updatePage(page.id, { wpId: postId + 1 }, page.revision);
   }
  }
  await ticks(options.start ? 15 : options.ticks ?? 8);
  if (options.start) assert.fail('Unreached boundary: ' + JSON.stringify(service.autopilot.list(ids.projectId).map(({ state, stage, error }) => ({ state, stage, error }))));
  let reconciliation, resumed;
  if (options.reconcile) {
   if (ids.jobId) reconciliation = await q('/jobs/' + ids.jobId + '/reconcile', {});
   else {
    const current = store.getRecord(ids.runId);
    reconciliation = await q('/autopilot/' + ids.runId + '/reconcile', { expectedRevision: current.revision });
   }
  }
  if (options.resume) resumed = await q('/autopilot/' + ids.runId + '/resume', {});
  if (options.reconcile || options.resume) await ticks(8);
  const run = store.getRecord(ids.runId);
  const page = store.getPage(ids.pageId);
  const owner = service.autopilot.publicationTurn.owner();
  const update = ids.updateId && store.getRecord(ids.updateId);
  const job = ids.jobId && store.getJob(ids.jobId);
  assert.equal(budget.getRequest(ids.requestId).state, 'completed');
  assert.deepEqual(budget.reserve(paidRequest), ids.receipt);
  process.send({ type: 'result', ids, run, page, owner, update, job,
   reconciliation: reconciliation && { status: reconciliation.status, observation: reconciliation.observation },
   resumed: resumed?.status });
 } finally {
  await service.close();
  budget.close();
 }
 process.disconnect();
}

once(process, 'message').then(main).catch(error => {
 if (process.connected) process.send({ type: 'failure', message: error.stack || error.message });
 process.exitCode = 1;
 process.disconnect?.();
});
