"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../server/ai.mjs');
const ORIGIN = 'http://localhost:4317';
const KEY = 'test-only-secret-never-return-this';
const env = { OPENAI_API_KEY: KEY };
function input() {
  return { requestId: 'request_1-A', brief: { topic: 'A considered comparison', language: 'English', instructions: 'Clear useful prose' }, targets: [
    { targetId: 'title_1', field: 'title', label: 'Page title', maxLength: 500, currentValue: '', context: { name: 'User Brand', url: 'https://destination.example/offer?affiliate=keep' } },
    { targetId: 'body_1', field: 'body', label: 'An article section', maxLength: 50000, currentValue: 'Existing copy', context: '' }
  ] };
}
function request(value = input(), options = {}) {
  return new Request(ORIGIN + (options.path || '/api/ai/generate'), {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...options.headers },
    ...(options.method === 'GET' ? {} : { body: options.raw === undefined ? JSON.stringify(value) : options.raw }),
    ...(options.signal ? { signal: options.signal } : {})
  });
}
function result(value = input()) {
  return { updates: value.targets.map(t => ({ targetId: t.targetId, value: t.field === 'title' ? 'A clear comparison' : 'Useful original copy with **context**.' })), notes: [] };
}
function envelope(value = result()) {
  return { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
}
function response(value = envelope(), status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
async function invoke(value, responseValue = envelope()) {
  const { createAIHandler } = await modulePromise;
  const handle = createAIHandler({ fetchImpl: async () => response(responseValue) });
  const reply = await handle(request(value), env);
  return { status: reply.status, body: await reply.json() };
}
function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

test('AI status reports configuration without exposing credentials or making requests', async () => {
  const { createAIHandler } = await modulePromise;
  let calls = 0;
  const handle = createAIHandler({ fetchImpl: async () => { calls++; throw new Error('Unexpected network call'); } });
  for (const [settings, configured] of [[{}, false], [{ OPENAI_API_KEY: '  ' }, false], [env, true]]) {
    const reply = await handle(request(undefined, { method: 'GET', path: '/api/ai/status' }), settings);
    assert.equal(reply.status, 200);
    const text = await reply.text();
    assert.equal(JSON.parse(text).configured, configured);
    assert.ok(!text.includes(KEY));
    assert.equal(reply.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls, 0);
});

test('generation without a configured API key leaves the upstream untouched', async () => {
  const { createAIHandler } = await modulePromise;
  let calls = 0;
  const handle = createAIHandler({ fetchImpl: async () => { calls++; } });
  const reply = await handle(request(), {});
  assert.equal(reply.status, 503);
  assert.equal(calls, 0);
  assert.equal(typeof (await reply.json()).error, 'string');
});

test('rejects unsupported methods, paths, media types and cross-origin writes before fetching', async t => {
  const { createAIHandler } = await modulePromise;
  for (const [label, options, status] of [
    ['GET generation', { method: 'GET' }, 405],
    ['unknown path', { path: '/api/ai/other' }, 404],
    ['wrong content type', { headers: { 'Content-Type': 'text/plain' } }, 415],
    ['foreign origin', { headers: { Origin: 'https://foreign.example' } }, 403],
    ['null origin', { headers: { Origin: 'null' } }, 403]
  ]) await t.test(label, async () => {
    let calls = 0;
    const handle = createAIHandler({ fetchImpl: async () => { calls++; } });
    const reply = await handle(request(input(), options), env);
    assert.equal(reply.status, status);
    assert.equal(calls, 0);
    assert.equal(reply.headers.get('access-control-allow-origin'), null);
  });
});

test('sends one bounded Responses request with strict output, store:false, and no URL-fetching tools', async () => {
  const { createAIHandler } = await modulePromise;
  const calls = [];
  const handle = createAIHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  const reply = await handle(request(), { ...env, OPENAI_MODEL: 'configured-test-model' });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { requestId: input().requestId, ...result() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  const { options } = calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer ' + KEY);
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'configured-test-model');
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.properties.updates.items.properties.targetId.enum, ['title_1', 'body_1']);
  const supplied = JSON.parse(body.input);
  assert.equal(supplied.targets[1].currentValue, 'Existing copy');
  assert.equal(JSON.parse(supplied.targets[0].context).url, input().targets[0].context.url);
  assert.ok(!options.body.includes(KEY));
  assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
});

test('accepts documented input boundaries and strips non-contract fields', async () => {
  const { validateInput } = await modulePromise;
  const value = input();
  value.targets = Array.from({ length: 24 }, (_, i) => ({ targetId: 'field_' + i, field: 'body', maxLength: 50000, currentValue: 'x'.repeat(50000), extra: 'do not send' }));
  value.extra = 'do not send';
  const checked = validateInput(value);
  assert.equal(checked.targets.length, 24);
  assert.equal(checked.targets[0].currentValue.length, 50000);
  assert.equal(checked.extra, undefined);
  assert.equal(checked.targets[0].extra, undefined);
});

test('accepts qualified text fields without accepting protected sibling fields', async () => {
  const { validateInput } = await modulePromise;
  const fields = ['title', 'cards.bonus', 'moreCards.features', 'sections.body', 'faq.question', 'faq.answer', 'tiles.name', 'services.body', 'reviews.title'];
  const value = input();
  value.targets = fields.map((field, index) => ({ targetId: 'qualified_' + index, field, maxLength: 500, currentValue: '' }));
  const checked = validateInput(value);
  assert.deepEqual(checked.targets.map(target => target.field), fields);
  const reply = await invoke(value, envelope(result(value)));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.updates.length, fields.length);
});

test('rejects invalid target IDs, protected fields and unreasonable input sizes', async t => {
  const { validateInput } = await modulePromise;
  const cases = [
    ['no targets', v => v.targets = []],
    ['too many targets', v => v.targets = Array.from({ length: 25 }, (_, i) => ({ ...v.targets[0], targetId: 't_' + i }))],
    ['bad request ID', v => v.requestId = '../request'],
    ['duplicate target ID', v => v.targets[1].targetId = v.targets[0].targetId],
    ['path as target ID', v => v.targets[0].targetId = 'cards.0.title'],
    ['URL destination', v => v.targets[0].field = 'url'],
    ['image URL', v => v.targets[0].field = 'image'],
    ['rating', v => v.targets[0].field = 'rating'],
    ['qualified style field', v => v.targets[0].field = 'colors.background'],
    ['author identity', v => v.targets[0].field = 'author'],
    ['date metadata', v => v.targets[0].field = 'date'],
    ['qualified rating', v => v.targets[0].field = 'cards.rating'],
    ['qualified offer URL', v => v.targets[0].field = 'cards.url'],
    ['qualified image URL', v => v.targets[0].field = 'sections.image'],
    ['qualified unknown collection', v => v.targets[0].field = 'unknown.body'],
    ['prototype key', v => v.targets[0].field = '__proto__'],
    ['zero field limit', v => v.targets[0].maxLength = 0],
    ['excessive field limit', v => v.targets[0].maxLength = 50001],
    ['non-integer limit', v => v.targets[0].maxLength = 1.5],
    ['numeric current value', v => v.targets[0].currentValue = 5],
    ['long context', v => v.targets[0].context = 'x'.repeat(12001)],
    ['context array', v => v.targets[0].context = []],
    ['long topic', v => v.brief.topic = 'x'.repeat(1001)],
    ['long instructions', v => v.brief.instructions = 'x'.repeat(6001)]
  ];
  for (const [label, mutate] of cases) await t.test(label, () => {
    const value = input(); mutate(value);
    assert.throws(() => validateInput(value), error => error.status === 400);
  });
});

test('rejects malformed JSON and actual or announced oversized request bodies before fetching', async t => {
  const { createAIHandler } = await modulePromise;
  for (const [label, options, status] of [
    ['malformed JSON', { raw: '{broken' }, 400],
    ['announced oversized body', { headers: { 'Content-Length': String(256 * 1024 + 1) } }, 413],
    ['actual oversized body', { raw: 'x'.repeat(256 * 1024 + 1) }, 413],
    ['multibyte body bound is bytes', { raw: JSON.stringify({ extra: 'Ж'.repeat(140000) }) }, 413]
  ]) await t.test(label, async () => {
    let calls = 0;
    const handle = createAIHandler({ fetchImpl: async () => { calls++; } });
    const reply = await handle(request(input(), options), env);
    assert.equal(reply.status, status);
    assert.equal(calls, 0);
  });
});

test('maps upstream errors without echoing API keys or provider payloads', async t => {
  const { createAIHandler } = await modulePromise;
  for (const status of [400, 401, 403, 404, 429, 500, 503]) await t.test(String(status), async () => {
    const handle = createAIHandler({ fetchImpl: async () => response({ error: { message: 'Provider detail ' + KEY } }, status) });
    const reply = await handle(request(), env);
    assert.equal(reply.status, status === 429 ? 429 : 502);
    const text = await reply.text();
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes('Provider detail'));
    assert.deepEqual(Object.keys(JSON.parse(text)), ['error','code','diagnostics']);
    assert.deepEqual(JSON.parse(text).diagnostics,{httpStatus:status,model:'gpt-5.4-mini'});
    assert.equal(JSON.parse(text).code,({400:'AI_REQUEST_INVALID',401:'AI_AUTH_FAILED',403:'AI_ACCESS_DENIED',404:'AI_MODEL_UNAVAILABLE',429:'AI_RATE_LIMITED'})[status]||'AI_PROVIDER_UNAVAILABLE');
  });
  await t.test('network exception', async () => {
    const handle = createAIHandler({ fetchImpl: async () => { throw new Error('Bearer ' + KEY); } });
    const reply = await handle(request(), env);
    assert.equal(reply.status, 502);
    assert.ok(!(await reply.text()).includes(KEY));
  });
});

