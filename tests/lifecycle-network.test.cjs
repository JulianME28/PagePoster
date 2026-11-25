'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const mod = import('../server/lifecycle/network.mjs');
function wire(replies, calls = []) {
  return (url, options, receive) => {
    calls.push({ url: String(url), options });
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = body => { calls[calls.length-1].body=body; return queueMicrotask(() => {
      const reply = replies.shift();
      if (!reply) return req.emit('error', new Error('unexpected request'));
      if (reply.hang) return;
      const res = new PassThrough();
      res.statusCode = reply.status || 200; res.headers = reply.headers || {}; res.rawHeaders = reply.rawHeaders;
      receive(res);
      if (reply.chunks) for (const chunk of reply.chunks) res.write(chunk);
      res.end(reply.body || '');
    }); };
    return req;
  };
}
const dns = async () => [{ address: '93.184.216.34', family: 4 }];
test('safe network rejects private, special and mapped addresses before opening a socket', async () => {
  const { createSafeTransport } = await mod;
  for (const address of ['0.0.0.0','10.1.2.3','127.0.0.1','100.64.0.1','169.254.169.254','172.31.2.4','192.168.1.2','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::a00:1','2002:7f00:1::','2001:db8::1','2001::1']) {
    let calls = 0;
    const transport = createSafeTransport({ lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], request: () => { calls++; } });
    await assert.rejects(transport('https://public.example/'), { code: 'unsafe_address' }, address);
    assert.equal(calls, 0, address);
  }
});
test('URLs cannot smuggle credentials, alternate local-IP notation, non-HTTPS or local hostnames', async () => {
  const { createSafeTransport } = await mod;
  let calls = 0;
  const transport = createSafeTransport({ lookup: dns, request: () => { calls++; } });
  for (const url of ['http://example.com','file:///etc/passwd','https://user:secret@example.com','https://127.1','https://2130706433','https://0x7f000001','https://[::1]/','https://localhost/','https://foo.local/','https://metadata.google.internal/','https://example.com/\nsecret']) {
    await assert.rejects(transport(url), error => ['unsafe_url','unsafe_address'].includes(error.code), url);
  }
  assert.equal(calls, 0);
});
test('all DNS results are checked and the approved IP is pinned to each connection', async () => {
  const { createSafeTransport } = await mod;
  let dnsCalls = 0; const calls = [];
  const transport = createSafeTransport({ lookup: async () => { dnsCalls++; return dns(); }, request: wire([{ body: 'ok' }], calls) });
  assert.equal((await transport('https://public.example/path?q=exact%2f')).text, 'ok');
  assert.equal(dnsCalls, 1);
  const options = calls[0].options;
  assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
  for (let i = 0; i < 2; i++) {
    const ip = await new Promise((resolve, reject) => options.lookup('public.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(ip, { address: '93.184.216.34', family: 4 });
  }
  assert.equal(dnsCalls, 1);
  const mixed = createSafeTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], request: () => assert.fail('mixed DNS response opened a socket') });
  await assert.rejects(mixed('https://public.example'), { code: 'unsafe_address' });
});
test('cross-origin redirects permanently strip credentials and every hop revalidates DNS', async () => {
  const { createSafeTransport } = await mod;
  const calls = [], resolved = [];
  const transport = createSafeTransport({ lookup: async host => { resolved.push(host); return dns(); }, request: wire([
    { status: 302, headers: { location: 'https://other.example/two' } },
    { status: 302, headers: { location: 'https://public.example/three' } },
    { body: 'done' }
  ], calls) });
  const result = await transport('https://public.example/one', { headers: { Authorization: 'Basic secret', Cookie: 'session=secret', 'Proxy-Authorization': 'secret' } });
  assert.equal(result.url, 'https://public.example/three');
  assert.equal(calls[0].options.headers.authorization, 'Basic secret');
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.authorization, undefined); assert.equal(call.options.headers.cookie, undefined); assert.equal(call.options.headers['proxy-authorization'], undefined);
  }
  assert.deepEqual(resolved, ['public.example','other.example','public.example']);
  const unsafe = createSafeTransport({ lookup: dns, request: wire([{ status: 302, headers: { location: 'https://127.0.0.1/admin' } }]) });
  await assert.rejects(unsafe('https://public.example'), { code: 'unsafe_address' });
});
test('redirect count, body bytes, response encoding and total network duration are bounded', async () => {
  const { createSafeTransport } = await mod;
  await assert.rejects(createSafeTransport({ lookup: dns, maxRedirects: 1, request: wire([{ status: 302, headers: { location: '/a' } }, { status: 302, headers: { location: '/b' } }]) })('https://public.example'), { code: 'too_many_redirects' });
  await assert.rejects(createSafeTransport({ lookup: dns, maxBytes: 5, request: wire([{ chunks: ['123','456'] }]) })('https://public.example'), { code: 'response_too_large' });
  await assert.rejects(createSafeTransport({ lookup: dns, request: wire([{ headers: { 'content-encoding': 'gzip' }, body: 'compressed' }]) })('https://public.example'), { code: 'unsupported_encoding' });
  await assert.rejects(createSafeTransport({ lookup: dns, timeoutMs: 20, request: wire([{ hang: true }]) })('https://public.example'), { code: 'network_timeout' });
  let lateRequests = 0;
  await assert.rejects(createSafeTransport({ lookup: async () => { await new Promise(resolve => setTimeout(resolve, 35)); return dns(); }, timeoutMs: 10, request: () => { lateRequests++; } })('https://public.example'), { code: 'network_timeout' });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(lateRequests, 0);
});
test('read-only network rejects mutations and returns sanitized errors', async () => {
  const { createSafeTransport } = await mod;
  const transport = createSafeTransport({ lookup: async () => { throw new Error('secret password / internal hostname'); }, request: () => assert.fail('unexpected socket') });
  await assert.rejects(transport('https://public.example', { method: 'POST' }), { code: 'read_only' });
  await assert.rejects(transport('https://public.example'), error => error.code === 'dns_failed' && !error.message.includes('secret'));
});

