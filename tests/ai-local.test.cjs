"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { createLocalServer } = require('../server/local.cjs');
const KEY = 'sk-test_only_local_memory_01234567890123456789';
const NEXT_KEY = 'sk-test_only_replacement_98765432109876543210';
const requestBody = { requestId: 'local_test_1', brief: { topic: 'User page', language: 'English', instructions: '' }, targets: [{ targetId: 'title_1', field: 'title', maxLength: 500, currentValue: '', context: '' }] };
function mockResult() {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ updates: [{ targetId: 'title_1', value: 'A useful page title' }], notes: [] }) }] }] }), { headers: { 'Content-Type': 'application/json' } });
}
async function setup(t, env = {}) {
  const calls = [];
  const server = await createLocalServer({ env, fetchImpl: async (url, options) => { calls.push({ url, options }); return mockResult(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function read(path, options = {}) {
    const reply = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(3000) });
    const text = await reply.text();
    for (const key of [KEY, NEXT_KEY]) {
      assert.ok(!text.includes(key), 'HTTP response body must not expose an API key');
      assert.ok(!JSON.stringify([...reply.headers]).includes(key), 'HTTP response headers must not expose an API key');
    }
    return { status: reply.status, headers: reply.headers, text, json: () => JSON.parse(text) };
  }
  function connect(apiKey, options = {}) {
    const headers = { 'Content-Type': 'application/json', Origin: origin, ...options.headers };
    for (const [key, value] of Object.entries(headers)) if (value === undefined) delete headers[key];
    const method = options.method || 'POST';
    return read('/api/ai/connect', { method, headers, ...(!['GET', 'HEAD'].includes(method) ? { body: options.raw === undefined ? JSON.stringify({ apiKey }) : options.raw } : {}) });
  }
  return { server, origin, calls, read, connect };
}

test('local connection keeps the key in server memory, forwards it only upstream, and disconnects', { timeout: 10000 }, async t => {
  const env = Object.freeze({});
  const app = await setup(t, env);
  const initial = await app.read('/api/ai/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.json().configured, false);
  assert.equal(initial.json().keyEntryAllowed, true);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(app.calls.length, 0);
  const connected = await app.connect('  ' + KEY + '  ');
  assert.equal(connected.status, 200);
  assert.equal(connected.json().configured, true);
  assert.equal((await app.read('/api/ai/status')).json().configured, true);
  assert.equal(app.calls.length, 0, 'Connecting must not send an unsolicited provider request');
  const generated = await app.read('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin }, body: JSON.stringify(requestBody) });
  assert.equal(generated.status, 200);
  assert.deepEqual(generated.json().updates, [{ targetId: 'title_1', value: 'A useful page title' }]);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(app.calls[0].options.headers.Authorization, 'Bearer ' + KEY);
  assert.ok(!app.calls[0].options.body.includes(KEY));
  assert.deepEqual(env, {});
  const disconnected = await app.connect('');
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.json().configured, false);
  assert.equal((await app.read('/api/ai/status')).json().configured, false);
  const blocked = await app.read('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin }, body: JSON.stringify(requestBody) });
  assert.equal(blocked.status, 503);
  assert.equal(app.calls.length, 1);
});

test('local key changes never mutate caller environment or another server instance', { timeout: 10000 }, async t => {
  const env = Object.freeze({ OPENAI_API_KEY: KEY, OPENAI_MODEL: 'test-configured-model' });
  const app = await setup(t, env);
  const separate = await setup(t, {});
  assert.equal((await app.read('/api/ai/status')).json().model, 'test-configured-model');
  assert.equal((await separate.read('/api/ai/status')).json().configured, false);
  assert.equal((await app.connect(NEXT_KEY)).status, 200);
  const generated = await app.read('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin }, body: JSON.stringify(requestBody) });
  assert.equal(generated.status, 200);
  assert.equal(app.calls[0].options.headers.Authorization, 'Bearer ' + NEXT_KEY);
  assert.equal(env.OPENAI_API_KEY, KEY);
  assert.equal((await separate.read('/api/ai/status')).json().configured, false);
  await app.connect(' ');
  assert.equal((await app.read('/api/ai/status')).json().configured, false);
  assert.equal(env.OPENAI_API_KEY, KEY);
});

test('local key endpoint rejects invalid requests without changing configuration', { timeout: 10000 }, async t => {
  const app = await setup(t);
  await app.connect(KEY);
  const cases = [
    ['GET', { method: 'GET' }, 405],
    ['PUT', { method: 'PUT' }, 405],
    ['foreign Origin', { headers: { Origin: 'https://foreign.example' } }, 403],
    ['null Origin', { headers: { Origin: 'null' } }, 403],
    ['missing Origin', { headers: { Origin: undefined } }, 403],
    ['form content type', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 415],
    ['malformed JSON', { raw: '{malformed' }, 400],
    ['numeric key', { raw: JSON.stringify({ apiKey: 123 }) }, 400],
    ['missing key', { raw: '{}' }, 400],
    ['invalid key format', { raw: JSON.stringify({ apiKey: 'short' }) }, 400],
    ['too short key', { raw: JSON.stringify({ apiKey: 'sk-short' }) }, 400],
    ['too long key', { raw: JSON.stringify({ apiKey: 'sk-' + 'a'.repeat(510) }) }, 400],
    ['oversized request', { raw: JSON.stringify({ apiKey: NEXT_KEY, extra: 'x'.repeat(4096) }) }, 413]
  ];
  for (const [label, options, status] of cases) await t.test(label, async () => {
    const reply = await app.connect(NEXT_KEY, options);
    assert.equal(reply.status, status);
    assert.equal((await app.read('/api/ai/status')).json().configured, true);
  });
  const generated = await app.read('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin }, body: JSON.stringify(requestBody) });
  assert.equal(generated.status, 200);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].options.headers.Authorization, 'Bearer ' + KEY);
});

test('static HTTP surface exposes only public assets and never the connected key or private files', { timeout: 10000 }, async t => {
  const app = await setup(t);
  await app.connect(KEY);
  for (const name of ['/', '/index.html', '/styles.css', '/generator.js', '/app.js', '/ai-core.js', '/ai-ui.js', '/PagePoster.html']) {
    const reply = await app.read(name);
    assert.equal(reply.status, 200, name);
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const name of ['/.env', '/server/local.cjs', '/server/ai.mjs', '/package.json', '/.git/config', '/dist/index.html', '/%2e%2e%2f.env', '/styles.css/../.env']) {
    const reply = await app.read(name);
    assert.equal(reply.status, 404, name);
  }
  // Fetch normalizes Host on some Node versions; use raw HTTP to test the actual header.
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/ai/status', headers: { Host: 'foreign.example' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost.status, 403);
  assert.ok(!badHost.body.includes(KEY));
  assert.equal(app.calls.length, 0);
});