test('rejects refusals, unfinished responses and invalid provider envelopes', async t => {
  const cases = [
    ['incomplete', { status: 'incomplete', output: [] }, 502],
    ['failed', { status: 'failed', output: [] }, 502],
    ['missing completion status', { output: [] }, 502],
    ['refusal', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Refused' }] }] }, 422],
    ['missing output', { status: 'completed' }, 502],
    ['malformed output JSON', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{unfinished' }] }] }, 502]
  ];
  for (const [label, payload, status] of cases) await t.test(label, async () => {
    const reply = await invoke(input(), payload);
    assert.equal(reply.status, status);
    assert.deepEqual(Object.keys(reply.body), label==='refusal'?['error','code']:['error']);
    if(label==='refusal')assert.equal(reply.body.code,'AI_REFUSED');
  });
});

test('only accepts a complete unique update for each requested field within its bound', async t => {
  const cases = [
    ['extra output property', v => v.url = 'https://unexpected.example'],
    ['missing target', v => v.updates.pop()],
    ['extra target', v => v.updates.push({ targetId: 'other', value: 'x' })],
    ['unknown target ID', v => v.updates[0].targetId = 'other'],
    ['duplicate target ID', v => v.updates[1].targetId = v.updates[0].targetId],
    ['non-string value', v => v.updates[0].value = 123],
    ['null item', v => v.updates[0] = null],
    ['extra item property', v => v.updates[0].url = 'https://unexpected.example'],
    ['oversized field', v => v.updates[0].value = 'x'.repeat(501)],
    ['notes not array', v => v.notes = 'note'],
    ['non-string note', v => v.notes = [42]],
    ['too many notes', v => v.notes = Array(21).fill('note')],
    ['oversized note', v => v.notes = ['x'.repeat(2001)]]
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const value = result(); mutate(value);
    const reply = await invoke(input(), envelope(value));
    assert.equal(reply.status, 502);
    assert.deepEqual(Object.keys(reply.body), ['error']);
  });
  await t.test('empty text and reordered updates remain valid text suggestions', async () => {
    const value = result(); value.updates.reverse(); value.updates[0].value = ''; value.notes = ['Details were not provided.'];
    const reply = await invoke(input(), envelope(value));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.updates, value.updates);
  });
});

test('rejects invalid JSON or oversized upstream response bodies without returning them', async t => {
  const { createAIHandler } = await modulePromise;
  for (const [label, payload] of [['invalid JSON', '{' + KEY], ['oversized', 'x'.repeat(1024 * 1024 + 1) + KEY]]) await t.test(label, async () => {
    const handle = createAIHandler({ fetchImpl: async () => new Response(payload) });
    const reply = await handle(request(), env);
    assert.equal(reply.status, 502);
    assert.ok(!(await reply.text()).includes(KEY));
  });
});

test('timeout aborts upstream and releases the active slot for a subsequent request', { timeout: 3000 }, async () => {
  const { createAIHandler } = await modulePromise;
  let calls = 0;
  let aborted = false;
  const handle = createAIHandler({ timeoutMs: 20, fetchImpl: async (url, options) => {
    if (calls++ === 0) { try { return await waitForAbort(options.signal); } finally { aborted = options.signal.aborted; } }
    return response();
  } });
  const first = await handle(request(), env);
  assert.equal(first.status, 504);
  assert.equal(aborted, true);
  assert.equal((await handle(request(), env)).status, 200);
});

test('client cancellation aborts upstream and pre-cancelled requests never fetch', { timeout: 3000 }, async () => {
  const { createAIHandler } = await modulePromise;
  let calls = 0;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const handle = createAIHandler({ fetchImpl: async (url, options) => { calls++; started(); return waitForAbort(options.signal); } });
  const controller = new AbortController();
  const pending = handle(request(input(), { signal: controller.signal }), env);
  await start;
  controller.abort();
  assert.equal((await pending).status, 499);
  const before = calls;
  assert.equal((await handle(request(input(), { signal: controller.signal }), env)).status, 499);
  assert.equal(calls, before);
});

test('concurrent dispatch reserves at most two upstream requests, including while bodies are read', { timeout: 3000 }, async () => {
  const { createAIHandler } = await modulePromise;
  const releases = [];
  const handle = createAIHandler({ fetchImpl: () => new Promise(resolve => releases.push(() => resolve(response()))) });
  const pending = Array.from({ length: 3 }, () => handle(request(), env));
  await new Promise(resolve => setImmediate(resolve));
  const count = releases.length;
  for (const release of releases) release();
  const replies = await Promise.all(pending);
  assert.equal(count, 2, 'Only two generation calls may reach the upstream concurrently');
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 200, 429]);
});