test('same-origin rebinding is blocked on the next redirect and public IPv6 remains supported', async () => {
  const { createSafeTransport } = await mod;
  let round = 0; const calls = [];
  const rebound = createSafeTransport({ lookup: async () => [{address: round++ ? '10.0.0.1' : '93.184.216.34',family:4}], request: wire([{status:302,headers:{location:'/second'}}],calls) });
  await assert.rejects(rebound('https://public.example/first'), {code:'unsafe_address'});
  assert.equal(calls.length,1);
  const v6Calls = [];
  const v6 = createSafeTransport({ lookup: async () => [{address:'2606:4700:4700::1111',family:6}], request: wire([{body:'ok',rawHeaders:['X-Robots-Tag','otherbot: noindex','X-Robots-Tag','noindex']}],v6Calls) });
  const result = await v6('https://public.example/');
  assert.deepEqual(result.headers['x-robots-tag'],['otherbot: noindex','noindex']);
  const resolved = await new Promise((resolve,reject) => v6Calls[0].options.lookup('public.example',{all:true},(error,addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(resolved,[{address:'2606:4700:4700::1111',family:6}]);
});

test('explicit write transport sends bounded JSON once and never follows POST redirects', async () => {
  const { createSafeTransport } = await mod; const calls=[];
  const transport = createSafeTransport({allowWrites:true,lookup:dns,request:wire([{body:'{"state":"completed"}'}],calls)});
  const response=await transport('https://public.example/wp-json/pageposter/v1/operations',{method:'POST',headers:{authorization:'Basic secret','content-type':'application/json'},body:'{"operationId":"keep"}'});
  assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].body,'{"operationId":"keep"}');
  for(const location of ['/same-origin','https://other.example/path']){
    const moved=[];
    await assert.rejects(createSafeTransport({allowWrites:true,lookup:dns,request:wire([{status:307,headers:{location}}],moved)})('https://public.example/write',{method:'POST',body:'{}'}),{code:'write_redirect_blocked'});
    assert.equal(moved.length,1);
  }
  let opened=0;
  await assert.rejects(createSafeTransport({allowWrites:true,maxRequestBytes:5,lookup:dns,request:()=>opened++})('https://public.example/write',{method:'POST',body:'123456'}),{code:'request_too_large'});
  assert.equal(opened,0);
  await assert.rejects(transport('https://public.example/write',{method:'DELETE',body:'{}'}),{code:'read_only'});
});

test('binary public assets keep their exact bytes without changing the text API',async()=>{
 const {createSafeTransport}=await mod;const bytes=Buffer.from([0x89,0x50,0x4e,0x47,0xff,0x00]);const response=await createSafeTransport({lookup:dns,request:wire([{body:bytes}])})('https://public.example/logo.png');assert.deepEqual(response.body,bytes);assert.equal(typeof response.text,'string');
});
test('same-origin-only public rendering rejects a foreign redirect before its DNS or request',async()=>{
 const {createSafeTransport}=await mod;const calls=[],hosts=[];
 const transport=createSafeTransport({lookup:async host=>{hosts.push(host);return dns();},request:wire([{status:302,headers:{location:'https://partner.example/landing'}},{body:'should never fetch'}],calls)});
 await assert.rejects(transport('https://public.example/page',{sameOriginOnly:true}),{code:'cross_origin_redirect'});assert.equal(calls.length,1);assert.deepEqual(hosts,['public.example']);
});

test('caller cancellation stops a public request before any late socket is opened',async()=>{
 const {createSafeTransport}=await mod;const controller=new AbortController();let calls=0;
 const transport=createSafeTransport({lookup:async()=>{await new Promise(resolve=>setTimeout(resolve,40));return dns();},request:()=>{calls++;}});
 const pending=transport('https://public.example/page',{signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'network_timeout'});await new Promise(resolve=>setTimeout(resolve,60));assert.equal(calls,0);
});

test('transport proves a request never started only before its first request constructor',async()=>{
 const {createSafeTransport,NetworkError}=await mod;let requests=0;
 for(const lookup of [async()=>{throw Error('DNS unavailable');},async()=>[{address:'127.0.0.1',family:4}]]){
  await assert.rejects(createSafeTransport({lookup,request:()=>{requests++;}})('https://public.example/'),error=>error.requestNotStarted===true);
 }
 assert.equal(requests,0);
 const reused=Object.assign(new NetworkError('dns_failed'),{requestNotStarted:true});
 await assert.rejects(createSafeTransport({lookup:dns,request:()=>{requests++;throw reused;}})('https://public.example/'),error=>error.requestNotStarted!==true);assert.equal(requests,1);
 let hops=0;const calls=[];
 await assert.rejects(createSafeTransport({lookup:async()=>{if(hops++)throw reused;return dns();},request:wire([{status:302,headers:{location:'/next'}}],calls)})('https://public.example/'),error=>error.code==='dns_failed'&&error.requestNotStarted!==true);assert.equal(calls.length,1);
});