test('AI response cannot add, replace or remove Markdown link destinations', async t => {
  for (const [label, before, after] of [
    ['new URL', 'Existing copy', 'Read [more](https://unprovided.example/extra).'],
    ['image-style URL', '', '![Logo](https://unprovided.example/logo.png)'],
    ['nested URL parentheses', '', '[Details](https://unprovided.example/(extra)?x=1&y=2)'],
    ['changed tracking query', '[Offer](https://example.com/?offer=1669)', '[Offer](https://example.com/?offer=1661)'],
    ['removed manual link', '[Offer](https://example.com/?offer=1669)', 'An offer without the supplied link.'],
    ['bold changes link into literal text', '[Offer](https://example.com/**path)', '**[Offer](https://example.com/**path)']
  ]) await t.test(label, async () => {
    const value=input(); value.targets[1].currentValue=before;
    const output=result(value); output.updates[1].value=after;
    const reply=await invoke(value,envelope(output));
    assert.equal(reply.status,502);
    assert.match(reply.body.error,/посилан/i);
    assert.equal(reply.body.updates,undefined);
  });
  for (const [before, after] of [
    ['[Old label](https://example.com/(path)?offer=1669&x=%2F#top)', 'New copy with [Old label](https://example.com/(path)?offer=1669&x=%2F#top).'],
    ['[Manual](https://example.com/?offer=1669)', '   '],
    ['', 'Compare [options] (where available), prices (including tax), and **details**. Ordinary punctuation (including tax) is text.']
  ]) {
    const value=input(); value.targets[1].currentValue=before;
    const output=result(value); output.updates[1].value=after;
    const reply=await invoke(value,envelope(output));
    assert.equal(reply.status,200);
    assert.equal(reply.body.updates[1].value,after);
  }
});
test('provider 403 reports denied access without asserting a specific private provider cause',async()=>{
 const {createAIHandler}=await modulePromise;let calls=0;const handle=createAIHandler({fetchImpl:async()=>{calls++;return response({error:{message:'private fixture diagnostic',code:'permission_denied'}},403);}});const reply=await handle(request(),env),body=await reply.json();assert.equal(reply.status,502);assert.equal(body.code,'AI_ACCESS_DENIED');assert.match(body.error,/403/);assert.doesNotMatch(body.error,/Цей ключ не має доступу|private fixture diagnostic/);assert.equal(calls,1);
});

test('403 model_not_found identifies inaccessible model without leaking provider text',async()=>{
 const {createAIHandler}=await modulePromise;
 const handle=createAIHandler({fetchImpl:async()=>new Response(JSON.stringify({error:{code:'model_not_found',type:'invalid_request_error',message:'Project proj_private has no access. '+KEY}}),{status:403,headers:{'x-request-id':'req_fixture403'}})});
 const r=await handle(request(),env),b=await r.json();assert.equal(b.code,'AI_MODEL_UNAVAILABLE');assert.equal(b.diagnostics.providerCode,'model_not_found');assert.equal(b.diagnostics.httpStatus,403);assert.equal(b.diagnostics.model,'gpt-5.4-mini');assert.equal(b.diagnostics.requestId,'req_fixture403');assert.match(b.error,/gpt-5\.4-mini/);assert.doesNotMatch(JSON.stringify(b),/proj_private|test-only-secret/);
});
test('provider diagnostics distinguish region refusal and discard oversized or non-JSON bodies',async()=>{
 const {createAIHandler}=await modulePromise;
 for(const [body,expected] of [[JSON.stringify({error:{code:'unsupported_country_region_territory',message:KEY}}),'AI_REGION_UNSUPPORTED'],['<html>'+KEY+'</html>','AI_ACCESS_DENIED'],[JSON.stringify({error:{code:'model_not_found',message:'x'.repeat(30000)}}),'AI_ACCESS_DENIED']]){
 const r=await createAIHandler({fetchImpl:async()=>new Response(body,{status:403})})(request(),env);const b=await r.json();assert.equal(b.code,expected);assert.doesNotMatch(JSON.stringify(b),/test-only-secret/);
 }
});
test('model connection check performs only a model lookup and rejects cross-origin calls',async()=>{
 const {createAIHandler}=await modulePromise;let calls=0;const h=createAIHandler({fetchImpl:async(url,opts)=>{calls++;assert.equal(url,'https://api.openai.com/v1/models/gpt-4.1-mini');assert.equal(opts.method,'GET');return response({id:'gpt-4.1-mini'});}});
 const good=await h(request({}, {path:'/api/ai/check'}),{...env,OPENAI_MODEL:'gpt-4.1-mini'});assert.equal(good.status,200);assert.equal((await good.json()).modelAccessible,true);
 const bad=await h(request({}, {path:'/api/ai/check',headers:{Origin:'https://outside.example'}}),env);assert.equal(bad.status,403);assert.equal(calls,1);
});
